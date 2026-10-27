import AppKit
import ScreenCaptureKit
import Foundation

/// One-shot stop signal. Before the recording is running, a stop (a signal during startup) exits
/// at once with a "stopped" event and no frames; afterwards it wakes `wait()`.
private final class Stopper: @unchecked Sendable {  // unchecked: guarded by `lock`
    private var reason: String?
    private var cont: CheckedContinuation<String, Never>?
    private var running = false
    private let lock = NSLock()

    func fire(_ r: String) {
        lock.lock(); defer { lock.unlock() }
        guard reason == nil else { return }
        if !running {  // held under the lock, so markRunning() cannot slip in between
            emit(["event": "stopped", "reason": r, "frames": 0])
            exit(RecordExit.noFrames)
        }
        reason = r
        cont?.resume(returning: r); cont = nil
    }

    func markRunning() { lock.lock(); running = true; lock.unlock() }

    func wait() async -> String {
        await withCheckedContinuation { c in
            lock.lock(); defer { lock.unlock() }
            if let r = reason { c.resume(returning: r) } else { cont = c }
        }
    }
}

nonisolated(unsafe) private var signalSources: [DispatchSourceSignal] = []

/// Owns the stream and the followed-window state. Being an actor, its methods never run at the same
/// time; `busy` additionally keeps a window check and a restart from interleaving across their awaits.
private actor Session {
    let spec: CaptureSpec
    let recorder: Recorder
    let stopper: Stopper
    let follow: Bool
    let ignorePids: Set<Int32>
    let ignoreApps: Set<String>
    let marks: String?
    let t0: Double

    private var stream: CaptureStream
    private var state: FollowState
    private var current: CGWindowID? { state.current }
    private var ownerPid: pid_t?  // owner of the current window, to stop when that app quits
    private var centredFor: CGSize?  // content size the output rect was last centred for
    private var stopping = false
    private var warnedStuck = false
    private var busy = false

    init(spec: CaptureSpec, recorder: Recorder, stopper: Stopper, follow: Bool,
         ignorePids: Set<Int32>, ignoreApps: Set<String>, marks: String?, t0: Double, content: SCShareableContent) {
        self.spec = spec; self.recorder = recorder; self.stopper = stopper; self.follow = follow
        self.ignorePids = ignorePids; self.ignoreApps = ignoreApps; self.marks = marks; self.t0 = t0
        stream = CaptureStream(filter: Handoff(makeFilter(spec, content)), configuration: Handoff(centred(makeConfig(spec), for: spec, content)), delegate: recorder)
        state = FollowState(follow: follow, current: spec.windowID, known: Set(content.windows.map { $0.windowID }))
        ownerPid = spec.windowID.flatMap { wid in content.windows.first { $0.windowID == wid }?.owningApplication?.processID }
        centredFor = spec.windowID.flatMap { wid in content.windows.first { $0.windowID == wid }?.frame.size }
    }

    private static func startStream(_ s: CaptureStream, _ r: Recorder) async throws {
        try s.addOutput(r, queue: r.queue)
        try await s.start()
    }

    func start() async throws { try await Self.startStream(stream, recorder) }

    private func acquire() async -> Bool {
        while busy {
            if stopping { return false }
            do { try await Task.sleep(nanoseconds: 20_000_000) } catch { return false }
        }
        busy = true
        return true
    }

    /// A "normal" window worth following: at least 100x100, owned by a regular (Dock-icon) app, so
    /// system UI such as Dock or Control Center overlays is never followed, and not ignored.
    private func eligible(_ w: SCWindow) -> Bool {
        guard w.frame.width >= 100, w.frame.height >= 100, let app = w.owningApplication else { return false }
        guard !ignorePids.contains(app.processID), !ignoreApps.contains(app.applicationName.lowercased()) else { return false }
        return NSRunningApplication(processIdentifier: app.processID)?.activationPolicy == .regular
    }

    private func snaps(_ content: SCShareableContent) -> [WindowSnap] {
        content.windows.map { WindowSnap(id: $0.windowID, onScreen: $0.isOnScreen, eligible: $0.windowLayer == 0 && eligible($0)) }
    }

    private func ownerGone() -> Bool {
        guard let pid = ownerPid else { return false }
        return kill(pid, 0) != 0 && errno == ESRCH
    }

    private func announceSwitch(_ w: SCWindow) {
        let app = w.owningApplication?.applicationName ?? "", title = w.title ?? ""
        appendMark(marks, t: Date().timeIntervalSince1970 - t0, text: "switched to \(app): \(title)")
        emit(["event": "switched", "windowId": Int(w.windowID), "app": app, "title": title])
    }

    private func switchTo(_ w: SCWindow) async {
        do { try await stream.setFilter(Handoff(SCContentFilter(desktopIndependentWindow: w))) }
        catch { emit(["event": "warning", "message": "switch failed: \(error.localizedDescription)"]); return }  // retried next check
        // The filter switched, so the switch is done; a failed re-centre only leaves the old padding.
        do { try await stream.setConfig(Handoff(centred(makeConfig(spec), contentSize: w.frame.size))); centredFor = w.frame.size }
        catch { emit(["event": "warning", "message": "re-centring after switch failed: \(error.localizedDescription)"]) }
        guard !stopping else { return }
        state.switched(to: w.windowID)
        ownerPid = w.owningApplication?.processID
        announceSwitch(w)
    }

    /// One window check, applying the FollowState rules (hold when hidden, follow, or stop).
    func tick() async {
        guard !stopping, await acquire() else { return }
        defer { busy = false }
        if StuckQueries.shared.any {
            if !warnedStuck { warnedStuck = true; emit(["event": "warning", "message": "window checks paused: an earlier ScreenCaptureKit query has not answered"]) }
            return
        }
        warnedStuck = false
        let now: SCShareableContent
        do { now = try await queryContent(timeout: 3) }
        catch { emit(["event": "warning", "message": "window check skipped: \(error.localizedDescription)"]); return }
        guard !stopping else { return }
        for action in state.step(snaps(now), ownerGone: ownerGone()) {
            switch action {
            case .switchTo(let id):
                if let w = now.windows.first(where: { $0.windowID == id }) { await switchTo(w) }
            case .stop(let reason):
                stopper.fire(reason)
            case .warnHidden:
                emit(["event": "warning", "message": "window is hidden, minimized or closed; holding the last frame"])
            case .warnVisible:
                emit(["event": "warning", "message": "window is visible again"])
            }
        }
        // A resized window keeps its aspect ratio: re-centre the output rect.
        if let cur = current, let w = now.windows.first(where: { $0.windowID == cur }), w.frame.size != centredFor, !stopping {
            do { try await stream.setConfig(Handoff(centred(makeConfig(spec), contentSize: w.frame.size))); centredFor = w.frame.size }
            catch { emit(["event": "warning", "message": "re-centring failed: \(error.localizedDescription)"]) }
        }
    }

    /// Restarts a stream that died, on the followed window (not the original one). Never exits:
    /// every failure becomes a clean stop, so the file is still finalised.
    func restart(after error: Error) async {
        guard !stopping, await acquire() else { return }
        defer { busy = false }
        emit(["event": "warning", "message": "stream stopped: \(error.localizedDescription); restarting"])
        let fresh: SCShareableContent
        do { fresh = try await queryContent(timeout: startTimeout()) } catch { stopper.fire("stream-error"); return }
        guard !stopping, !recorder.isFinishing else { return }
        var switchedTo: SCWindow?
        let filter: SCContentFilter
        var target = current
        if let cur = current, !fresh.windows.contains(where: { $0.windowID == cur }) {
            guard follow, let id = state.survivor(snaps(fresh)), let back = fresh.windows.first(where: { $0.windowID == id }) else {
                stopper.fire("target-closed"); return
            }
            switchedTo = back
            target = back.windowID
            filter = SCContentFilter(desktopIndependentWindow: back)
        } else {
            do { filter = try tryFilter(windowID: current, displayID: spec.displayID, fresh) }
            catch TargetError.noDisplays {
                let st = screenState()  // a lock or display sleep ends the stream too: name it, not a closed target
                stopper.fire(st == .awake ? "target-closed" : "screen-\(st.rawValue)"); return
            } catch { stopper.fire("target-closed"); return }
        }
        let size = target.flatMap { t in fresh.windows.first { $0.windowID == t }?.frame.size }
        let cfg = size.map { centred(makeConfig(spec), contentSize: $0) } ?? centred(makeConfig(spec), for: spec, fresh)
        let s = CaptureStream(filter: Handoff(filter), configuration: Handoff(cfg), delegate: recorder)
        do { try await Self.startStream(s, recorder) } catch { stopper.fire("stream-error"); return }
        if stopping || recorder.isFinishing { await s.stop(); return }
        stream = s
        if let w = switchedTo { state.switched(to: w.windowID); ownerPid = w.owningApplication?.processID; announceSwitch(w) }
    }

    /// Stops capture for good; a restart that finishes later sees `stopping` and stops its own stream.
    func stop() async {
        stopping = true
        await stream.stop()
    }
}

/// Samples the screen state once a second while recording. It remembers the worst state seen (by
/// ScreenState.rank; nil while always awake) and reports each change to `onChange` with the previous
/// state, so a lock in the middle of a recording shows up in status and in the step notes.
/// Polling rather than the com.apple.screenIsLocked notifications: one screenState() call covers lock,
/// display sleep and fast user switching alike, and needs no run loop of its own.
private final class ScreenWatch: @unchecked Sendable {  // unchecked: `seen` and `last` are guarded by `lock`
    private let lock = NSLock()
    private var seen: ScreenState?
    private var last = ScreenState.awake
    private let onChange: @Sendable (_ from: ScreenState, _ to: ScreenState) -> Void
    private let timer = DispatchSource.makeTimerSource(queue: .global())

    init(onChange: @escaping @Sendable (_ from: ScreenState, _ to: ScreenState) -> Void) {
        self.onChange = onChange
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in _ = self?.check() }
        timer.resume()
    }

    @discardableResult
    func check() -> ScreenState {
        let s = screenState()
        lock.lock(); defer { lock.unlock() }  // held through onChange, so two changes are reported in order
        if s.rank > (seen?.rank ?? 0) { seen = s }
        if s != last { onChange(last, s); last = s }
        return s
    }

    var worst: ScreenState? { lock.lock(); defer { lock.unlock() }; return seen }
    func stop() { timer.cancel(); check() }
}

func record(_ a: Args) async {
    guard let outPath = a.str("out") else { fail("E_BAD_ARGS", "--out is required") }
    let spec = makeSpec(a)
    for k in ["max-seconds", "t0-ms"] where a.str(k) != nil {
        guard let v = a.double(k), v.isFinite, v > 0 else { fail("E_BAD_ARGS", "--\(k) must be a number above 0, got \(a.str(k)!)") }
    }
    let outURL = URL(fileURLWithPath: outPath)
    let folder = outURL.deletingLastPathComponent().path
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: folder, isDirectory: &isDir), isDir.boolValue,
          FileManager.default.isWritableFile(atPath: folder) else {
        fail("E_HELPER_CRASHED", "cannot write \(outPath): the folder \(folder) does not exist or is not writable",
             fix: outputFolderFix, exitCode: RecordExit.writerFailed)
    }
    let follow = a.bool("follow-app") && spec.windowID != nil
    let ignorePids = Set(a.all("ignore-pid").compactMap { Int32($0) })
    let ignoreApps = Set(a.all("ignore-app").map { $0.lowercased() })
    let t0 = (a.double("t0-ms") ?? Date().timeIntervalSince1970 * 1000) / 1000
    let marks = a.str("marks")

    // Signals are handled from the start: one that arrives during startup exits with a "stopped" event.
    let stopper = Stopper()
    signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
    for sig in [SIGINT, SIGTERM] {
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler { stopper.fire("signal") }
        src.resume(); signalSources.append(src)
    }

    let dog = startWatchdog()  // disarmed when "started" is emitted
    let content = await shareableForCapture(spec)
    let recorder: Recorder
    do { recorder = try Recorder(url: outURL, width: spec.width, height: spec.height) }
    catch { fail("E_HELPER_CRASHED", "cannot write \(outPath): \(error.localizedDescription)", fix: outputFolderFix, exitCode: RecordExit.writerFailed) }

    let session = Session(spec: spec, recorder: recorder, stopper: stopper, follow: follow,
                          ignorePids: ignorePids, ignoreApps: ignoreApps, marks: marks, t0: t0, content: content)
    recorder.onStreamError = { error in Task { await session.restart(after: error) } }
    recorder.onWriterFailed = { stopper.fire("stream-error") }
    // Running from here on: once capture starts, a stop must finalise whatever frames were written.
    stopper.markRunning()
    do { try await session.start() } catch { failStart(error) }
    dog.disarm()
    // A locked or sleeping screen still starts a stream, but it delivers nothing: say so before "started".
    let screen = ScreenWatch { from, to in
        // On the recording clock like every other mark. The "screen" event (with the same t) is what status
        // and stop read, so an agent's own note that happens to say "screen locked" never counts as a lock.
        let t = ((Date().timeIntervalSince1970 - t0) * 1000).rounded() / 1000
        if let text = screenMark(from: from, to: to) { appendMark(marks, t: t, text: text) }
        emit(["event": "screen", "state": to.rawValue, "t": t])
    }
    if let why = screenWarning(screen.check()) { emit(["event": "warning", "message": why]) }
    recorder.announceStarted(width: spec.width, height: spec.height)

    if let max = a.double("max-seconds") { DispatchQueue.global().asyncAfter(deadline: .now() + max) { stopper.fire("max") } }
    Thread.detachNewThread { while let line = readLine() { if line.trimmingCharacters(in: .whitespaces) == "stop" { stopper.fire("stdin"); return } } }

    // Screenshots and window listings for the rest of screenrec, answered here (see Requests.swift).
    let server = a.str("requests").map { serveRequests(in: $0) }

    let watcher = Task {
        guard spec.windowID != nil else { return }
        while !Task.isCancelled {
            do { try await Task.sleep(nanoseconds: 500_000_000) } catch { return }
            await session.tick()
        }
    }

    let reason = await stopper.wait()
    watcher.cancel()
    server?.cancel()
    screen.stop()
    await session.stop()
    let result = await recorder.finish()
    var stopped: [String: Any] = ["event": "stopped", "reason": reason, "frames": result.frames]
    // Why nothing was captured: the screen was locked or asleep at some point (Node turns it into the E_NO_FRAMES text).
    if result.frames == 0, let worst = screen.worst { stopped["screen"] = worst.rawValue }
    emit(stopped)
    if result.writerError != nil { exit(RecordExit.writerFailed) }
    exit(result.frames > 0 ? 0 : RecordExit.noFrames)
}

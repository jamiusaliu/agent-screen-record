import AppKit
import ScreenCaptureKit

func displayName(_ id: CGDirectDisplayID) -> String {
    for s in NSScreen.screens {
        if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber, n.uint32Value == id {
            return s.localizedName
        }
    }
    return "Display \(id)"
}

func listDisplays() -> [[String: Any]] {
    // The online list (not the active list) so sleeping displays are still listed;
    // the active list is empty while the displays sleep or the session is locked.
    var count: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetOnlineDisplayList(count, &ids, &count)
    ids = Array(ids.prefix(Int(count))).filter { CGDisplayMirrorsDisplay($0) == kCGNullDirectDisplay }
    return ids.map { id in
        let b = CGDisplayBounds(id)
        var scale = 1.0
        if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 { scale = Double(mode.pixelWidth) / Double(mode.width) }
        return ["id": Int(id), "name": displayName(id), "x": Double(b.origin.x), "y": Double(b.origin.y),
                "width": Double(b.width), "height": Double(b.height), "scale": scale, "main": CGDisplayIsMain(id) != 0]
    }
}

/// Front-to-back order of on-screen layer-0 windows; 0 is frontmost.
func zOrder() -> [CGWindowID: Int] {
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [:] }
    var z: [CGWindowID: Int] = [:]
    var i = 0
    for w in info where (w[kCGWindowLayer as String] as? Int) == 0 {
        if let n = w[kCGWindowNumber as String] as? Int { z[CGWindowID(n)] = i; i += 1 }
    }
    return z
}

/// Concurrent SCShareableContent queries from several processes hang on macOS 26: one answers and the
/// others never return (reproduced with three probes). A per-user file lock serialises the queries.
func lockPath() -> String {
    ProcessInfo.processInfo.environment["SCREENREC_MAC_LOCK"]
        ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("screenrec-mac.sck.lock")
}

struct QueryTimeout: LocalizedError {
    let seconds: Double
    var errorDescription: String? { "ScreenCaptureKit did not answer within \(Int(seconds)) s" }
}

/// The cross-process query lock. `release()` is idempotent, so a timed-out query can give it back early.
private final class QueryLock: @unchecked Sendable {  // unchecked: `fd` and `released` are guarded by `lock`
    private let lock = NSLock()
    private var fd: Int32
    private var released = false

    init(path: String) {
        fd = open(path, O_CREAT | O_RDWR, 0o600)
        if fd < 0 {
            let why = String(cString: strerror(errno))
            FileHandle.standardError.write(Data("screenrec-mac: warning: cannot open lock file \(path) (\(why)); querying ScreenCaptureKit without it\n".utf8))
        }
    }

    /// True once held, or straight away when the lock file could not be opened.
    func tryAcquire() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if released { return false }
        return fd < 0 || flock(fd, LOCK_EX | LOCK_NB) == 0
    }

    func release() {
        lock.lock(); defer { lock.unlock() }
        released = true
        if fd >= 0 { flock(fd, LOCK_UN); close(fd); fd = -1 }
    }
}

/// An SCShareableContent snapshot is immutable once delivered, so sharing it across tasks is safe;
/// the box carries it past the Sendable checker.
struct ContentBox: @unchecked Sendable { let content: SCShareableContent }

/// Counts queries that timed out but have not answered yet. While one is stuck, the watcher does not
/// pile more queries on top (they would queue behind it in ScreenCaptureKit).
final class StuckQueries: @unchecked Sendable {  // unchecked: `count` is guarded by `lock`
    static let shared = StuckQueries()
    private let lock = NSLock()
    private var count = 0
    func add() { lock.lock(); count += 1; lock.unlock() }
    func remove() { lock.lock(); count -= 1; lock.unlock() }
    var any: Bool { lock.lock(); defer { lock.unlock() }; return count > 0 }
}

/// Lists shareable content under the query lock. With `timeout`, gives up after that many seconds:
/// it throws QueryTimeout, gives the lock back and leaves the stuck query behind (see StuckQueries).
func queryContent(timeout: Double? = nil) async throws -> SCShareableContent {
    let qlock = QueryLock(path: lockPath())
    let work = Task { () throws -> ContentBox in
        defer { qlock.release() }
        // Task.sleep throws once the task is cancelled, so a timed-out wait ends instead of spinning.
        while !qlock.tryAcquire() { try await Task.sleep(nanoseconds: 50_000_000) }
        try Task.checkCancellation()
        return ContentBox(content: try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false))
    }
    guard let timeout else { return try await work.value.content }
    let box: ContentBox = try await withCheckedThrowingContinuation { (c: CheckedContinuation<ContentBox, Error>) in
        let once = Once()
        Task {
            let r = await work.result
            if !once.run({ c.resume(with: r) }) { StuckQueries.shared.remove() }  // a late answer to a timed-out query
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            if once.run({ work.cancel(); qlock.release(); c.resume(throwing: QueryTimeout(seconds: timeout)) }) { StuckQueries.shared.add() }
        }
    }
    return box.content
}

/// Exits for a content query that failed: E_PERMISSION for a refused grant, otherwise the real cause
/// (domain and code), plus the screen state when the screen is locked or asleep.
func failQuery(_ error: Error) -> Never {
    if isPermissionError(error) { fail("E_PERMISSION", "Screen Recording permission is not granted: \(error.localizedDescription)") }
    let note = screenWarning(screenState()).map { "; \($0)" } ?? ""
    fail("E_HELPER_CRASHED", "ScreenCaptureKit could not list content: \(describe(error))\(note)")
}

func shareable() async -> SCShareableContent {
    do { return try await queryContent() } catch { failQuery(error) }
}

/// The content for a capture. A failed query, or a display capture that got no displays, is retried
/// (contentQueryTries times, contentQueryDelay apart) while the screen is awake and unlocked: those are
/// the transient cases. The start watchdog still bounds the whole wait.
func shareableForCapture(_ spec: CaptureSpec) async -> SCShareableContent {
    let r: Result<ContentBox, Error> = await retrying(tries: contentQueryTries, delay: contentQueryDelay, again: { r in
        switch r {
        case .failure(let e):
            return shouldRetryQuery(failed: true, permission: isPermissionError(e), displaysEmpty: false, wantsDisplay: false, state: screenState())
        case .success(let box):
            guard spec.displayID != nil, box.content.displays.isEmpty else { return false }
            return shouldRetryQuery(failed: false, permission: false, displaysEmpty: true, wantsDisplay: true, state: screenState())
        }
    }) {
        do { return .success(ContentBox(content: try await queryContent())) } catch { return .failure(error) }
    }
    switch r {
    case .success(let box): return box.content
    case .failure(let e): failQuery(e)
    }
}

func normalWindows(_ content: SCShareableContent) -> [SCWindow] {
    content.windows.filter { $0.windowLayer == 0 && $0.frame.width >= 50 && $0.frame.height >= 50 }
}

func windowDicts(_ content: SCShareableContent) -> [[String: Any]] {
    let z = zOrder()
    return normalWindows(content).map { w in
        ["id": Int(w.windowID), "app": w.owningApplication?.applicationName ?? "", "title": w.title ?? "",
         "x": Double(w.frame.origin.x), "y": Double(w.frame.origin.y), "width": Double(w.frame.width), "height": Double(w.frame.height),
         "onScreen": w.isOnScreen, "z": z[w.windowID] ?? 9999, "pid": Int(w.owningApplication?.processID ?? 0)]
    }
}

import Foundation
import ScreenCaptureKit

/// Commands a running recorder answers for other screenrec processes.
let servedCommands = ["screenshot", "windows"]

/// Seconds a served request may take before it is answered with an error. Below Node's 30 s helper
/// timeout, so the caller always gets the recorder's own answer.
let requestDeadline = 20.0

/// While a recording runs, other screenrec processes send their ScreenCaptureKit commands here instead of
/// starting a helper of their own. A second screenrec-mac process that uses ScreenCaptureKit and then quits
/// stops every live stream started from the same executable with "application connection interrupted"
/// (seen on macOS 26.7, 27 Oct 2026): the recording froze, and a screenshot taken at that moment got no
/// frame at all. Inside the recorder nothing quits.
/// Protocol: the caller writes `<id>.req` (JSON {"args": [command, flags...]}, renamed into place) in `dir`;
/// the answer, the JSON line the command would print, appears as `<id>.res` (also renamed into place). A
/// screenshot is written to `<id>.png` in `dir` as a new file; the request's --out is ignored, so a request
/// can never make the recorder write anywhere else. Only regular files owned by this user are read.
/// Each request runs in its own task with a deadline, so one stuck capture never holds up the next.
func serveRequests(in dir: String, deadline: Double = requestDeadline) -> Task<Void, Never> {
    Task.detached {
        let fm = FileManager.default
        while !Task.isCancelled {
            let names = ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).filter { $0.hasSuffix(".req") }.sorted()
            for name in names where !Task.isCancelled {
                let req = (dir as NSString).appendingPathComponent(name)
                guard isOwnFile(req) else { unlink(req); continue }  // a link or another user's file: never followed
                guard let data = fm.contents(atPath: req) else { continue }
                unlink(req)
                answer(data, id: String(name.dropLast(4)), in: dir, deadline: deadline)
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }
}

/// A regular file (not a link) owned by this user.
func isOwnFile(_ path: String) -> Bool {
    var st = stat()
    return lstat(path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFREG && st.st_uid == getuid()
}

/// Answers one request, or the deadline error if the work takes longer; whichever comes first is written.
/// A screenshot that finishes after the deadline is deleted, so nothing is left behind.
private func answer(_ data: Data, id: String, in dir: String, deadline: Double) {
    let res = (dir as NSString).appendingPathComponent("\(id).res")
    let png = (dir as NSString).appendingPathComponent("\(id).png")
    let once = Once()
    let timer = Task.detached {
        try? await Task.sleep(nanoseconds: UInt64(deadline * 1_000_000_000))
        guard !Task.isCancelled else { return }
        once.run { writeAnswer(requestTimeoutFailure(screenState(), seconds: deadline).json, to: res) }
    }
    Task.detached {
        let result = await answerRequest(data, png: png)
        if once.run({ writeAnswer(result, to: res) }) { timer.cancel() } else { unlink(png) }
    }
}

/// The answer to a request that missed its deadline: the screen state when it explains it, else a stall.
func requestTimeoutFailure(_ state: ScreenState, seconds: Double) -> HelperFailure {
    if let why = screenWarning(state) {
        return HelperFailure("E_TARGET_NOT_FOUND", "the running recorder could not finish the request within \(Int(seconds)) s: \(why)",
                             fix: noDisplaysFailure(state, tries: 1).fix)
    }
    return HelperFailure("E_HELPER_CRASHED", "the running recorder could not finish the request within \(Int(seconds)) s (ScreenCaptureKit did not answer)",
                         fix: "Try again. If it keeps happening, stop the recording, run \"screenrec doctor\" and retry with SCREENREC_DEBUG=1.")
}

/// The result line for one request. Never exits: a failure becomes an error line, as the command would print.
/// A screenshot goes to `png` (a new file), never to the request's --out.
func answerRequest(_ data: Data, png: String) async -> [String: Any] {
    guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let argv = obj["args"] as? [String],
          let cmd = argv.first, servedCommands.contains(cmd) else {
        return HelperFailure("E_BAD_ARGS", "a recorder request must be one of: \(servedCommands.joined(separator: ", "))").json
    }
    do {
        if cmd == "windows" {
            let content: SCShareableContent
            do { content = try await queryContent(timeout: startTimeout(), stuck: .served) } catch { throw queryFailure(error) }
            return ["ok": true, "windows": windowDicts(content)]
        }
        return try await takeScreenshot(Args(argv), served: ServedShot(out: png))
    } catch let f as HelperFailure { return f.json }
    catch { return HelperFailure("E_HELPER_CRASHED", describe(error)).json }
}

/// Writes the answer next to its final name, then renames it, so the caller never reads half a line.
private func writeAnswer(_ answer: [String: Any], to path: String) {
    guard let data = try? JSONSerialization.data(withJSONObject: answer, options: [.sortedKeys]) else { return }
    let tmp = path + ".tmp"
    guard FileManager.default.createFile(atPath: tmp, contents: data + Data([0x0A])) else { return }
    _ = rename(tmp, path)
}

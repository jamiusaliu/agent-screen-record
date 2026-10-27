import Foundation

private let emitLock = NSLock()

/// Writes one JSON line. The line and its newline go out in a single write under a lock,
/// so lines from different threads never interleave.
func emit(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    data.append(0x0A)
    emitLock.lock(); defer { emitLock.unlock() }
    FileHandle.standardOutput.write(data)
}

func fail(_ code: String, _ message: String, fix: String? = nil, exitCode: Int32 = 1) -> Never {
    var obj: [String: Any] = ["ok": false, "code": code, "message": message]
    if let fix { obj["fix"] = fix }
    emit(obj)
    exit(exitCode)
}

/// A failure as a value, for code that must not exit: requests served inside a running recorder.
struct HelperFailure: Error {
    let code: String, message: String, fix: String?
    init(_ code: String, _ message: String, fix: String? = nil) { self.code = code; self.message = message; self.fix = fix }
    var json: [String: Any] {
        var obj: [String: Any] = ["ok": false, "code": code, "message": message]
        if let fix { obj["fix"] = fix }
        return obj
    }
}

/// Exits with a HelperFailure's code, message and fix; any other error is reported as a crash.
func fail(_ error: Error) -> Never {
    if let f = error as? HelperFailure { fail(f.code, f.message, fix: f.fix) }
    fail("E_HELPER_CRASHED", describe(error))
}

/// Exit codes of `record`, mirrored by HELPER_EXIT in src/capture/mac.ts.
enum RecordExit {
    static let noFrames: Int32 = 5       // stopped before any frame was written (E_NO_FRAMES)
    static let writerFailed: Int32 = 6   // the video file could not be written (matches the CDP worker's ENCODER_FAILED_EXIT)
}

let outputFolderFix = "Check that the output folder exists and is writable and that the disk is not full, then try again."

/// Calls `body` exactly once, whichever caller gets there first.
final class Once: @unchecked Sendable {  // unchecked: `done` is guarded by `lock`
    private let lock = NSLock()
    private var done = false
    @discardableResult
    func run(_ body: () -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !done else { return false }
        done = true
        body()
        return true
    }
}

/// Fails the process unless disarmed in time. Guards against ScreenCaptureKit calls that never answer.
final class Watchdog: @unchecked Sendable {  // unchecked: `armed` is guarded by `lock`
    private let lock = NSLock()
    private var armed = true

    init(seconds: Double, message: String) {
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { [self] in
            lock.lock()  // held through fail(), so a late disarm() can never race the error line
            if armed { fail("E_HELPER_CRASHED", message) }
            lock.unlock()
        }
    }

    func disarm() { lock.lock(); armed = false; lock.unlock() }
}

/// Seconds a command may take to reach ScreenCaptureKit and start (SCREENREC_MAC_START_TIMEOUT overrides, for tests).
func startTimeout() -> Double {
    ProcessInfo.processInfo.environment["SCREENREC_MAC_START_TIMEOUT"].flatMap { Double($0) } ?? 10
}

func startWatchdog() -> Watchdog {
    let s = startTimeout()
    return Watchdog(seconds: s, message: "ScreenCaptureKit did not answer within \(Int(s)) s (another capture may be starting at the same time)")
}

struct Args {
    let command: String
    private var values: [String: [String]] = [:]

    init(_ argv: [String]) {
        command = argv.first ?? ""
        var i = 1
        while i < argv.count {
            let a = argv[i]
            guard a.hasPrefix("--") else { i += 1; continue }
            let key = String(a.dropFirst(2))
            if i + 1 < argv.count, !argv[i + 1].hasPrefix("--") {
                values[key, default: []].append(argv[i + 1]); i += 2
            } else {
                values[key, default: []].append("true"); i += 1
            }
        }
    }

    func str(_ k: String) -> String? { values[k]?.last }
    func all(_ k: String) -> [String] { values[k] ?? [] }
    func bool(_ k: String) -> Bool { values[k] != nil }
    func int(_ k: String) -> Int? { str(k).flatMap { Int($0) } }
    func double(_ k: String) -> Double? { str(k).flatMap { Double($0) } }
    /// Comma-separated finite numbers; nil when the flag is absent, [] when any part is not a finite number.
    func nums(_ k: String) -> [Double]? {
        guard let s = str(k) else { return nil }
        var out: [Double] = []
        for part in s.split(separator: ",", omittingEmptySubsequences: false) {
            guard let v = Double(part.trimmingCharacters(in: .whitespaces)), v.isFinite else { return [] }
            out.append(v)
        }
        return out
    }
}

/// One marks line, `t` printed with exactly 3 decimals (JSONSerialization would print 5.4729999999999999).
func markJSON(t: Double, text: String) -> String {
    let quoted = (try? JSONSerialization.data(withJSONObject: [text], options: [.withoutEscapingSlashes]))
        .flatMap { String(data: $0, encoding: .utf8) }.map { String($0.dropFirst().dropLast()) } ?? "\"\""
    return "{\"t\":\(String(format: "%.3f", t)),\"text\":\(quoted)}"
}

/// Appends one marks line. O_APPEND, like Node's appendFileSync, so a mark written by the helper and a
/// step note written by `screenrec mark` at the same moment both land, neither over the other.
func appendMark(_ file: String?, t: Double, text: String) {
    guard let file else { return }
    let fd = open(file, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    guard fd >= 0 else { return }
    defer { close(fd) }
    let line = Array((markJSON(t: t, text: text) + "\n").utf8)
    _ = line.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
}

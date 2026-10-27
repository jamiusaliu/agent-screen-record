import CoreGraphics
import ScreenCaptureKit

/// Whether the window server is drawing anything that can be captured. While the screen is locked or
/// every display sleeps, ScreenCaptureKit lists no displays and window streams deliver no frames.
enum ScreenState: String {
    case awake, locked, asleep
    case offConsole = "off-console"  // fast user switching: another session owns the screen

    /// How strongly the state explains a recording with nothing in it (awake explains nothing).
    var rank: Int { switch self { case .awake: return 0; case .asleep: return 1; case .locked: return 2; case .offConsole: return 3 } }
}

/// Off console wins (this session is not on screen at all), then locked over asleep: idle display
/// sleep usually locks the screen too (loginwindow's "lock from display dim"), and unlocking is what
/// the user has to do.
func classifyScreen(onConsole: Bool = true, locked: Bool, displaysAsleep: [Bool]) -> ScreenState {
    if !onConsole { return .offConsole }
    if locked { return .locked }
    if !displaysAsleep.isEmpty && displaysAsleep.allSatisfy({ $0 }) { return .asleep }
    return .awake
}

/// The live state, from the login session (lock) and the online displays (sleep).
func screenState() -> ScreenState {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let locked = (session?["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false  // absent when unlocked
    let onConsole = (session?[kCGSessionOnConsoleKey as String] as? NSNumber)?.boolValue ?? true  // no session info: assume on console
    var count: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetOnlineDisplayList(count, &ids, &count)
    return classifyScreen(onConsole: onConsole, locked: locked, displaysAsleep: ids.prefix(Int(count)).map { CGDisplayIsAsleep($0) != 0 })
}

/// How many times a capture command asks ScreenCaptureKit for its content, and the pause between asks.
let contentQueryTries = 3
let contentQueryDelay = 0.5

let keepAwakeHint = "For unattended runs, keep the displays awake, for example with \"caffeinate -d\" running alongside."

/// Code, message and fix for a content query that listed no displays, by the screen state seen at the
/// time. With the screen awake, a missing Screen Recording grant (`permitted` false) is the likelier
/// cause; a nil fix leaves the Node side's permission fix in place.
func noDisplaysFailure(_ state: ScreenState, tries: Int, permitted: Bool = true) -> (code: String, message: String, fix: String?) {
    switch state {
    case .offConsole:
        return ("E_TARGET_NOT_FOUND", "No displays are available: another user session is using the screen", "Switch back to this user's session and try again.")
    case .locked:
        return ("E_TARGET_NOT_FOUND", "No displays are available: the screen is locked", "Unlock the Mac and try again. \(keepAwakeHint)")
    case .asleep:
        return ("E_TARGET_NOT_FOUND", "No displays are available: the displays are asleep", "Wake the displays (move the mouse or press a key) and try again. \(keepAwakeHint)")
    case .awake where !permitted:
        return ("E_PERMISSION", "ScreenCaptureKit listed no displays and Screen Recording permission is not granted", nil)
    case .awake:
        return ("E_TARGET_NOT_FOUND", "ScreenCaptureKit listed no displays (\(tries) tries) although macOS reports the screen awake and unlocked",
                "Try again in a few seconds. If it keeps happening, run \"screenrec doctor\" and retry with SCREENREC_DEBUG=1.")
    }
}

/// A warning for a recording that starts (or captured nothing) while the screen is not drawn; nil when awake.
func screenWarning(_ state: ScreenState) -> String? {
    switch state {
    case .awake: return nil
    case .locked: return "the screen is locked: nothing is captured until it is unlocked"
    case .asleep: return "the displays are asleep: nothing is captured until they wake"
    case .offConsole: return "another user session is using the screen: nothing is captured until you switch back"
    }
}

/// Whether another content query is worth it. A refused permission never changes by waiting, and a
/// locked or sleeping screen will not come back within the retry window, so only an awake screen retries:
/// after a failed query, or when a display capture got a list without displays.
func shouldRetryQuery(failed: Bool, permission: Bool, displaysEmpty: Bool, wantsDisplay: Bool, state: ScreenState) -> Bool {
    if permission || state != .awake { return false }
    return failed || (wantsDisplay && displaysEmpty)
}

/// Runs `body` up to `tries` times, `delay` seconds apart, while `again` says its result deserves another try.
func retrying<T>(tries: Int, delay: Double, again: (T) -> Bool, _ body: () async -> T) async -> T {
    var result = await body()
    var n = 1
    while n < tries, again(result) {
        try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
        result = await body()
        n += 1
    }
    return result
}

/// "<description> (<domain> <code>)", so a ScreenCaptureKit failure names its real cause.
func describe(_ error: Error) -> String {
    let e = error as NSError
    return "\(e.localizedDescription) (\(e.domain) \(e.code))"
}

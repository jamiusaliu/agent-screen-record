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

/// The automatic mark for a change of screen state during a recording; nil when nothing changed.
/// Going to a state that is not drawn names that state; coming back to awake names what ended.
/// The marks are for whoever reads the sidecar; status and stop count locks from the "screen" events instead.
func screenMark(from old: ScreenState, to new: ScreenState) -> String? {
    guard old != new else { return nil }
    switch new {
    case .locked: return "screen locked"
    case .asleep: return "displays asleep"
    case .offConsole: return "another user session took the screen"
    case .awake:
        switch old {
        case .locked: return "screen unlocked"
        case .asleep: return "displays awake"
        case .offConsole: return "back on this user session"
        case .awake: return nil
        }
    }
}

/// Code, message and fix for a screenshot whose stream delivered no frame. `onScreen` is the window's
/// on-screen flag from the content query (nil for a display); `streamError` is set when ScreenCaptureKit
/// stopped the stream. Only a window that is really off screen is blamed on minimizing or Spaces.
func noFrameFailure(_ state: ScreenState, onScreen: Bool?, streamError: String?) -> (code: String, message: String, fix: String) {
    if let why = screenWarning(state) { return ("E_NO_FRAMES", "no frame: \(why)", noDisplaysFailure(state, tries: 1).fix ?? keepAwakeHint) }
    let retry = "Try again. If it keeps happening, run \"screenrec doctor\" and retry with SCREENREC_DEBUG=1."
    if let e = streamError { return ("E_NO_FRAMES", "no frame: ScreenCaptureKit stopped the capture: \(e)", retry) }
    if onScreen == false {
        return ("E_NO_FRAMES", "no frame within 3 s: the window is minimized, hidden or on another Space",
                "Un-minimize the window or move it to the current Space, then try again.")
    }
    let what = onScreen == nil ? "the display" : "the window, which macOS lists as on screen,"
    return ("E_NO_FRAMES", "no frame within 3 s from \(what) although the screen is awake and unlocked", retry)
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

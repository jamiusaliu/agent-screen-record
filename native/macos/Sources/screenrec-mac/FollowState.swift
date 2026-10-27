import Foundation
import CoreGraphics

/// One window as seen by a window check. Pure data, so the follow rules can be self-tested
/// without ScreenCaptureKit (`screenrec-mac selftest-follow`).
struct WindowSnap {
    let id: CGWindowID
    let onScreen: Bool
    let eligible: Bool  // layer 0, at least 100x100 and not ignored
}

enum FollowAction: Equatable {
    case switchTo(CGWindowID)
    case stop(String)
    case warnHidden
    case warnVisible
}

/// The v1 window rules (spec 6.1 as ruled on 2026-10-17). Without Accessibility permission a closed
/// window that the app keeps registered looks the same as a minimized one, so:
/// - a recorded window that goes off screen is held (one warning), and a warning is given when it returns;
/// - it ends only when its id leaves the OS window list or its app quits (target-closed);
/// - with follow-app, a window created after start is followed once it is on screen, and when the
///   current window goes off screen or away, the newest on-screen window created after start takes over.
struct FollowState {
    let follow: Bool
    private(set) var current: CGWindowID?
    private var known: Set<CGWindowID>
    /// Windows first listed after start, oldest first, still in the OS list. Eligibility is judged
    /// when deciding, not on first sight: a new tab window can be listed small for a moment.
    private var appeared: [CGWindowID] = []
    /// Windows already followed (or skipped) on their first on-screen sighting.
    private var arrived: Set<CGWindowID> = []
    /// On-screen arrivals from the last step; they count as arrived only once a switch succeeds,
    /// so a failed switch is retried on the next check.
    private var pendingArrivals: [CGWindowID] = []
    private var hidden = false

    init(follow: Bool, current: CGWindowID?, known: Set<CGWindowID>) {
        self.follow = follow; self.current = current; self.known = known
    }

    /// Call after a switch to `id` succeeded.
    mutating func switched(to id: CGWindowID) {
        current = id; hidden = false
        arrived.formUnion(pendingArrivals); arrived.insert(id); pendingArrivals = []
    }

    /// The newest window created after start that is still listed, preferring on-screen ones.
    func survivor(_ snaps: [WindowSnap]) -> CGWindowID? {
        let byId = Dictionary(snaps.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let alive = appeared.reversed().filter { $0 != current && byId[$0]?.eligible == true }
        return alive.first { byId[$0]!.onScreen } ?? alive.first
    }

    /// One window check. `snaps` is every window the OS lists; `ownerGone` is true when the app that
    /// owns the current window has quit.
    mutating func step(_ snaps: [WindowSnap], ownerGone: Bool = false) -> [FollowAction] {
        let byId = Dictionary(snaps.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let newcomers = snaps.filter { !known.contains($0.id) }.map { $0.id }.sorted()
        known.formUnion(byId.keys)
        appeared.append(contentsOf: newcomers)
        appeared.removeAll { byId[$0] == nil }
        guard let cur = current else { return [] }  // display capture: nothing to follow

        if byId[cur] == nil || ownerGone {
            if follow, let s = survivor(snaps) { return [.switchTo(s)] }
            return [.stop("target-closed")]
        }
        let curOn = byId[cur]!.onScreen
        if follow {
            // First on-screen sighting of windows created after start, newest last.
            let arrivals = appeared.filter { !arrived.contains($0) && byId[$0]!.onScreen && byId[$0]!.eligible }
            pendingArrivals = arrivals
            if let a = arrivals.last, a != cur { return [.switchTo(a)] }
            arrived.formUnion(arrivals)  // nothing to switch to (the newest is current): settled
            if !curOn, let s = appeared.reversed().first(where: { $0 != cur && byId[$0]!.onScreen && byId[$0]!.eligible }) { return [.switchTo(s)] }
        }
        if !curOn && !hidden { hidden = true; return [.warnHidden] }
        if curOn && hidden { hidden = false; return [.warnVisible] }
        return []
    }
}

/// Runs the follow rules against fixed scenarios.
func selftestFollow() -> [[String: Any]] {
    func w(_ id: CGWindowID, _ on: Bool = true, _ eligible: Bool = true) -> WindowSnap { WindowSnap(id: id, onScreen: on, eligible: eligible) }
    var cases: [[String: Any]] = []
    func check(_ name: String, _ got: [[FollowAction]], _ want: [[FollowAction]]) {
        cases.append(["name": name, "pass": got == want, "got": got.map { $0.map { "\($0)" } }])
    }

    // A -> B -> C, then C closes but stays listed off screen: back to B.
    var s = FollowState(follow: true, current: 1, known: [1])
    var got: [[FollowAction]] = []
    got.append(s.step([w(1), w(2)])); s.switched(to: 2)
    got.append(s.step([w(1), w(2), w(3)])); s.switched(to: 3)
    got.append(s.step([w(1), w(2), w(3, false)])); s.switched(to: 2)
    got.append(s.step([w(1), w(2), w(3, false)]))
    check("follow A-B-C, close C returns to B", got, [[.switchTo(2)], [.switchTo(3)], [.switchTo(2)], []])

    // Without follow: hidden is held with one warning, visible again warns once, removal stops.
    s = FollowState(follow: false, current: 1, known: [1])
    got = [s.step([w(1, false)]), s.step([w(1, false)]), s.step([w(1)]), s.step([w(1)]), s.step([w(2)])]
    check("no follow: hold, return, close", got, [[.warnHidden], [], [.warnVisible], [], [.stop("target-closed")]])

    // Follow, current hidden with no on-screen window: hold, then switch when one appears.
    s = FollowState(follow: true, current: 1, known: [1])
    got = [s.step([w(1, false)]), s.step([w(1, false), w(4)])]
    check("follow: hold until a window appears", got, [[.warnHidden], [.switchTo(4)]])

    // Follow, a new window first seen off screen is followed once it comes on screen.
    s = FollowState(follow: true, current: 1, known: [1])
    got = [s.step([w(1), w(5, false)]), s.step([w(1), w(5)])]
    check("follow: off-screen newcomer followed when shown", got, [[], [.switchTo(5)]])

    // Follow, the current window leaves the list and only pre-existing windows remain: stop.
    s = FollowState(follow: true, current: 1, known: [1, 9])
    got = [s.step([w(9)])]
    check("follow: no survivor stops", got, [[.stop("target-closed")]])

    // The owning app quit: stop even if the id lingers.
    s = FollowState(follow: false, current: 1, known: [1])
    got = [s.step([w(1, false)], ownerGone: true)]
    check("owner quit stops", got, [[.stop("target-closed")]])

    // Ignored (ineligible) newcomers are never followed; windows present at start are not either.
    s = FollowState(follow: true, current: 1, known: [1, 6])
    got = [s.step([w(1), w(6), w(7, true, false)])]
    check("ignored and pre-existing windows are not followed", got, [[]])

    // A window first listed while ineligible (a new tab, briefly small) is followed once eligible,
    // and still counts as a survivor: A -> B (small first) -> C, then C leaves the list: back to B.
    s = FollowState(follow: true, current: 1, known: [1])
    got = [s.step([w(1), w(2, true, false)]), s.step([w(1, false), w(2)])]
    s.switched(to: 2)
    got.append(s.step([w(1, false), w(2, false), w(3)])); s.switched(to: 3)
    got.append(s.step([w(1, false), w(2)]))
    check("window first seen ineligible is followed later and survives", got, [[], [.switchTo(2)], [.switchTo(3)], [.switchTo(2)]])

    // A switch that fails (no switched() call) is retried on the next check, then settles.
    s = FollowState(follow: true, current: 1, known: [1])
    got = [s.step([w(1), w(2)]), s.step([w(1), w(2)])]
    s.switched(to: 2)
    got.append(s.step([w(1), w(2)]))
    check("a failed follow switch is retried", got, [[.switchTo(2)], [.switchTo(2)], []])

    let markLine = markJSON(t: 5.4729999999999999, text: "switched to \"TextEdit\": é")
    cases.append(["name": "mark times print with 3 decimals", "pass": markLine == #"{"t":5.473,"text":"switched to \"TextEdit\": é"}"#, "got": [[markLine]]])

    return cases
}

import AVFoundation
import CoreMedia
import CoreVideo

/// A synthetic 64x64 BGRA frame presented at `t`.
private func syntheticFrame(_ t: CMTime) -> CMSampleBuffer? {
    var pb: CVPixelBuffer?
    let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()] as CFDictionary
    guard CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_32BGRA, attrs, &pb) == kCVReturnSuccess, let pb else { return nil }
    var fmt: CMVideoFormatDescription?
    guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pb, formatDescriptionOut: &fmt) == noErr, let fmt else { return nil }
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: t, decodeTimeStamp: .invalid)
    var sb: CMSampleBuffer?
    guard CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pb, formatDescription: fmt,
                                                   sampleTiming: &timing, sampleBufferOut: &sb) == noErr else { return nil }
    return sb
}

/// Drives a real Recorder (AVAssetWriter) with frames in the order that used to fail the writer:
/// a frame, a heartbeat repeat at +1.0 s, then a late real frame presented at +0.5 s.
func selftestRecorder() async -> [[String: Any]] {
    var cases: [[String: Any]] = []
    func check(_ name: String, _ pass: Bool, _ got: Any) { cases.append(["name": name, "pass": pass, "got": got]) }

    check("shouldAppend: first frame", Recorder.shouldAppend(CMTime(value: 1, timescale: 1), after: .invalid), "")
    check("shouldAppend: later frame", Recorder.shouldAppend(CMTime(value: 2, timescale: 1), after: CMTime(value: 1, timescale: 1)), "")
    check("shouldAppend: same time is dropped", !Recorder.shouldAppend(CMTime(value: 1, timescale: 1), after: CMTime(value: 1, timescale: 1)), "")
    check("shouldAppend: earlier is dropped", !Recorder.shouldAppend(CMTime(value: 1, timescale: 2), after: CMTime(value: 1, timescale: 1)), "")

    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("screenrec-selftest-\(getpid())")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let url = dir.appendingPathComponent("order.mov")
    guard let r = try? Recorder(url: url, width: 64, height: 64) else { check("recorder opens", false, "init failed"); return cases }
    // Frames sit 3 s in the past, so finish() (which works at "now") comes after all of them.
    let base = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), CMTime(value: 3, timescale: 1))
    let at = { (s: Double) in CMTimeAdd(base, CMTime(seconds: s, preferredTimescale: 600)) }
    guard let f0 = syntheticFrame(at(0)), let late = syntheticFrame(at(0.5)), let f2 = syntheticFrame(at(1.5)) else {
        check("synthetic frames", false, "could not build"); return cases
    }
    r.testIngest(f0)
    r.testRepeat(at: at(1.0))
    r.testIngest(late)  // older than the repeat
    r.testIngest(f2)
    let res = await r.finish()
    let dropped = r.testDropped
    let duration = (try? await AVURLAsset(url: url).load(.duration)).map { CMTimeGetSeconds($0) } ?? 0
    check("late frame after a repeat does not fail the writer", res.writerError == nil, res.writerError ?? "none")
    check("late frame is dropped and counted", dropped == 1 && res.frames == 2, "dropped \(dropped), frames \(res.frames)")
    check("file is playable", duration > 1.4, "duration \(duration)")
    return cases
}

/// Screen-state rules, no-displays texts and the content-query retry, without ScreenCaptureKit.
func selftestScreen() async -> [[String: Any]] {
    var cases: [[String: Any]] = []
    func check(_ name: String, _ pass: Bool, _ got: Any) { cases.append(["name": name, "pass": pass, "got": got]) }

    check("screen: unlocked with a display awake is awake", classifyScreen(locked: false, displaysAsleep: [true, false]) == .awake, "")
    check("screen: every display asleep is asleep", classifyScreen(locked: false, displaysAsleep: [true, true]) == .asleep, "")
    check("screen: locked wins over asleep", classifyScreen(locked: true, displaysAsleep: [true]) == .locked, "")
    check("screen: no online displays is not called asleep", classifyScreen(locked: false, displaysAsleep: []) == .awake, "")
    check("screen: off console wins over locked", classifyScreen(onConsole: false, locked: true, displaysAsleep: [true]) == .offConsole, "")
    check("screen: rank orders off console > locked > asleep > awake",
          ScreenState.offConsole.rank > ScreenState.locked.rank && ScreenState.locked.rank > ScreenState.asleep.rank && ScreenState.asleep.rank > ScreenState.awake.rank, "")

    let locked = noDisplaysFailure(.locked, tries: 3), asleep = noDisplaysFailure(.asleep, tries: 3), awake = noDisplaysFailure(.awake, tries: 3)
    check("no displays, locked: says locked, fix unlocks", locked.message.contains("locked") && (locked.fix ?? "").hasPrefix("Unlock the Mac"), locked.message)
    check("no displays, asleep: says asleep, fix wakes", asleep.message.contains("asleep") && (asleep.fix ?? "").hasPrefix("Wake the displays"), asleep.message)
    check("no displays, awake: never blames a lock", !awake.message.contains("is locked") && awake.message.contains("3 tries")
          && awake.message.contains("macOS reports") && awake.code == "E_TARGET_NOT_FOUND" && !(awake.fix ?? "").contains("Unlock"), awake.message)
    let noGrant = noDisplaysFailure(.awake, tries: 3, permitted: false)
    check("no displays, awake without the grant: a permission error", noGrant.code == "E_PERMISSION" && noGrant.message.contains("permission") && noGrant.fix == nil, noGrant.message)
    let away = noDisplaysFailure(.offConsole, tries: 3, permitted: false)
    check("no displays, off console: names the other session, not permission", away.code == "E_TARGET_NOT_FOUND" && away.message.contains("another user session"), away.message)
    check("screen warning only when not awake", screenWarning(.awake) == nil && screenWarning(.locked) != nil && screenWarning(.asleep) != nil && screenWarning(.offConsole) != nil, "")

    check("retry: empty display list on an awake screen", shouldRetryQuery(failed: false, permission: false, displaysEmpty: true, wantsDisplay: true, state: .awake), "")
    check("retry: failed query on an awake screen", shouldRetryQuery(failed: true, permission: false, displaysEmpty: false, wantsDisplay: false, state: .awake), "")
    check("no retry: permission refused", !shouldRetryQuery(failed: true, permission: true, displaysEmpty: false, wantsDisplay: false, state: .awake), "")
    check("no retry: screen locked or asleep", !shouldRetryQuery(failed: false, permission: false, displaysEmpty: true, wantsDisplay: true, state: .locked)
        && !shouldRetryQuery(failed: true, permission: false, displaysEmpty: false, wantsDisplay: false, state: .asleep), "")
    check("no retry: window capture does not need displays", !shouldRetryQuery(failed: false, permission: false, displaysEmpty: true, wantsDisplay: false, state: .awake), "")

    var calls = 0
    let gaveUp = await retrying(tries: 3, delay: 0, again: { $0 == 0 }) { calls += 1; return 0 }
    check("retrying: stops after the given tries", gaveUp == 0 && calls == 3, "calls \(calls)")
    calls = 0
    let second = await retrying(tries: 3, delay: 0, again: { $0 == 0 }) { calls += 1; return calls >= 2 ? 7 : 0 }
    check("retrying: returns the first good answer", second == 7 && calls == 2, "calls \(calls)")
    calls = 0
    let start = Date()
    _ = await retrying(tries: 3, delay: 0.05, again: { _ in true }) { calls += 1; return 0 }
    let took = Date().timeIntervalSince(start)
    check("retrying: waits between tries, not after the last", took >= 0.09 && took < 1, "took \(took)")

    let err = NSError(domain: "com.apple.ScreenCaptureKit.SCStreamErrorDomain", code: -3801, userInfo: [NSLocalizedDescriptionKey: "boom"])
    check("query errors name their domain and code", describe(err) == "boom (com.apple.ScreenCaptureKit.SCStreamErrorDomain -3801)", describe(err))
    return cases
}

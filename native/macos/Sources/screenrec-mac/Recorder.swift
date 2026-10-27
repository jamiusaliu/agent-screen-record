import ScreenCaptureKit
import AVFoundation

/// Writes complete frames to a fragmented .mov. Every mutable field is only touched on `queue`,
/// which is also the sample handler queue.
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    struct Result { let frames: Int; let writerError: String? }

    let queue = DispatchQueue(label: "screenrec.record")
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var frames = 0
    private var sessionStarted = false
    private var finishing = false          // set in the same queue round trip as finish(); no append after it
    private var announced = false          // the "started" event has been written
    private var firstFramePending = false  // a first frame arrived before "started" was written
    private var firstFrameMs: Int64 = 0    // wall-clock epoch ms of the first written frame
    private var writerError: String?
    // A still screen yields no complete frames, so the last frame is repeated, re-timed to "now":
    // media time then keeps pace with the clock, fragments are flushed every 2 s (a killed file stays
    // playable) and a still final stretch keeps its real length.
    private var lastSample: CMSampleBuffer?
    private var lastAppended = CMTime.invalid
    private var heartbeat: DispatchSourceTimer?
    private static let repeatAfter = CMTime(value: 1, timescale: 2)  // 0.5 s
    /// Set before capture starts; called on `queue`.
    var onStreamError: ((Error) -> Void)?
    var onWriterFailed: (() -> Void)?

    init(url: URL, width: Int, height: Int) throws {
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)  // killed files stay playable
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
            // No B-frame reordering: the encoder then holds no frames back, so on a still screen
            // (one repeated frame per 0.5 s) the first fragment reaches disk about 2 s after the first frame.
            AVVideoCompressionPropertiesKey: [AVVideoAllowFrameReorderingKey: false],
        ])
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        super.init()
    }

    var isFinishing: Bool { queue.sync { finishing } }

    /// Writes the "started" event on `queue`, so "first-frame" can never come before it.
    func announceStarted(width: Int, height: Int) {
        queue.sync {
            emit(["event": "started", "width": width, "height": height])
            announced = true
            if firstFramePending { firstFramePending = false; emitFirstFrame() }
        }
    }

    /// Frames must reach the writer in increasing presentation time. A real frame captured just before a
    /// heartbeat repeat but delivered after it carries an earlier time, and appending it would fail the writer.
    static func shouldAppend(_ pts: CMTime, after last: CMTime) -> Bool { !last.isValid || pts > last }

    private(set) var dropped = 0  // real frames dropped for arriving out of order (on `queue`)

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, frameComplete(sb) else { return }
        ingest(sb)
    }

    private func ingest(_ sb: CMSampleBuffer) {  // on `queue`
        guard !finishing, writerError == nil else { return }
        if !sessionStarted {
            guard writer.startWriting() else { writerFailed("startWriting"); return }
            writer.startSession(atSourceTime: sb.presentationTimeStamp)
            sessionStarted = true
            // Wall-clock time of the frame itself: now, minus how long ago (host clock) it was presented.
            let age = CMTimeGetSeconds(CMTimeSubtract(Self.hostNow(), sb.presentationTimeStamp))
            firstFrameMs = Int64((Date().timeIntervalSince1970 - (age.isFinite ? max(0, age) : 0)) * 1000)
            if announced { emitFirstFrame() } else { firstFramePending = true }
        }
        guard Self.shouldAppend(sb.presentationTimeStamp, after: lastAppended) else {
            dropped += 1
            lastSample = sb  // newer pixels: let the next repeat show them
            return
        }
        guard input.isReadyForMoreMediaData else { return }
        if input.append(sb) {
            frames += 1
            lastSample = sb; lastAppended = sb.presentationTimeStamp
            if heartbeat == nil { startHeartbeat() }
        } else if writer.status == .failed { writerFailed("append") }
    }

    private static func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

    private func startHeartbeat() {  // on `queue`
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 0.5, repeating: 0.5)
        t.setEventHandler { [weak self] in
            guard let self, !self.finishing else { return }
            let now = Self.hostNow()
            if CMTimeSubtract(now, self.lastAppended) >= Self.repeatAfter { self.repeatLast(at: now) }
        }
        t.resume()
        heartbeat = t
    }

    /// Appends the last frame again with presentation time `t`. Not counted in `frames`.
    private func repeatLast(at t: CMTime) {  // on `queue`
        guard writerError == nil, let last = lastSample, t > lastAppended, input.isReadyForMoreMediaData else { return }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: t, decodeTimeStamp: .invalid)
        var copy: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: last, sampleTimingEntryCount: 1,
                                                    sampleTimingArray: &timing, sampleBufferOut: &copy) == noErr, let copy else { return }
        if input.append(copy) { lastAppended = t } else if writer.status == .failed { writerFailed("append") }
    }

    /// `ms` lets the Node side align step notes with the video (Task 19).
    private func emitFirstFrame() { emit(["event": "first-frame", "ms": firstFrameMs]) }  // on `queue`

    private func writerFailed(_ step: String) {  // on `queue`
        guard writerError == nil else { return }
        let why = writer.error?.localizedDescription ?? "unknown writer error"
        writerError = "\(step): \(why)"
        emit(["event": "warning", "message": "video writer failed at \(step): \(why)"])
        onWriterFailed?()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { if !self.finishing { self.onStreamError?(error) } }
    }

    // Test hooks for `screenrec-mac selftest`: feed frames and heartbeats without ScreenCaptureKit.
    func testIngest(_ sb: CMSampleBuffer) { queue.sync { ingest(sb) } }
    func testRepeat(at t: CMTime) { queue.sync { repeatLast(at: t) } }
    var testDropped: Int { queue.sync { dropped } }

    /// Stops appending, then ends the file at "now" so a still final stretch keeps its real length.
    func finish() async -> Result {
        let (count, didStart, earlier): (Int, Bool, String?) = await withCheckedContinuation { c in
            queue.async {
                self.repeatLast(at: Self.hostNow())  // the still tail up to "now" becomes a real frame
                self.heartbeat?.cancel(); self.heartbeat = nil
                self.finishing = true
                c.resume(returning: (self.frames, self.sessionStarted, self.writerError))
            }
        }
        guard didStart else { return Result(frames: 0, writerError: earlier) }
        if writer.status == .writing {
            input.markAsFinished()
            writer.endSession(atSourceTime: CMClockGetTime(CMClockGetHostTimeClock()))
            await writer.finishWriting()
        }
        guard writer.status == .completed else {
            let why = writer.error?.localizedDescription ?? earlier ?? "writer status \(writer.status.rawValue)"
            emit(["event": "warning", "message": "video writer could not finish the file: \(why)"])
            return Result(frames: count, writerError: why)
        }
        return Result(frames: count, writerError: nil)
    }
}

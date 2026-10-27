import ScreenCaptureKit
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// Unchecked: every mutable field is only touched on `queue`.
private final class OneFrame: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "screenrec.shot")
    enum Outcome { case image(CGImage?), timedOut, startFailed(Error), stopped(Error) }
    var done = false
    var cont: CheckedContinuation<Outcome, Never>?

    func finish(_ outcome: Outcome) {  // always called on `queue`
        guard !done else { return }
        done = true
        cont?.resume(returning: outcome)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, frameComplete(sb), let pb = sb.imageBuffer else { return }
        let ci = CIImage(cvPixelBuffer: pb)
        finish(.image(CIContext().createCGImage(ci, from: ci.extent)))
    }

    /// ScreenCaptureKit ended the stream before a frame came (without this the shot would wait out the 3 s).
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.finish(.stopped(error)) }
    }
}

/// One stream for one frame: the first complete frame within 3 s, or why there was none.
private func shoot(_ spec: CaptureSpec, _ filter: SCContentFilter, _ content: SCShareableContent) async -> OneFrame.Outcome {
    let output = OneFrame()
    let stream = CaptureStream(filter: Handoff(filter), configuration: Handoff(centred(makeConfig(spec), for: spec, content)), delegate: output)
    do { try stream.addOutput(output, queue: output.queue) } catch { return .startFailed(error) }
    let outcome: OneFrame.Outcome = await withCheckedContinuation { c in
        output.queue.async {
            output.cont = c
            output.queue.asyncAfter(deadline: .now() + 3) { output.finish(.timedOut) }
        }
        Task { do { try await stream.start() } catch { output.queue.async { output.finish(.startFailed(error)) } } }
    }
    await stream.stop()
    return outcome
}

/// A screenshot a running recorder takes for another process (Requests.swift): one content query, kept
/// apart from the recorder's own, and the PNG written as a new file at `out`, whatever the request's --out says.
struct ServedShot { let out: String }

/// The `screenshot` command as a value: the result line, or a HelperFailure. Never exits, so a running
/// recorder can serve it (see Requests.swift).
func takeScreenshot(_ a: Args, served: ServedShot? = nil) async throws -> [String: Any] {
    guard let outPath = served?.out ?? a.str("out") else { throw HelperFailure("E_BAD_ARGS", "--out is required") }
    let spec = try parseSpec(a)
    // A locked, sleeping or switched-away screen draws nothing: say so now rather than wait on ScreenCaptureKit.
    let before = screenState()
    if before != .awake { let f = noFrameFailure(before, onScreen: nil, streamError: nil); throw HelperFailure(f.code, f.message, fix: f.fix) }
    let content = served == nil ? try await contentForCapture(spec)
        : try await contentForCapture(spec, timeout: startTimeout(), tries: 1, stuck: .served)
    let filter = try filterFor(spec, content)
    let onScreen = spec.windowID.flatMap { wid in content.windows.first { $0.windowID == wid }?.isOnScreen }
    var outcome = await shoot(spec, filter, content)
    // A stream ScreenCaptureKit stops straight away (for example "application connection interrupted")
    // gets one fresh try.
    if case .stopped = outcome { outcome = await shoot(spec, filter, content) }
    let img: CGImage
    switch outcome {
    case .startFailed(let error): throw startFailure(error)
    case .stopped(let error) where isPermissionError(error): throw startFailure(error)
    case .timedOut, .stopped:
        var stopError: String?
        if case .stopped(let error) = outcome { stopError = describe(error) }
        let f = noFrameFailure(screenState(), onScreen: onScreen, streamError: stopError)  // state read once: a lock can change between reads
        throw HelperFailure(f.code, f.message, fix: f.fix)
    case .image(nil): throw HelperFailure("E_HELPER_CRASHED", "could not convert the captured frame to an image")
    case .image(let i?): img = i
    }
    let cannot = HelperFailure("E_BAD_ARGS", "cannot write \(outPath)", fix: outputFolderFix)
    if served != nil {
        guard let png = pngData(img), writeNewFile(png, at: outPath) else { throw cannot }
    } else {
        let url = URL(fileURLWithPath: outPath) as CFURL
        guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { throw cannot }
        CGImageDestinationAddImage(dest, img, nil)
        guard CGImageDestinationFinalize(dest) else { throw cannot }
    }
    return ["ok": true, "out": outPath, "width": img.width, "height": img.height]
}

/// `img` encoded as PNG, in memory.
private func pngData(_ img: CGImage) -> Data? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, img, nil)
    return CGImageDestinationFinalize(dest) ? data as Data : nil
}

/// Writes `data` to a file that must not exist yet (no replacing, no following a link), owner-only.
func writeNewFile(_ data: Data, at path: String) -> Bool {
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { return false }
    let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    do { try h.write(contentsOf: data); try h.close(); return true }
    catch { try? h.close(); unlink(path); return false }
}

func screenshot(_ a: Args) async {
    let limit = startTimeout() + 6  // the content query, then up to two 3 s attempts
    let dog = Watchdog(seconds: limit, message: "ScreenCaptureKit did not answer within \(Int(limit)) s (another capture may be starting at the same time)")
    do {
        let result = try await takeScreenshot(a)
        dog.disarm()
        emit(result)
    } catch { dog.disarm(); fail(error) }
}

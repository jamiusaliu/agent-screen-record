import ScreenCaptureKit
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// Unchecked: every mutable field is only touched on `queue`.
private final class OneFrame: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "screenrec.shot")
    enum Outcome { case image(CGImage?), timedOut, startFailed(Error) }
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
}

func screenshot(_ a: Args) async {
    guard let outPath = a.str("out") else { fail("E_BAD_ARGS", "--out is required") }
    let spec = makeSpec(a)
    let dog = Watchdog(seconds: startTimeout() + 3, message: "ScreenCaptureKit did not answer within \(Int(startTimeout() + 3)) s (another capture may be starting at the same time)")
    let content = await shareableForCapture(spec)
    let stream = CaptureStream(filter: Handoff(makeFilter(spec, content)), configuration: Handoff(centred(makeConfig(spec), for: spec, content)), delegate: nil)
    let output = OneFrame()
    do { try stream.addOutput(output, queue: output.queue) }
    catch { fail("E_HELPER_CRASHED", "addStreamOutput: \(error.localizedDescription)") }
    let outcome: OneFrame.Outcome = await withCheckedContinuation { c in
        output.queue.async {
            output.cont = c
            output.queue.asyncAfter(deadline: .now() + 3) { output.finish(.timedOut) }
        }
        Task { do { try await stream.start() } catch { output.queue.async { output.finish(.startFailed(error)) } } }
    }
    dog.disarm()
    await stream.stop()
    let img: CGImage
    switch outcome {
    case .startFailed(let error): failStart(error)
    case .timedOut:
        let state = screenState()  // read once: a lock can change between two reads
        if let why = screenWarning(state) { fail("E_NO_FRAMES", "no frame within 3 s: \(why)", fix: noDisplaysFailure(state, tries: 1).fix) }
        fail("E_NO_FRAMES", "no frame within 3 s (is the window minimized or on another Space?)")
    case .image(nil): fail("E_HELPER_CRASHED", "could not convert the captured frame to an image")
    case .image(let i?): img = i
    }
    let url = URL(fileURLWithPath: outPath) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { fail("E_BAD_ARGS", "cannot write \(outPath)", fix: outputFolderFix) }
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { fail("E_BAD_ARGS", "cannot write \(outPath)", fix: outputFolderFix) }
    emit(["ok": true, "out": outPath, "width": img.width, "height": img.height])
}

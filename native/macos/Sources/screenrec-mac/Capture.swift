import ScreenCaptureKit
import CoreMedia

struct CaptureSpec {
    var windowID: CGWindowID?
    var displayID: CGDirectDisplayID?
    var region: CGRect?
    var width: Int
    var height: Int
    var cursor: Bool
    var fps: Int
}

/// Largest accepted output side, in pixels (well above any display; keeps Int conversion safe).
let maxSidePx = 16384.0

/// Parses an unsigned 32-bit id flag; nil when absent, E_BAD_ARGS when present but not a valid id.
private func idFlag(_ a: Args, _ k: String) throws -> UInt32? {
    guard let s = a.str(k) else { return nil }
    guard let v = UInt32(s) else { throw HelperFailure("E_BAD_ARGS", "--\(k) must be a whole number id, got \(s)") }
    return v
}

/// Startup variant of parseSpec: exits with E_BAD_ARGS.
func makeSpec(_ a: Args) -> CaptureSpec {
    do { return try parseSpec(a) } catch { fail(error) }
}

/// Validates every capture flag before any ScreenCaptureKit call, so bad input never traps or captures.
func parseSpec(_ a: Args) throws -> CaptureSpec {
    guard let size = a.nums("size") else { throw HelperFailure("E_BAD_ARGS", "--size W,H is required") }
    guard size.count == 2, size.allSatisfy({ $0 > 0 && $0 <= maxSidePx && $0 == $0.rounded() }) else {
        throw HelperFailure("E_BAD_ARGS", "--size needs two whole numbers of pixels from 2 to \(Int(maxSidePx)), got \(a.str("size") ?? "")")
    }
    guard size.allSatisfy({ Int($0) % 2 == 0 }) else { throw HelperFailure("E_BAD_ARGS", "size must be even, got \(Int(size[0]))x\(Int(size[1]))") }
    let windowID = try idFlag(a, "window-id"), displayID = try idFlag(a, "display-id")
    if (windowID == nil) == (displayID == nil) { throw HelperFailure("E_BAD_ARGS", "pass exactly one of --window-id or --display-id") }
    var region: CGRect? = nil
    if let r = a.nums("region") {
        guard r.count == 4, r[2] > 0, r[3] > 0 else {
            throw HelperFailure("E_BAD_ARGS", "--region needs four numbers x,y,w,h with w and h above 0, got \(a.str("region") ?? "")")
        }
        guard windowID == nil else { throw HelperFailure("E_BAD_ARGS", "--region is for display capture only; drop it or use --display-id") }
        region = CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
    }
    var fps = 30
    if let s = a.str("fps") {
        guard let v = Int(s), (1...120).contains(v) else { throw HelperFailure("E_BAD_ARGS", "--fps must be a whole number from 1 to 120, got \(s)") }
        fps = v
    }
    return CaptureSpec(windowID: windowID.map { CGWindowID($0) }, displayID: displayID.map { CGDirectDisplayID($0) },
                       region: region, width: Int(size[0]), height: Int(size[1]), cursor: a.bool("cursor"), fps: fps)
}

enum TargetError: LocalizedError {
    case windowGone(CGWindowID), noDisplays, displayGone(CGDirectDisplayID)
    var errorDescription: String? {
        switch self {
        case .windowGone(let w): return "window \(w) no longer exists"
        case .noDisplays: return "No displays are available"
        case .displayGone(let d): return "display \(d) not found"
        }
    }
}

/// The filter for a window (when `windowID` is set) or a display. Throws TargetError; never exits,
/// so the record restart path can route a failure to a clean stop.
func tryFilter(windowID: CGWindowID?, displayID: CGDirectDisplayID?, _ content: SCShareableContent) throws -> SCContentFilter {
    if let wid = windowID {
        guard let w = content.windows.first(where: { $0.windowID == wid }) else { throw TargetError.windowGone(wid) }
        return SCContentFilter(desktopIndependentWindow: w)
    }
    if content.displays.isEmpty { throw TargetError.noDisplays }
    guard let d = content.displays.first(where: { $0.displayID == displayID }) else { throw TargetError.displayGone(displayID ?? 0) }
    return SCContentFilter(display: d, excludingWindows: [])
}

/// The filter for `spec`, or the failure to report: the screen state when there are no displays,
/// E_TARGET_NOT_FOUND otherwise.
func filterFor(_ spec: CaptureSpec, _ content: SCShareableContent) throws -> SCContentFilter {
    do { return try tryFilter(windowID: spec.windowID, displayID: spec.displayID, content) }
    catch TargetError.noDisplays {
        let f = noDisplaysFailure(screenState(), tries: contentQueryTries, permitted: CGPreflightScreenCaptureAccess())
        throw HelperFailure(f.code, f.message, fix: f.fix)
    } catch { throw HelperFailure("E_TARGET_NOT_FOUND", error.localizedDescription) }
}

/// Startup variant: exits with E_TARGET_NOT_FOUND.
func makeFilter(_ spec: CaptureSpec, _ content: SCShareableContent) -> SCContentFilter {
    do { return try filterFor(spec, content) } catch { fail(error) }
}

func makeConfig(_ spec: CaptureSpec) -> SCStreamConfiguration {
    let c = SCStreamConfiguration()
    c.width = spec.width
    c.height = spec.height
    c.showsCursor = spec.cursor
    c.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(spec.fps))
    c.pixelFormat = kCVPixelFormatType_32BGRA
    c.queueDepth = 6
    if let r = spec.region { c.sourceRect = r }
    if #available(macOS 14.0, *) { c.scalesToFit = true; c.preservesAspectRatio = true }
    return c
}

/// The largest rect with `content`'s aspect ratio that fits in `box`, centred.
func fitRect(_ content: CGSize, in box: CGSize) -> CGRect {
    guard content.width > 0, content.height > 0 else { return CGRect(origin: .zero, size: box) }
    let scale = min(box.width / content.width, box.height / content.height)
    let w = (content.width * scale).rounded(), h = (content.height * scale).rounded()
    return CGRect(x: ((box.width - w) / 2).rounded(.down), y: ((box.height - h) / 2).rounded(.down), width: w, height: h)
}

/// Points the output at a centred, aspect-correct rect for content of `contentSize`
/// (ScreenCaptureKit alone pads on one side). Returns `config` for chaining.
@discardableResult
func centred(_ config: SCStreamConfiguration, contentSize: CGSize) -> SCStreamConfiguration {
    config.destinationRect = fitRect(contentSize, in: CGSize(width: config.width, height: config.height))
    return config
}

/// `centred` for the target the spec names: the window, the region or the whole display.
@discardableResult
func centred(_ config: SCStreamConfiguration, for spec: CaptureSpec, _ content: SCShareableContent) -> SCStreamConfiguration {
    if let wid = spec.windowID, let w = content.windows.first(where: { $0.windowID == wid }) { return centred(config, contentSize: w.frame.size) }
    if let r = spec.region { return centred(config, contentSize: r.size) }
    if let d = content.displays.first(where: { $0.displayID == spec.displayID }) { return centred(config, contentSize: d.frame.size) }
    return config
}

/// Hands a value built for exactly one ScreenCaptureKit call to that call. Unchecked: the sender
/// never touches the value again (filters and configurations are built fresh per call).
struct Handoff<T>: @unchecked Sendable {
    let value: T
    init(_ v: T) { value = v }
}

/// The SCStream calls the helper makes, behind a Sendable wrapper. Unchecked: the helper never calls
/// one stream concurrently (record goes through the Session actor, screenshot is sequential).
final class CaptureStream: @unchecked Sendable {
    private let stream: SCStream
    init(filter: Handoff<SCContentFilter>, configuration: Handoff<SCStreamConfiguration>, delegate: (any SCStreamDelegate & Sendable)?) {
        stream = SCStream(filter: filter.value, configuration: configuration.value, delegate: delegate)
    }
    func addOutput(_ output: any SCStreamOutput & Sendable, queue: DispatchQueue) throws {
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
    }
    func start() async throws { try await stream.startCapture() }
    func stop() async { try? await stream.stopCapture() }
    func setFilter(_ filter: Handoff<SCContentFilter>) async throws { try await stream.updateContentFilter(filter.value) }
    func setConfig(_ config: Handoff<SCStreamConfiguration>) async throws { try await stream.updateConfiguration(config.value) }
}

/// True when ScreenCaptureKit refused because Screen Recording is not granted.
func isPermissionError(_ error: Error) -> Bool {
    let e = error as NSError
    return e.domain == SCStreamErrorDomain && e.code == SCStreamError.Code.userDeclined.rawValue
}

/// A stream that failed to start: E_PERMISSION for a refused grant, E_HELPER_CRASHED otherwise.
func startFailure(_ error: Error) -> HelperFailure {
    if isPermissionError(error) { return HelperFailure("E_PERMISSION", "Screen Recording permission is not granted: \(error.localizedDescription)") }
    return HelperFailure("E_HELPER_CRASHED", "startCapture failed: \(describe(error))")
}

func failStart(_ error: Error) -> Never { fail(startFailure(error)) }

/// True only for frames that carry new content (idle and blank frames are skipped).
func frameComplete(_ sb: CMSampleBuffer) -> Bool {
    guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = arr.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { return false }
    return status == .complete
}

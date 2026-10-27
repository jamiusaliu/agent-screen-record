import AppKit

let usage = """
usage: screenrec-mac <command> [flags]   (one JSON line per result or event on stdout)
  displays                       list displays (points, global top-left coordinates)
  windows                        list layer-0 windows with z order
  permission [--request]         report (or request) Screen Recording permission
  screenshot <capture> --out F   write one frame as PNG
  record <capture> --out F.mov [--max-seconds N] [--marks F] [--t0-ms MS]
         [--follow-app] [--ignore-pid PID ...] [--ignore-app NAME ...]
capture: --window-id ID | --display-id ID [--region x,y,w,h], --size W,H (even), [--cursor], [--fps 1..120]
record events: started {width,height}; first-frame {ms: epoch ms of the first written frame};
               switched {windowId,app,title}; warning {message} (also before started when the screen is locked, asleep or off console);
               stopped {reason,frames,screen?: "locked"|"asleep"|"off-console" when no frames were written and the screen was not drawn}
exit codes: 0 ok; 1 error JSON on stdout; record also uses 5 = no frames were written,
            6 = the video file could not be written (folder missing or not writable, disk full, encoder failure)
"""

// Command-line tools must initialise AppKit's connection to the window server before
// any ScreenCaptureKit call, or they abort in CGS_REQUIRE_INIT (spike finding).
_ = NSApplication.shared

let args = Args(Array(CommandLine.arguments.dropFirst()))
switch args.command {
case "displays":
    emit(["ok": true, "displays": listDisplays()])
case "windows":
    let dog = startWatchdog()
    let content = await shareable()
    dog.disarm()
    emit(["ok": true, "windows": windowDicts(content)])
case "permission":
    if args.bool("request") { _ = CGRequestScreenCaptureAccess() }
    emit(["ok": true, "granted": CGPreflightScreenCaptureAccess()])
case "screenshot":
    await screenshot(args)
case "record":
    await record(args)
case "selftest", "selftest-follow":  // follow rules and writer ordering, no capture (used by the mac-smoke tests)
    let cases = selftestFollow() + (await selftestRecorder()) + (await selftestScreen())
    emit(["ok": cases.allSatisfy { $0["pass"] as? Bool == true }, "cases": cases])
case "help", "--help", "":
    print(usage)
default:
    fail("E_BAD_ARGS", "unknown command \(args.command)")
}
exit(0)

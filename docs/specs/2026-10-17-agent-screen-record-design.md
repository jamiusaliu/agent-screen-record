# Agent screen record: design

Status: approved on 17 Oct 2026 and implemented as v1 (0.1.0). npm package
`agent-screen-record`, command `screenrec`. Amended on 24 Oct 2026 to match the
shipped behaviour; see section 14.

## 1. Purpose

Give AI agents the ability to record what they do on a computer, then clean the
recording up, for anyone, locally. The agent can be anything: Claude Code, Claude
Desktop, Claude in Chrome, Claude or Codex computer use, Cursor, a Playwright
script, or a human at a shell. The recorder never drives the computer; it only
watches a target.

Success looks like: "record what you do in Chrome" or "record yourself opening my
Downloads folder" produces a correct, cropped, privacy-safe mp4 or GIF, even when
the agent works in a window that is covered or in a Chrome tab that is not the
visible one, and even when the user keeps working on something else.

Example requests that must work end to end, with the user doing nothing but
asking:

- "Visit https://example.com, look around, and record it."
- "I have a tab open in Chrome. Record it." (the user's own logged-in tab)
- "There is a GIF, a .mov or a picture in my Downloads folder. Open it and record
  the whole navigation, as a human would, until the file is open." (Finder, then
  Preview or QuickTime: the recording follows the work across apps)
- "Record yourself reproducing this bug in the app I downloaded."
- "Record what you do in Chrome while I keep working on my other screen."

The third example implies one recording can follow work from one app's window
to another's. v1 covers it with `--display` or `--display-of`, plus `--follow-app`
(section 6.1).

## 2. Background and evidence

A private prototype (ffmpeg avfoundation, screen rectangle crop) proved the
clean-up pipeline but records screen pixels, so it captures whatever is in front.
A feasibility spike on 17 Oct 2026 (macOS 26.7.1, Intel, Chrome 155, two
displays) established:

| Finding | Result |
|---|---|
| ScreenCaptureKit window capture of a covered Finder window | Live; covering window absent from frames |
| Covered window, normal Chrome | Frozen: Chrome stops painting occluded windows |
| Covered window, Chrome with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling` | Live |
| Covered window, Safari | Live, page timers throttled |
| CDP `Page.startScreencast` on a background tab | No frames |
| Same plus `Emulation.setFocusEmulationEnabled` | Live frames while another tab stayed visible |
| Chrome `tabCapture` extension API | Needs a user gesture per tab (documented), so not hands-free |
| Prototype on two displays | Records only display 0; windows on a display left of main get a wrong crop |

Details are in the author's private spike notes (not part of this repository).

## 3. Scope

**v1 (macOS):** window, app, display and region capture; Chrome tab capture via
CDP; clean-up commands; CLI; MCP server; Claude Code plugin; AGENTS.md snippet.

**Later:** Chrome extension (level C, promoted into v1 if the first build task
fails, see 6.5); CSS-selector blur for tabs; Windows helper using
Windows.Graphics.Capture; Linux (X11 via ffmpeg, Wayland via the ScreenCast
portal, best effort); recordings that span two displays; audio.

**Non-goals:** driving the computer, cloud upload or sharing, video editing beyond
the listed clean-up commands, hiding the macOS recording indicator.

## 4. Architecture

```
 any agent / harness / human
   ├─ shell ──────────► CLI  `screenrec`            (Node, npm package)
   └─ MCP client ─────► MCP server (`screenrec mcp`, same package)
                               │ both call one core library
                               ▼
              ┌────────────────┼──────────────────┐
              ▼                ▼                  ▼
     capture/mac         capture/cdp           edit/ (ffmpeg)
     Swift helper        Chrome DevTools       squeeze, crop, blur,
     ScreenCaptureKit    Protocol screencast   trim, gif, frame
```

Units and their contracts:

- **`native/macos` (`screenrec-mac`)**: Swift executable. Subcommands `displays`,
  `windows`, `screenshot`, `record`. Speaks JSON lines on stdout; `record` stops
  cleanly on SIGINT or a `stop` line on stdin and writes a playable file. Must
  call `NSApplication.shared` before any ScreenCaptureKit call (spike finding).
  Built universal (x86_64 + arm64). Writes video with `SCStream` +
  `AVAssetWriter` on every supported macOS version (one code path;
  `SCRecordingOutput` is not used).
- **`src/capture/mac.ts`**: spawns the helper, parses its JSON, maps helper errors
  to CLI errors.
- **`src/capture/cdp/`** (client, endpoint, broker, worker): connects to a CDP endpoint with Node's built-in
  WebSocket, selects and follows tabs, receives screencast frames, writes them
  to ffmpeg at constant 30 fps.
- **`src/core/`**: target resolution, display geometry, state file and crash
  recovery, sidecar metadata, auto-stop timer.
- **`src/edit/`**: pure functions that build ffmpeg argument lists, plus a runner.
  Builders are unit-testable without ffmpeg.
- **`src/cli/`** and **`src/mcp/server.ts`**: thin front ends over `core` and
  `edit`. No logic of their own beyond argument mapping.

State: one active recording per user, in `~/.screenrec/state.json`. Output default
`./recordings/`, or `~/Movies/screenrec/` when the current folder is `/` or not
writable.

Requirements: Node 22+ (built-in WebSocket), ffmpeg on PATH (not bundled),
macOS 13+ for capture.

## 5. Commands

All CLI commands accept `--json`. MCP tools map one to one.

| CLI | MCP tool | Behaviour |
|---|---|---|
| `doctor` | `doctor` | Checks Screen Recording permission, ffmpeg, Chrome version, Chrome remote debugging availability; prints the exact fix for each failure |
| `list windows\|displays\|tabs` | `list_targets` | Lists targets with IDs |
| `start <target> [--out] [--fps 30] [--cursor] [--max 10m] [--no-meta]` | `record_start` | Starts one recording |
| `status` | `record_status` | Running or idle; target, elapsed, output path, and `targetState` (`hidden` or `visible`) for window and app recordings |
| `mark "<text>"` | `record_mark` | Appends a timestamped step note to the sidecar |
| `stop` | `record_stop` | Finalises `<name>.mp4` and `<name>.json`; MCP result also returns one downscaled preview frame |
| `screenshot <target>` | `screenshot` | One PNG |
| `squeeze <in> [--hold 0.5] [--out]` | `video_squeeze` | Shortens every still stretch to at most `--hold` seconds (default 0.5; `0` cuts it to one frame), so each screen stays readable; re-times sidecar step notes |
| `crop <in> --rect x,y,w,h \| --trim-edges N` | `video_crop` | Crop in output pixels; `--trim-edges` removes an N-pixel border |
| `blur <in> --box x,y,w,h[@t0-t1] \| --boxes file.json` | `video_blur` | Pixelate then blur; static or keyframed boxes |
| `trim <in> --from S --to S` | `video_trim` | Cut start and end |
| `gif <in> [--width 800] [--fps 12]` | `video_gif` | Two-pass palette GIF |
| `frame <in> --at S` | `video_frame` | One still frame, for measuring blur boxes |

Clean-up commands never overwrite their input. Default output name is
`<in>.<command>.mp4` (or `.gif`, `.png`).

An explicit `--out` (MCP `out`) that already exists, or whose `.json` sidecar would replace an existing file, is refused with `E_BAD_ARGS`; `--force` (MCP `force: true`) on `start`, `screenshot` and every clean-up command replaces it (for `start`, at `stop`, once a playable recording exists), but never the input or any alias of it (symlink, hard link, case variant). Outputs are written to a temp file next to `--out` and moved into place only on success, so a failed run never touches the old file; `--force` without `--out` is refused.

Safety defaults:

- Auto-stop after `--max` (default 10 minutes) so a forgotten `stop` cannot run
  forever.
- Crash recovery: if `state.json` points at a dead recorder, the next `start` or
  `status` finalises the partial file into a playable mp4 and reports it.

## 6. Targets

### 6.1 Windows (default)

`--window "App"`, `--window "App:title substring"`, `--window <id>`. Resolved to one
window ID at `start`, captured with `SCContentFilter(desktopIndependentWindow:)`.

- Output size fixed at start: window size in points times the backing scale of
  the display it is on.
- Moved to another display: keeps recording, rescaled to the fixed size.
- Resized: scaled to fit, aspect ratio preserved, padded.
- Hidden, minimized or closed: without Accessibility permission these look the
  same, so a window that stops being on screen is held (its last frame repeats)
  and a warning event "window is hidden, minimized or closed" is emitted;
  `status` reports `targetState: hidden`. Recording resumes when the window is
  back. It ends on `stop`, `--max`, the window leaving the OS window list, or
  the app quitting (stop reason `target-closed`).
- With `--follow-app`, when the current window goes off screen, the recording
  switches to the newest window of the followed apps that appeared after start
  and is on screen (a `switched` event and a step note); if there is none, it
  holds. Accessibility-based close detection is left for v2.

`--app Name` resolves to that app's front window at start, then behaves as
`--window`.

`--follow-app` (with `--window` or `--app`): when a new normal window appears
after `start` (for example Finder opening a file in Preview), switch to it, add a
step note, and continue in the same output, scaled to the fixed output size. When
the recorded window closes, switch to the newest window that appeared after
`start`, or stop if there is none. Following is driven by window creation, never
by focus, so the user clicking into their own apps does not move the recording.
Windows of apps listed in `--ignore-app` (default: the terminal or IDE that ran
`start`) are never followed. Without `--follow-app` the window rules above apply.

### 6.2 Displays and regions

- `list displays` shows ID, name, size in points, scale, origin, and `main`.
- `--display main | <index> | "<name substring>"`, or `--display-of <window>`
  (the display holding most of that window).
- `--region x,y,w,h --display <d>`: points relative to that display's top-left,
  converted with that display's own scale.
- One display per recording. A region crossing displays is an error.

### 6.3 Chrome tabs

`--tab newest | follow | url:<pattern> | title:<pattern>`, optional `--cdp <url>`.

Endpoint selection, first match wins:

1. `--cdp <url>` or `SCREENREC_CDP`: a test browser (Playwright, Puppeteer,
   chrome-devtools-mcp, a Chrome started with `--remote-debugging-port`).
2. The user's running Chrome 144+ with remote debugging enabled at
   `chrome://inspect#remote-debugging`. The user approves Chrome's permission
   dialog; Chrome shows its automation infobar while connected. Works with the
   user's normal profile, cookies and logins. Chrome asks on every new
   connection (verified 2026-10-17, 3 of 3), so this endpoint is always reached
   through the Chrome broker (section 6.6): one Allow per Chrome session, not
   per recording.
3. Otherwise: if the target tab is the active tab of its window, fall back to
   window capture with a warning that covering the window or switching tabs will
   freeze it; if not, fail with the `doctor` instructions for step 2.

Capture method: `Emulation.setFocusEmulationEnabled(true)`, `Page.startScreencast`
(PNG or JPEG at the tab's viewport size times device pixel ratio), ack every
frame, stamp each with its arrival time, feed ffmpeg at a constant 30 fps by
holding the previous frame. On stop or crash, disable focus emulation and stop
the screencast.

Tab selection:

- `newest`: the newest page target created after `start`.
- `url:` / `title:`: first matching page target.
- `follow`: start on `newest`, switch when the agent creates or activates another
  tab, write a step note at each switch, join into one output. When the followed
  tab closes, hold the last frame until another tab appears or `stop`.
- `newest` and `follow` only ever choose tabs created after `start`. Any tab
  created after `start` counts, including one the user opens by hand during the
  recording (documented limitation; an opener or tab-group rule is v2).

Claude in Chrome draws its pointer, an edge glow and a "Claude is active in this
tab group" label inside the page, so tab capture includes them (verified
2026-10-17); `crop --trim-edges` removes the glow, the label stays.

Other browsers: Chromium browsers via endpoint 1 (endpoint 2 unverified for Edge
and Brave). Firefox and Safari: window capture only.

### 6.4 Window capture of Chrome

Chrome freezes occluded windows. `doctor` explains the two remedies: keep the
agent's window uncovered (for example on a second display), or relaunch Chrome
with `--disable-backgrounding-occluded-windows`. A `chrome relaunch
--keep-drawing` helper is in scope only if the first build task confirms the flag
works on the default profile.

### 6.5 First build task (gates the Chrome design)

Before building on them, verify on a real machine:

1. Endpoint 2 against the user's normal profile, and whether the permission
   dialog appears once per connection or once per session.
2. A CDP screencast session coexisting with Claude in Chrome on the same tab.
3. Reliable discovery of the endpoint-2 connection (the `DevToolsActivePort` file
   in the Chrome user data directory, or another mechanism).
4. The occlusion flag on the default profile.

If 1 or 2 fails, the extension (level C: `chrome.debugger` from inside the
browser, any profile, one-time install) moves into v1 and this spec is amended.

Results (2026-10-17, Chrome 155, macOS 26.7.1, details in `docs/TESTED.md`):
1 PASS, with a permission dialog on every new connection; 2 PASS (raw CDP and
Chrome DevTools MCP both recorded a tab while Claude in Chrome scrolled it, no
errors on either side); 3 PASS (`DevToolsActivePort`); 4 pending. The extension
stays in v2. The per-connection dialog led to the broker (6.6).

### 6.6 Chrome broker and the Chrome DevTools MCP route

**Broker.** A background process, `screenrec chrome-broker`, holds the single
connection to the user's Chrome (endpoint 2) and serves it to screenrec's tab
workers, so the user clicks Allow once per Chrome session.

- Started on demand by the first tab recording or `list tabs` that resolves to
  endpoint 2; later commands reuse it. Endpoints 1 (`--cdp`, `SCREENREC_CDP`)
  never use the broker.
- It is a CDP proxy: a WebSocket server on `127.0.0.1` with a random port and a
  random path token, recorded in `$SCREENREC_HOME/chrome-broker.json` (mode
  0600). It forwards each client's messages upstream with remapped ids, routes
  responses by id and session events by the `sessionId` the client attached,
  and broadcasts browser-level `Target.*` events. A client's sessions are
  detached when the client disconnects. Workers connect to it exactly as they
  would to Chrome, so the worker code does not change.
- It forwards only the CDP calls screenrec itself makes (target discovery and
  attach, screencast, screenshot, focus emulation, and `Runtime.evaluate` of
  `devicePixelRatio` and `document.visibilityState`); every other method is
  refused with -32601 before Chrome sees it. The broker skips Chrome's Allow
  dialog, so its token must never grant the whole browser (security review,
  2026-10-21).
- It exits when Chrome closes the connection, when Chrome quits, or after
  30 minutes with no client (`SCREENREC_BROKER_IDLE`). A crashed broker is
  detected by pid and command line and replaced on next use (one more Allow).
- `screenrec chrome-broker status | stop` for the user; `doctor` reports it.

**Chrome DevTools MCP route.** Agents that already run Google's
`chrome-devtools-mcp` (with `--autoConnect`, which also holds one connection per
session) may record a tab with its `screencast_start` / `screencast_stop` tools
and then use screenrec for clean-up. Verified 2026-10-17 with version 1.11.0: it
records a hidden background tab live, writes AV1 `.mp4` at device pixel size and
a variable frame rate, keeps the user's selected page, and coexists with Claude
in Chrome. screenrec integrates the route without depending on it:

- Every clean-up command accepts its output (AV1, variable frame rate) and
  re-encodes to H.264.
- `screenrec doctor` detects a `chrome-devtools-mcp` entry in the agent's MCP
  configuration it can read and says which route is active.
- The plugin skill and `AGENTS.snippet.md` tell the agent: if
  `screencast_start` is available, use it for tab recordings, then
  `video_squeeze` and the other clean-up tools; otherwise use `record_start
  --tab`. They also tell the agent to start `chrome-devtools-mcp` with
  `--no-usage-statistics --no-performance-crux` (it sends usage statistics to
  Google by default) and that it can see every tab of the profile.
- It lacks follow mode, step notes and auto-stop; the skill says so.

## 7. Privacy

- No network access except the local CDP endpoint on `127.0.0.1`. No telemetry,
  no update checks. Enforced by a test that fails on any non-loopback network
  call in `src/`.
- Window and tab are the defaults. `--display` prints a warning that
  notifications and all other windows on that display will be captured and
  suggests a Focus mode.
- Cursor hidden unless `--cursor`.
- Blur pixelates first, then blurs, so text cannot be recovered by deblurring.
  Keyframed box format:
  ```json
  [{ "w": 300, "h": 40, "keyframes": [{ "t": 2.0, "x": 40, "y": 600 }, { "t": 4.5, "x": 40, "y": 120 }] }]
  ```
  Positions interpolate linearly between keyframes. Without `from`/`to`, a
  keyframed box stays on for the whole video: before its first keyframe it holds
  the first position, after its last it holds the last (blurring more is the
  safe choice for privacy). With `from`/`to` it is on only in that window. A box
  whose window starts at or after the end of the video (within
  `max(1/fps, 0.1 s)`) is refused, so blur never succeeds with nothing blurred.
- `./recordings/` is created with a `.gitignore` containing `*`. When the current
  folder is `/` or not writable (an MCP server started by a desktop app often runs
  in `/`), default outputs go to `~/Movies/screenrec/` instead, created without a
  `.gitignore`. Clean-up outputs keep their derived name next to the input; only an
  input in an unwritable folder sends that name to the default folder.
- The folder of an explicit `--out` (MCP `out`) must exist, on every command
  including `start`: a missing folder, or a file in the path, is `E_BAD_ARGS`
  (`folder does not exist: <dir>` or `not a folder: <file>`). Only the default
  folder is created.
- The sidecar records window titles, URLs and step notes; documented as sensitive;
  `--no-meta` skips it.
- The macOS recording indicator is never hidden. MCP tool descriptions instruct
  the agent to say in chat when it starts and stops recording.

## 8. Agent integration

- **MCP server**: `screenrec mcp` (stdio). Tools as in section 5.
- **Claude Code plugin** (`plugin/`): `.claude-plugin/plugin.json`, `.mcp.json`
  pointing at `screenrec mcp`, and a skill `screen-record` that tells the agent:
  start before acting, prefer window or tab targets, add step notes, stop, then
  squeeze, and offer GIF export.
- **Codex and other harnesses**: `agents/AGENTS.snippet.md` with the same guidance
  for CLI use.
- Claude in Chrome cannot run commands; its recordings are started by Claude Code
  or Claude Desktop running alongside it.
- Chrome DevTools MCP is a supported second route for tab recording (6.6).

## 9. Error handling

- Every failure maps to a stable error code (`E_PERMISSION`, `E_NO_FFMPEG`,
  `E_TARGET_NOT_FOUND`, `E_TARGET_AMBIGUOUS`, `E_ALREADY_RECORDING`,
  `E_NOT_RECORDING`, `E_CDP_UNAVAILABLE`, `E_REGION_SPANS_DISPLAYS`,
  `E_HELPER_CRASHED`) plus a one-line fix. `--json` returns
  `{ "ok": false, "code": ..., "message": ..., "fix": ... }`.
- Ambiguous targets list the candidates instead of guessing.
- Helper or ffmpeg crash during recording: crash recovery (section 5) applies.

## 10. Testing

Assertions use bounds, not equality. v1 has no hosted CI: suites 1 to 4 and
the clean room run locally on macOS before each merge and release. Running
them in CI on macOS and Linux is planned after v1.

1. **Unit** (`node:test`): target matching; display geometry with the spike's
   real two-display layout as a fixture (2x at 0,0; 1x at -1920,-180); keyframe
   interpolation; ffmpeg argument builders; state and recovery; sidecar
   re-timing after squeeze.
2. **Video**: synthetic inputs from ffmpeg `testsrc` with known frozen spans;
   squeeze duration within bounds; blurred box loses detail while outside pixels
   are unchanged; crop and trim dimensions; GIF size cap.
3. **Chrome** (Chrome for Testing): a test page cycles a solid colour every
   500 ms; each hidden-tab, `newest` and `follow` (open, switch, close) capture
   of 3 s must contain at least 4 distinct colours, which also detects freezing.
  
4. **MCP protocol**: an MCP SDK client lists and calls every tool against a fake
   capture backend.
5. **macOS real-machine matrix** (`npm run test:mac`, needs Screen Recording
   permission, not CI): covered Finder, Safari and Chrome; window moved between
   displays; minimized; other Space; full screen; `display notification` fired
   during a window capture must not appear; endpoint 2 on the normal profile;
   coexistence with Claude in Chrome; monitor unplugged (manual step). Each run
   writes `docs/TESTED.md` with date, machine and evidence frames. Apple silicon
   stays "unverified" there until run on one.
6. **Clean room** before each release: `npm pack`, install into an empty
   directory, run the README examples exactly as written.

## 11. Repository layout

```
package.json  tsconfig.json  LICENSE  README.md  CONTRIBUTING.md  SECURITY.md
src/cli/       args.ts, main.ts
src/commands/  one file per command
src/mcp/       server.ts
src/core/      targets, displays, state, sidecar, paths, platform
src/capture/   mac.ts, supervise.ts, supervisor.ts, cdp/ (client, endpoint, broker, worker)
src/edit/      squeeze, crop, blur, trim, gif, frame
native/macos/  Swift package for screenrec-mac
plugin/        Claude Code plugin (skill + MCP config)
agents/AGENTS.snippet.md
test/unit  test/video  test/chrome  test/mcp  test/mac-matrix  test/cleanroom
examples/      record-finder.sh, record-chrome-tab.sh, blur-boxes.json
docs/specs/    this file
docs/TESTED.md
```

TypeScript compiled with `tsc`. Runtime dependencies: `@modelcontextprotocol/sdk`
and `zod` (both MIT). README demo GIF is recorded with the tool itself.

## 12. Licence and publishing

- Licence: **MIT**. ffmpeg is a user-installed prerequisite and is not
  redistributed. No code is copied from the private prototype or from the
  related projects listed in the research notes.
- Nothing is pushed to GitHub or published to npm, and no GitHub repository is
  created, without explicit approval.

## 13. Cross-platform outlook

| Platform | Window capture of covered windows | Plan |
|---|---|---|
| macOS | ScreenCaptureKit: verified | v1 |
| Windows | Windows.Graphics.Capture: reported to work, unverified; ffmpeg has no WGC input (trac 9413) | Separate native helper, after v1 |
| Linux X11 | ffmpeg `x11grab` for screen and region; covered windows unreliable | Best effort |
| Linux Wayland | ScreenCast portal with a user prompt; restore tokens unreliable on some backends | Best effort |

The clean-up commands are plain Node and ffmpeg, so they should run on Windows
and Linux (unverified). Chrome tab capture may work on Linux (unverified). On
Windows, every recording and the Chrome broker are refused with
`E_UNSUPPORTED_PLATFORM` in v1, because process liveness relies on POSIX tools.
Window, app, display and region capture are macOS-only in v1.

## 14. Amendments (24 Oct 2026)

Changes made during the build and review, each decided with the user:

- `--force`: an explicit `--out` that names an existing file is refused unless
  `--force` is given; `--force` never replaces the input or its sidecar.
  Outputs are written to a temporary file and moved into place only on success.
- An explicit `--out` must be in an existing folder, for every command.
- Default outputs go to `./recordings/` (created private to the user, with a
  `.gitignore`), or to `~/Movies/screenrec/` (created 0700) when the current
  folder is `/` or not writable.
- The Chrome broker forwards only the CDP methods screenrec itself uses.
- `squeeze --hold` defaults to 0.5 s; `--hold 0` cuts each still stretch to one
  frame.
- Section 6.1: hidden, minimized and closed windows are held with a warning
  (see 6.1); `status` reports `targetState`.
- Section 7: keyframed blur boxes are held over the whole video.
- Section 10: no hosted CI in v1.

### Amendments (27 Oct 2026)

- `status` (and `record_status`) reports `screen`: `locked`, `asleep` or
  `off-console` while the Mac screen is not drawn, with a warning in `text`.
  The field is absent while the screen is awake.
- The mac helper writes automatic marks when the screen stops being drawn and
  when it comes back ("screen locked", "screen unlocked", "displays asleep",
  "displays awake", "another user session took the screen", "back on this user
  session"), on the recording clock like other marks. The sidecar stays
  version 1; only marks are added. `stop` gives `warnings` with the length and
  position of each frozen or blank stretch, counted from the helper's `screen`
  log events (not from mark text, so a step note cannot fake a lock); a stretch
  under 1.5 s is not reported.
- While a mac recording runs, `screenshot` and window listings are answered by
  the recorder process itself (`record --requests`), each within 20 s. The
  recorder writes a requested PNG only into its 0700 request folder, as a new
  file; Node moves it into place under the usual output rules. A second helper process
  that used ScreenCaptureKit and quit stopped the recorder's stream on
  macOS 26.7, which froze the recording and left the screenshot without a frame.

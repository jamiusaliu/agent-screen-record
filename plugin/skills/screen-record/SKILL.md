---
name: screen-record
description: This skill should be used when the user asks to "record this", "screen-record", "record what you do", "make a video or GIF of", "make a gif of what you did", "show me the bug", "record yourself reproducing this bug", "visit this link and record it", "record the tab I have open in Chrome", or "open the file in my Downloads and record the whole navigation", in any app, in Finder or in a Chrome tab. It covers screen, window and Chrome tab capture with the screenrec MCP tools and the Chrome DevTools MCP screencast route; it is not for audio recording or recording meetings.
---

# Screen record

screenrec records one target locally (nothing is uploaded) and cleans the result up. It is macOS only (v1). It never drives the computer: do the work with the usual tools while it watches. A global install (`npm i -g agent-screen-record`) makes the first start faster than the plugin's npx default.

Always tell the user in chat when recording starts, what it captures, and when it stops.

## Workflow

1. If unsure it will work, call `doctor` and relay any fix to the user.
2. Start BEFORE acting, with the narrowest target (window or tab over display):
   - One app window: `record_start` with `window` ("Finder", "Finder:Downloads") or `app`.
   - Work that opens other apps (Finder opening Preview or QuickTime): add `follow_app: true` (it needs window or app). Following is driven by new windows, not focus.
   - Chrome, including tabs opened in the background: `tab: "newest"`, or `tab: "follow"` when several tabs are used (both only pick tabs created after start). An existing tab: `tab: "url:<part>"` or `tab: "title:<part>"` (find it with `list_targets` kind tabs).
   - `display` only when the task truly spans the screen (see Privacy).
3. Do the task. After each meaningful step call `record_mark` with a short note ("opened Downloads"). From the CLI, a note starting with "-" is written `screenrec mark -- "-x"`.
4. Call `record_stop`. Check the returned preview frame; if it shows the wrong thing, say so and offer to redo it. A `recovered` result means an earlier crashed recording was saved: report its path.
5. Clean up in this order, each step on the previous step's output (the input is always kept): squeeze, crop, trim, then measure with `video_frame`, then `video_blur`, then `video_gif` from the last file. Blur boxes are output pixels of the file being blurred, so measure on that file.
   An `out` that already exists is refused (E_BAD_ARGS); pick another path, omit `out`, or pass `force: true` only when the user wants that file replaced. `force` never replaces the input.
   - `video_squeeze` removes waiting and idle time. Run it on every recording (`hold: 0` for the fastest cut; default keeps each still screen 0.5 s).
   - `video_crop` with `trim_edges: 8` removes the orange edge glow that Claude in Chrome draws inside the page. Its "Claude is active" label stays.
   - `video_trim` cuts a slow start or end.
6. Offer a GIF: `video_gif` (width 800 is a good default).
7. Give the user the final file paths.

Recordings auto-stop after 10 minutes (`max`). Only one recording runs at a time: make one record_* call at a time and wait for it. `record_start` on a tab can wait up to about 2.5 minutes for the user to click Allow in Chrome; if your client times out first, call `record_status` before starting again. Paths are absolute or start with ~/.

## Privacy

- Use the narrowest target. A `display`, `display_of` or `region` captures notifications and all other windows on that display: warn the user and suggest a Focus mode.
- Before sharing, check frames with `video_frame` and blur emails, tokens, names and logged-in pages with `video_blur`. Blur before making the GIF. A box with no from/to covers the whole video; a keyframed box without from/to is held at its first keyframe before it and its last after it; a box whose window starts at or after the end, or in the last frame interval (at least the last 0.1 s), is refused (E_BAD_ARGS), so check the duration first.
- `list_targets` with kind tabs returns the title and URL of every tab in the user's Chrome profile; use it only when the user asked to record an existing tab.
- The JSON sidecar holds window titles, URLs and step notes, so it is sensitive: keep secrets out of marks, and pass `no_meta: true` to skip it.
- The macOS recording indicator is always shown; never try to hide it.
- Default outputs go to ./recordings (created with a .gitignore, so recordings stay out of git), or to ~/Movies/screenrec/ when the server runs in / or an unwritable folder. Clean-up outputs go next to their input, or to the default folder when the input's folder is not writable. An explicit `out` must be in an existing folder.

## Recipes

**"Visit https://example.com, look around, and record it."**
`record_start` `{ "tab": "newest" }`, then open the link in a new Chrome tab, scroll and click with a `record_mark` per step, `record_stop`, `video_squeeze`, and `video_crop` `trim_edges: 8` if Claude in Chrome drove the tab. Offer `video_gif`.

**"I have a tab open in Chrome. Record it."**
`list_targets` `{ "kind": "tabs" }` to find it, then `record_start` `{ "tab": "url:github.com/org/repo" }` (or `title:`). It records the user's own logged-in tab even while hidden. Chrome asks the user to click Allow once per Chrome session; say so before starting.

**"There is a GIF, a .mov or a picture in my Downloads. Open it and record the whole navigation, as a human would, until the file is open."**
Make sure a Finder window exists (open one if not), then `record_start` `{ "app": "Finder", "follow_app": true }`. Navigate to Downloads in that window, select the file and open it. The recording follows into Preview or QuickTime. Wait until the file is visibly open, `record_mark` "file open", `record_stop`, `video_squeeze`.

**"Record yourself reproducing this bug" / "show me the bug".**
`record_start` on the app's window (or its tab), reproduce step by step with a `record_mark` each, `record_stop`, `video_squeeze`, offer `video_gif`.

## Chrome: two routes

Pick one per tab recording, and do not mix routes in one Chrome session.

**Route A, Chrome DevTools MCP.** If a `screencast_start` tool (from Google's chrome-devtools-mcp) is available, use `screencast_start` and `screencast_stop` for tab recordings, confirm the file with `video_frame`, then the screenrec clean-up tools above (they accept its AV1, variable frame rate mp4 and write H.264).
- Ask the user to run chrome-devtools-mcp with `--autoConnect --no-usage-statistics --no-performance-crux`; without the last two flags it sends usage statistics to Google.
- Warn the user it can see every tab of the Chrome profile, not only the recorded one.
- It lacks follow mode, step notes and auto-stop: keep a list of steps in chat and always call `screencast_stop`.

**Route B, screenrec.** Otherwise use `record_start` with `tab` as above. It has follow mode, step notes and auto-stop.

In either route the user clicks Allow in Chrome once per Chrome session (remote debugging must be enabled at chrome://inspect/#remote-debugging; `doctor` reports it and which route is configured).

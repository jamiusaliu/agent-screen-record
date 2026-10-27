# Tested

Every claim about real-machine behaviour lives here with date, machine and evidence.

## Chrome gate (spec 6.5)

Date: 2026-10-17. Machine: Intel x86_64 Mac, macOS 26.7.1, Chrome 155.0.8059.80.

| Check | Result | Evidence |
|---|---|---|
| 1. Endpoint 2 on normal profile | PASS; dialog: once per connection | `probe.mjs` on the normal profile, three runs: `{"frames":6,"distinctColours":5}` in 9 s, `{"frames":9,"distinctColours":9}` in 7 s, `{"frames":9,"distinctColours":9}` in 20 s. Chrome showed the Allow dialog on every new connection; the user clicked Allow on all three. |
| 2. Coexists with Claude in Chrome | PASS | Raw CDP screencast (the worker's method) and chrome-devtools-mcp 1.11.0 each recorded a tab while Claude in Chrome scrolled it (raw CDP: 1490 frames, scrollY 0 to 6498, Section 1 to Section 10; MCP: 84 s mp4, 2221 frames, colours walk Section 1 to Section 10). No errors, no detaches on either side. Claude in Chrome's in-page overlay (edge glow, "Claude is active in this tab group" label, pointer) is captured in both recordings. User confirmed. |
| 3. Endpoint discovery | DevToolsActivePort | Present in `~/Library/Application Support/Google/Chrome/DevToolsActivePort`: line 1 `9222`, line 2 `/devtools/browser/<uuid>` (uuid redacted). |
| 4. Occlusion flag, default profile | MANUAL-PASS with the flag; KNOWN-LIMIT without | Checked 2026-10-22 with the user, see "Chrome checks with the user" below: a fully covered Chrome window gave 8 distinct colours with `--disable-backgrounding-occluded-windows` and 1 colour (frozen) without it. Evidence: recordings/chrome/covered-flag.mp4, covered-noflag.mp4 (local). |

Decision: PASS for building Tasks 15-18. The per-connection dialog led to the Chrome broker (spec 6.6, Task 26).

### Chrome DevTools MCP

- Version 1.11.0 with `--autoConnect`: one Allow per MCP session (the user confirmed one prompt for two recordings).
- A hidden background tab was recorded live (the centre colour changed every 0.5 s).
- Output: AV1 `.mp4`, 2880x1444, variable frame rate.
- Usage statistics are sent to Google by default (`--no-usage-statistics` turns them off).

## Matrix 2026-10-22

Machine: MacBookPro16,2 (x86_64), macOS 26.7.1, Built-in Retina Display 1440x900 pt @2x + LG FULL HD 1920x1080 pt @1x. Evidence: recordings/matrix-2026-10-22/ (local, not committed). The date in this heading and in the evidence folder names (matrix-2026-10-22, matrix-2026-10-23) is the UTC date, so a run late in the local evening lands in the next day's folder. Run with `npm run test:mac -- --auto-only` by the QA hire; PENDING rows are run by the coordinator with the user. Windows used: TextEdit documents opened from fixtures in a temp folder, two Finder windows on harness-made folders under recordings/ (SRM-FOLLOW, SRM-HIDDEN), and Preview for the generated image.

Intermittent: three scenarios in a row on the first run (about 30 s) failed with `E_TARGET_NOT_FOUND` "No displays are available" at start or `E_NO_FRAMES` at stop, with the screen unlocked and awake (pmset shows no display sleep). All three passed on rerun. Not yet reproduced.

| Scenario | Result | Note | Evidence |
|---|---|---|---|
| window on main display (Built-in Retina Display) | PASS | 6 colours; 1200x1000 (want 1200x1000) | window-main.mp4, window-main-1.5s.png |
| app on main display (Built-in Retina Display) | PASS | 6 colours; 1200x1000 (want 1200x1000) | app-main.mp4, app-main-1.5s.png |
| display main (Built-in Retina Display) | PASS | 5 colours at the window centre; 2880x1800 (want 2880x1800) | display-main.mp4, display-main-1.5s.png |
| region with odd point size on main display (Built-in Retina Display) | PASS | 5 colours; 666x402 (want 666x402) | region-main.mp4, region-main-1.5s.png |
| display-of a window on main display (Built-in Retina Display) | PASS | 5 colours at the window centre; 2880x1800 (want 2880x1800) | display-of-main.mp4, display-of-main-1.5s.png |
| window on external display (LG FULL HD) | PASS | 6 colours; 600x500 (want 600x500) | window-external.mp4, window-external-1.5s.png |
| app on external display (LG FULL HD) | PASS | 4 colours; 600x500 (want 600x500) | app-external.mp4, app-external-1.5s.png |
| display 2 (LG FULL HD) | PASS | 5 colours at the window centre; 1920x1080 (want 1920x1080) | display-external.mp4, display-external-1.5s.png |
| region with odd point size on external display (LG FULL HD) | PASS | 5 colours; 332x200 (want 332x200) | region-external.mp4, region-external-1.5s.png |
| display-of a window on external display (LG FULL HD) | PASS (rerun) | Rerun: 3 colours at the window centre; 1920x1080 (want 1920x1080). First run FAIL: start returned E_TARGET_NOT_FOUND "No displays are available (is the screen locked or asleep?)" with the screen unlocked and awake; intermittent, see the note below. | display-of-external.mp4, display-of-external-1.5s.png |
| covered TextEdit window keeps updating | PASS (rerun) | Rerun: 6 colours while covered; frame shows the target window only. First run FAIL: stop returned E_NO_FRAMES (same intermittent window as the row above). | covered.mp4, covered-1.5s.png |
| covered Finder window, folder changes while hidden | PASS | Run by the coordinator on 2026-10-22 under `caffeinate -d`. A harness-made Finder window on recordings/SRM-HIDDEN, covered by its own TextEdit fixture (cover {0, 30, 1440, 900} contains Finder {200, 150, 800, 650}), while 12 files and a folder were added with fs. Baseline diff 0.02 (0.5 s vs 1.8 s, must be < 1); change diff 4.69 (1.8 s vs end, must be > 3 and > 3x baseline). | finder-covered.mp4, finder-covered-0.5s.png, finder-covered-1.8s.png, finder-covered-5.9s.png |
| window moved main to external mid-recording | PASS (rerun) | Rerun: 3 colours after the move; 1200x1000. First run FAIL: stop returned E_NO_FRAMES (same intermittent window). | moved-m2e.mp4, moved-m2e-1.0s.png, moved-m2e-6.5s.png |
| window moved external to main mid-recording | PASS (rerun) | Rerun: 3 colours after the move, 600x500 as expected. First run: 4 colours but encoded 540x450, where 600x500 was expected (600x500 pt window starting on the 1x display). Unexplained and not reproduced: screenrec picks the size at start, and the harness had already set the window bounds. Possible product issue (owner: mac capture). The scenario now fails on a wrong size. | moved-e2m.mp4, moved-e2m-1.0s.png, moved-e2m-6.5s.png |
| minimized then restored | PASS | still recording while minimized: true; 2 colours after restore | minimized.mp4, minimized-7.8s.png |
| target window closed before stop | PASS | stop finalised 4.08 s, reason stopped | closed.mp4 |
| multi-display: region crossing the display edge is refused | PASS | E_REGION_SPANS_DISPLAYS: Regions are measured in points from the top-left of the chosen display and must stay inside it. |  |
| multi-display: display chosen by name records that display only | PASS | --display LG: 1920x1080 (want 1920x1080), 5 colours | display-by-name.mp4 |
| notification: window capture vs display capture | INCONCLUSIVE | Window capture unchanged (diff 0.01). Rerun on 2026-10-22 with Focus off: 11 frames over 5.5 s of the main display show no banner, but the user is not sure a banner was drawn (the notifications reached Notification Center). Exclusion is still unproven on this Mac. | notify-window.mp4, notify-display.mp4 (matrix-2026-10-23) |
| follow-app: Finder to Preview | PASS | Rerun on 2026-10-22 after the user allowed Automation for Preview, with the image opened by `open -a Preview` from a gitignored folder (Finder scripting was refused with "(null) does not have permission"). Mark: "switched to Preview: screenrec-test.png". | follow-app.mp4 |
| Covered Chrome window without the occlusion flag | KNOWN-LIMIT | Done 2026-10-22 with the user: 1 colour (frozen); see "Chrome checks with the user" below. | recordings/chrome/covered-noflag.mp4 |
| Chrome gate check 4: occlusion flag on the default profile | MANUAL-PASS | Done 2026-10-22 with the user: 8 colours with the flag, window fully covered; see "Chrome checks with the user" below. | recordings/chrome/covered-flag.mp4 |
| Hidden Chrome tab in the normal profile (level B) | MANUAL-PASS | Done 2026-10-22 with the user: 8 colours from a background tab; see "Chrome checks with the user" below. | recordings/chrome/hidden-tab.mp4 |
| Chrome broker Allow dialog | MANUAL-PASS | Done 2026-10-22 with the user: one Allow for several recordings; see "Chrome checks with the user" below. | recordings/chrome/broker-1.mp4, broker-2.mp4 |
| Headed Chrome checks | PENDING | manual: Run the headed checks from the Chrome tasks (npm run test:chrome with a visible Chrome). Did they pass? |  |
| Claude in Chrome alongside | PENDING | manual: Run a Claude in Chrome task while "screenrec start --tab follow" records. Did both work? |  |
| Covered Safari window stays live | PENDING | manual: Open the colour page in Safari, cover it, run "screenrec start --window 'Safari:SCREENREC COLOUR'", wait 6 s, stop. Did the colour keep changing (throttled is fine)? |  |
| Window on another Space | PENDING | manual: Start --window on a window in another Space, switch Spaces twice, stop. Did the video show the window throughout? |  |
| Full-screen app | PENDING | manual: Start --app on an app in full-screen mode, interact, stop. Was the content recorded? |  |
| Monitor unplugged | PENDING | manual: Start --window on a window on the external display, unplug it, wait 3 s, stop. Was a playable file saved? |  |

### Chrome checks with the user (2026-10-22, Chrome 156.0.8078.47, normal profile)

| Check | Result | Note | Evidence (recordings/chrome/, local) |
|---|---|---|---|
| Broker: one Allow for several recordings | MANUAL-PASS | The first `start --tab newest` showed "Waiting for you to click Allow"; the user clicked Allow once. The second recording started in 1 s with no warning, and a third (hidden tab) also needed no Allow. The user confirmed exactly one dialog. Both broker recordings: 9 distinct colours. | broker-1.mp4, broker-2.mp4 (+ .json) |
| Hidden Chrome tab, normal profile (level B) | MANUAL-PASS | `start --tab url:colour-page` while the user viewed another tab: 5.4 s, 8 distinct colours. | hidden-tab.mp4 (+ .json) |
| Broker exits when Chrome quits | PASS | After the user quit Chrome, `chrome-broker status` reported not running. | console only (`chrome-broker status`) |
| Covered Chrome window, no flag | KNOWN-LIMIT | `--window "Google Chrome:SCREENREC COLOUR"` on a fully covered window: 6.4 s, 1 colour (frozen). doctor already warns. | covered-noflag.mp4 (+ .json) |
| Chrome gate check 4: `--disable-backgrounding-occluded-windows` | MANUAL-PASS | Chrome relaunched by the coordinator with the flag (verified in its command line). Colour window fully covered by a larger Help window (the user confirmed, with a screenshot): 6.4 s, 8 distinct colours. SCK reported the window onScreen=true while covered, so onScreen does not indicate occlusion. | covered-flag.mp4 (+ .json) |

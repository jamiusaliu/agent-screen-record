## Screen recording (screenrec)

macOS only (v1). Needs Node 22+ and ffmpeg (`brew install ffmpeg`). Install with `npm i -g agent-screen-record` (the command is `screenrec`), or run any command as `npx -y agent-screen-record@0.1.0 <cmd>` (pinned to a release, so agents never run whatever npm serves as latest).

To record what you do, use the `screenrec` CLI. It records locally; nothing is uploaded. Tell the user in chat when you start and stop recording and what it captures. It only watches: do the work with your usual tools.

1. `screenrec doctor` if unsure it will work; relay any fix to the user.
2. Start BEFORE acting, with the narrowest target (window or tab over display):
   - `screenrec start --window "Finder:Downloads"` or `screenrec start --app Safari`
   - add `--follow-app` (it needs --window or --app) when the work opens other apps (Finder opening Preview or QuickTime)
   - `screenrec start --tab newest` (or `--tab follow` for several tabs; both only pick tabs created after start) for Chrome, including background tabs; `--tab url:<part>` or `--tab title:<part>` for an existing tab (`screenrec list tabs`)
   - `screenrec start --display main` only when the whole screen is needed (see Privacy)
3. After each step: `screenrec mark "what you just did"`. Text starting with a dash: `screenrec mark -- "-x"`.
4. `screenrec stop --json` prints the saved mp4 path. Recordings auto-stop after 10 minutes (`--max`).
5. Clean up in this order, each step on the previous output (input kept): squeeze, crop, trim, then measure with `screenrec frame <file> --at <seconds>`, then blur, then gif from the last file. Blur boxes are output pixels of the file being blurred.
   An `--out` that already exists is refused; pick another path, omit `--out`, or add `--force` only when the user wants that file replaced. `--force` never replaces the input.
   - `screenrec squeeze <file>` always (`--hold 0` for the fastest cut; default keeps each still screen 0.5 s)
   - `screenrec crop <file> --trim-edges 8` removes Claude in Chrome's orange edge glow
   - `screenrec trim <file> --from S --to S`
   - `screenrec blur <file> --box x,y,w,h` for private data
   - `screenrec gif <file> --width 800`: offer it
6. Give the user the final paths.

Privacy:

- Use the narrowest target. `--display`, `--display-of` and `--region` capture notifications and all other windows on that display: warn the user and suggest a Focus mode.
- Before sharing, check frames with `screenrec frame` and blur emails, tokens, names and logged-in pages. Blur before making the gif.
- The `.json` sidecar holds window titles, URLs and step notes, so it is sensitive: keep secrets out of marks; `--no-meta` skips it.
- The macOS recording indicator is always shown.
- Default outputs go to ./recordings (created with a .gitignore), or to ~/Movies/screenrec/ when the current folder is / or not writable. Clean-up outputs go next to their input, or to the default folder when the input's folder is not writable. An explicit `--out` must be in an existing folder.

Recipes:

- "Visit this link and record it": `screenrec start --tab newest`, open the link in a new Chrome tab, mark each step, stop, squeeze, offer a GIF.
- "Record the tab I have open in Chrome": `screenrec list tabs`, then `screenrec start --tab url:<part of its url>`.
- "Open the GIF, .mov or picture in my Downloads and record the whole navigation until the file is open": with a Finder window open, `screenrec start --app Finder --follow-app`, navigate to Downloads, open the file; the recording follows into Preview or QuickTime. Stop once the file is visibly open, then squeeze.
- "Record yourself reproducing this bug": `screenrec start --window "<App>"`, reproduce with a mark per step, stop, squeeze, offer a GIF.

Chrome has two routes; do not mix routes in one Chrome session:

- If the Chrome DevTools MCP server (chrome-devtools-mcp) is configured and its `screencast_start` tool is available, record tabs with `screencast_start` / `screencast_stop`, confirm the file with `screenrec frame`, then clean up with `screenrec squeeze`, `crop`, `trim`, `blur` and `gif` (they accept its AV1, variable frame rate mp4). Start chrome-devtools-mcp with `--autoConnect --no-usage-statistics --no-performance-crux` (by default it sends usage statistics to Google). Warn the user it can see every tab of the Chrome profile. It lacks follow mode, step notes and auto-stop, so always stop it yourself.
- Otherwise use `screenrec start --tab ...`.

In either route the user clicks Allow in Chrome once per Chrome session; remote debugging must be on at chrome://inspect/#remote-debugging.

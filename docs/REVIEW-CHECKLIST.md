# Review checklist (applied to every merge)

Security and privacy. The tests named here run in `npm test` (test/security and test/unit).

## Network

- [ ] No network access except loopback CDP: the endpoint fetch (`capture/cdp/endpoint.ts`), the CDP client (`capture/cdp/client.ts`) and the Chrome broker (`capture/cdp/broker.ts`, `capture/cdp/ws-server.ts`). `test/security/no-network.test.ts` passes, and every allow-list entry has a one-line reason.
- [ ] Every `fetch` and `WebSocket` is preceded by `assertLoopback`, and so is a discovered `webSocketDebuggerUrl`. `fetch` refuses redirects.
- [ ] Every `listen()` binds the literal `'127.0.0.1'`: never `0.0.0.0`, `::`, a variable or an omitted host.
- [ ] No telemetry, no update checks, no new network module or client (`undici`, `XMLHttpRequest`, `EventSource`) in `src/`.
- [ ] ffmpeg and ffprobe get only absolute local paths (`localPath` in `src/edit/output.ts`). `runFfmpeg` and `probe` refuse any `word:` argument, so no `tcp:`, `rtmp:`, `http:`, `pipe:` or `concat:` path can reach them (`test/security/ffmpeg-paths.test.ts`).

## Chrome broker

- [ ] The path token is 256 random bits, compared in constant time (`tokenMatches`), and never printed, logged or put in argv. Child processes get their config on stdin (`test/security/broker-token.test.ts`).
- [ ] The Host allow-list (DNS rebinding) and the Origin check (web pages) both run before the WebSocket upgrade.
- [ ] `chrome-broker.json` is written 0600 in a 0700 folder.
- [ ] The broker forwards only the CDP calls screenrec makes (`brokerAllows`, broker rule 9). A new CDP call in a worker or command needs an allow-list entry and a reason; never add `Runtime.evaluate` of anything but a constant, or navigation, input, cookies, storage, network, `Target.createTarget` or `Target.sendMessageToTarget`.
- [ ] Tests never touch the user's own Chrome: headless Chrome for Testing only, through `test/chrome/launch.ts` (`--use-mock-keychain --password-store=basic`).

## Subprocesses and text from users

- [ ] Subprocesses use argument arrays: only `execFile`, `execFileSync` and `spawn` from `node:child_process`; no `shell`, no string commands, no `sh -c` (`test/security/no-shell.test.ts`).
- [ ] Paths, window titles, tab patterns and step notes are never spliced into a shell, AppleScript or filter graph. The one AppleScript is a constant.
- [ ] Filter-graph values are numbers only (validated with `Number.isFinite` / `numFlag` before interpolation). Step notes are never drawn into the video (no `drawtext`); if that ever changes, escape for the filter graph and pass text through a `textfile`.
- [ ] MCP path inputs (`input`, `out`, `boxes`) expand only a leading `~` or `~/`.

## Files

- [ ] Recordings, raw files, logs and sidecars stay next to the chosen output; temp files go in `mkdtemp` folders that are removed. `./recordings/.gitignore` is created.
- [ ] The state folder (`$SCREENREC_HOME` or `~/.screenrec`) is created 0700 and `state.json` is written 0600 (`test/security/state-perms.test.ts`).
- [ ] Clean-up commands never overwrite their input or its sidecar.
- [ ] Logs and traces never include page content, URLs with secrets, the broker token or Chrome's browser id (`redactUrl`).

## Privacy behaviour

- [ ] Nothing hides or suppresses the macOS recording indicator.
- [ ] Display capture prints the notifications warning.
- [ ] Blur pixelates before blurring.
- [ ] The sidecar (window titles, URLs, step notes) stays documented as sensitive, and `--no-meta` skips it.

## General

- [ ] Errors carry a code and a one-line fix; no stack traces unless `SCREENREC_DEBUG=1`.
- [ ] New dependencies: licence checked (MIT, Apache-2.0, BSD, ISC); runtime dependencies only with a spec update.
- [ ] The plugin's `npx` command pins the package version (`plugin/.mcp.json`, checked by `test/unit/plugin.test.ts`).
- [ ] No em dashes in code, comments or docs.
- [ ] Every claim of real-machine behaviour is in `docs/TESTED.md` with date and evidence.

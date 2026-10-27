# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the **Security** tab of [jamiusaliu/agent-screen-record](https://github.com/jamiusaliu/agent-screen-record/security), then **Report a vulnerability**. Please do not open a public issue for a security problem.

Include the version (`screenrec version`), your macOS, Node, ffmpeg and Chrome versions, and the steps or a proof of concept. Please give us a reasonable time to fix the issue before you disclose it. We will acknowledge the report, keep you updated, and credit you in the advisory unless you prefer otherwise.

Supported versions: the latest release only.

## What screenrec guarantees

screenrec records your screen, so it is built to keep that recording on your machine.

| Guarantee | How it is enforced |
|---|---|
| No network access except Chrome on loopback. No telemetry, no update checks. | `test/security/no-network.test.ts` scans `src/` and fails on any network API outside an allow-list of the CDP endpoint, the CDP client and the Chrome broker. Every CDP URL, including one discovered from Chrome, passes `assertLoopback` (only `127.0.0.1`, `localhost`, `::1`), and `fetch` refuses redirects. |
| The Chrome broker listens only on `127.0.0.1` and cannot be used to drive your browser. | Its WebSocket path holds a 256-bit random token, compared in constant time, kept in a 0600 file inside a 0700 folder, and never printed, logged or put in a process command line (`test/security/broker-token.test.ts`, `test/security/state-perms.test.ts`). Host and Origin are checked before the upgrade. It forwards only the CDP calls screenrec makes (target discovery, screencast, screenshot, focus emulation and two constant `Runtime.evaluate` reads); everything else is refused before Chrome sees it. |
| ffmpeg never reads or writes over the network. | ffmpeg and ffprobe receive only absolute local paths; any argument that looks like a protocol (`tcp:`, `http:`, `pipe:`, `concat:`) is refused (`test/security/ffmpeg-paths.test.ts`). |
| No shell injection from window titles, paths, tab patterns or step notes. | Subprocesses are started with argument arrays only, never a shell or a command string (`test/security/no-shell.test.ts`). Filter-graph values are validated numbers. |
| Recordings stay local and out of git by default. | `./recordings/` is created readable only by you (0700), with a `.gitignore` containing `*`. An existing `--out` is never replaced without `--force`, and the input of a clean-up command is never replaced. |

These tests run in `npm test`. Every change is reviewed against [docs/REVIEW-CHECKLIST.md](docs/REVIEW-CHECKLIST.md).

## What it does not protect against

- Anything visible in the target you choose is recorded. A display or region recording includes notifications and every other window on that display.
- The `.json` sidecar next to each recording holds window titles, URLs and step notes (`--no-meta` skips it).
- If you start screenrec through `npx`, npm contacts the npm registry to resolve the package before screenrec runs. That is npm's network access, not screenrec's; a global install avoids it.
- Files are written with your umask (usually readable by other local users). The default folders (`./recordings/` when screenrec creates it, `~/Movies/screenrec/`) are 0700, so that only matters for an explicit `--out` elsewhere and for clean-up outputs next to an input in a folder others can read.
- Any process running as your user can read your recordings and the broker's token file, as with any other file you own.
- Chrome DevTools MCP, if you use it as a second route, is a separate program with its own access to every tab of your profile and its own usage statistics (see the README).

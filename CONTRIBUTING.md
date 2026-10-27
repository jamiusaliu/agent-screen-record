# Contributing

Thanks for helping. screenrec is a small TypeScript CLI and MCP server plus a Swift capture helper for macOS.

## Development setup

Requirements: Node 22 or newer, ffmpeg 5.1 or newer on `PATH` (tested on 9.0.2), and on macOS Swift (Xcode or the Command Line Tools) for the capture helper.

```sh
npm ci
npm run build          # TypeScript to dist/
npm run build:native   # macOS only: Swift helper to bin/screenrec-mac (universal; if that fails it warns and builds this Mac's architecture only)
npm run typecheck
bin/screenrec doctor
```

`bin/screenrec` runs the built `dist/`, so run `npm run build` after changing `src/`. To try the CLI from anywhere, `npm link`.

## Tests

Assertions use bounds, not exact values: video timings and sizes vary between machines.

| Command | What it covers | Needs |
|---|---|---|
| `npm test` | Unit tests and the security tests (`test/unit`, `test/security`): target matching, display geometry, ffmpeg argument builders, state and recovery, sidecar re-timing, the no-network and no-shell scans, the broker token | Node only |
| `npm run test:video` | Clean-up commands on synthetic ffmpeg `testsrc` videos: squeeze, crop, trim, blur, gif, frame, AV1 input, `--out` and `--force` | ffmpeg |
| `npm run test:mcp` | An MCP SDK client lists and calls every tool against a fake capture backend | Node only |
| `npm run test:chrome` | Hidden-tab, `newest` and `follow` capture and the Chrome broker, against headless Chrome for Testing | Downloads Chrome for Testing into `.cache/chrome` on first run (`SCREENREC_TEST_CHROME_BUILD` pins a build). Never touches your own Chrome. Run it on a quiet machine: under heavy load (a concurrent `npm pack`, say) a test file can fail at Chrome startup. |
| `npm run test:mac-smoke` | The Swift helper: displays, permission, short recordings, stop and crash handling | macOS, `npm run build:native`, Screen Recording permission. Briefly captures the main display; skipped when the helper is not built. |
| `npm run test:mac` | The real-machine matrix (`test/mac-matrix/run.mjs`): covered windows, displays, minimized windows, Spaces, notifications, Chrome. Writes its results to `docs/TESTED.md`. | macOS with permission, a person at the machine for the manual steps. Not run in CI. |
| `npm run test:cleanroom` | macOS only. Clones the committed `HEAD` (or `CLEANROOM_REF`) into a temp folder, packs it and checks the tarball against an allowlist (`bin`, `dist`, `plugin`, `agents`, `package.json`, `README.md`, `LICENSE`; a universal helper; no tests under `dist`). Installs it into an empty folder with a fresh npm cache, a temp `HOME` and a PATH without your global npm bin, and runs every ` ```bash cleanroom ` block in `README.md` exactly as written. A fence that mentions `cleanroom` but is not exactly ` ```bash cleanroom ` or ` ```bash cleanroom-mac ` at column 0 fails the run. It also checks the `screenrec mcp` handshake against the README's tool list and follows the build-from-source steps with `npm install -g .` going to a temp prefix. Switches: `CLEANROOM_SKIP_SOURCE=1` skips the build-from-source steps; `CLEANROOM_MAC=1` also runs the ` ```bash cleanroom-mac ` blocks, which record the main display; `CLEANROOM_KEEP=1` keeps the temp folder, which is otherwise removed on success, failure and Ctrl-C. Uncommitted changes are not tested. | macOS, git, ffmpeg, Swift, network access to the npm registry, a full universal build (it packs, see Releasing; about 11 minutes, 6 with `CLEANROOM_SKIP_SOURCE=1`); Screen Recording permission for `CLEANROOM_MAC=1` |

Run `test:mac` and `test:mac-smoke` under `caffeinate -d` (for example `caffeinate -d npm run test:mac`). Without it macOS turns the displays off and locks the screen after the idle timeout, because the harness's AppleScript activity does not count as user input, and captures then fail with "no displays" (`E_TARGET_NOT_FOUND`) or `E_NO_FRAMES`.

Before a pull request: `npm run typecheck`, `npm test`, `npm run test:video` and `npm run test:mcp`, plus `npm run test:chrome` if you touched `src/capture/cdp`. If you change a README block tagged `cleanroom`, run `npm run test:cleanroom`.

## Rules

- **Conventional commits**: `feat(core): ...`, `fix(edit): ...`, `test(chrome): ...`, `docs: ...`. One concern per pull request.
- **Review checklist**: every change is reviewed against [docs/REVIEW-CHECKLIST.md](docs/REVIEW-CHECKLIST.md) (network, Chrome broker, subprocesses, files).
- **Real-machine claims go in [docs/TESTED.md](docs/TESTED.md) with evidence**: date, machine, and what was observed. Do not state a behaviour of real windows, displays or Chrome in the README unless TESTED.md backs it; say "unverified" otherwise.
- **No network** except the loopback CDP endpoint and the loopback broker; no telemetry or update checks. `test/security/no-network.test.ts` enforces it.
- **No shell**: run ffmpeg, ffprobe and the helper with argument arrays (`execFile`, `spawn`), never a command string.
- **Runtime dependencies** are `@modelcontextprotocol/sdk` and `zod` only.
- Do not commit recordings or screenshots of a real screen unless their owner has reviewed them.

## Releasing

1. **Bump the version** in five places; they must match:
   - `package.json` (`version`)
   - `plugin/.claude-plugin/plugin.json` (`version`)
   - `plugin/.mcp.json` (the pinned `agent-screen-record@<version>` in `args`)
   - `.claude-plugin/marketplace.json` (`plugins[0].version`)
   - `agents/AGENTS.snippet.md` (the pinned `npx -y agent-screen-record@<version>`)

   The MCP server and `screenrec version` read `package.json` themselves. `test/unit/plugin.test.ts` fails if any of these disagree.
2. **Build on a Mac with Xcode.** `npm pack` and `npm publish` run the `prepack` script: `npm run build` (TypeScript to `dist/`), then `node scripts/build-native.mjs --universal`. Unlike plain `npm run build:native`, the `--universal` build never falls back to one architecture: it fails unless `bin/screenrec-mac` holds both arm64 and x86_64 (it prints them, as `lipo -archs` does), and it fails off macOS. A failed step fails the pack. `dist/` and `bin/screenrec-mac` are gitignored, so without this build the package would ship a CLI that cannot start and no helper.
3. **Check the tarball:** `npm pack --dry-run` (this runs the full build, several minutes) must list `dist/cli/main.js`, `bin/screenrec` and `bin/screenrec-mac`. `lipo -archs bin/screenrec-mac` must print `x86_64 arm64`.
4. **Run every test layer above**, including `npm run test:cleanroom`.

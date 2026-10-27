# Agent Screen Record v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `screenrec`, a local-only CLI and MCP server that lets any AI agent record a window, app, display, region or Chrome tab (including covered windows and hidden tabs) and clean the recording up (squeeze, crop, blur, trim, gif, frame).

**Architecture:** A TypeScript npm package (`src/`) holds the core library, the CLI and the MCP server. macOS capture runs in a small Swift helper (`native/macos`, ScreenCaptureKit + AVAssetWriter) spoken to over JSON lines. Chrome tab capture is plain Node over the Chrome DevTools Protocol. All clean-up commands build ffmpeg argument lists in pure functions and run ffmpeg without a shell.

**Tech Stack:** Node 22+, TypeScript 5, `node:test` + `tsx`, `@modelcontextprotocol/sdk` (+ its `zod` dependency), Swift 6 / ScreenCaptureKit, ffmpeg (user installed).

**Spec:** `docs/specs/2026-10-17-agent-screen-record-design.md` (read it before any task; this plan argues from it).

## Global Constraints

- Node `>=22` (built-in `WebSocket`, `node:util` `parseArgs`); `"engines": { "node": ">=22" }`.
- Runtime dependencies: `@modelcontextprotocol/sdk` and `zod` only (zod is the SDK's schema library; both MIT). No other runtime dependency without updating the spec.
- ffmpeg and ffprobe are invoked with `execFile`/`spawn` argument arrays, never through a shell. ffmpeg is never bundled.
- No network access except the CDP endpoint on a loopback host (`127.0.0.1`, `localhost`, `::1`). No telemetry, no update checks.
- macOS capture: macOS 13+, ScreenCaptureKit with `SCStream` + `AVAssetWriter` only (no `SCRecordingOutput`). Every helper entry point calls `_ = NSApplication.shared` before any ScreenCaptureKit call.
- Every encoded width and height is even (libx264 + yuv420p).
- Default output directory `./recordings/`, created with a `.gitignore` containing `*`.
- Clean-up commands never overwrite their input; default output `<in-without-ext>.<command>.<ext>`.
- One active recording per user; state in `$SCREENREC_HOME` or `~/.screenrec/state.json`.
- Auto-stop default 10 minutes (`--max`).
- Every CLI command supports `--json`; failures print `{ "ok": false, "code", "message", "fix" }` and exit 1.
- Licence MIT. No code copied from the private prototype or from other projects.
- No em dashes anywhere (code, comments, docs, commit messages).
- Conventional commits (`feat(core):`, `fix(edit):`, `test(chrome):`, `docs:`), each ending with the two attribution lines the coordinator gives you.
- Nothing is pushed, no remote is added, nothing is published.

## Review Focus

1. **Window titles and paths with colons, spaces or unicode** (`--window "Docs:Q3: plan"`, `--out "~/My Videos/é.mp4"`): split app and title on the first colon only; never pass through a shell. Pinned in Task 4 and Task 6.
2. **The target disappears before `stop`** (window closed, tab closed, helper crashed): `stop` must still finalise a playable file and report it, not fail with `E_NOT_RECORDING`. Pinned in Task 19.
3. **Stale state with a reused PID** (machine rebooted, the old PID now belongs to another process): `isRecorderAlive` must check the process command line, not just that the PID exists. Pinned in Task 5.
4. **A recording that captured no frames** (static hidden tab before any paint, or stop within 100 ms): produce a clear `E_NO_FRAMES` error with a fix, never a zero-byte or unplayable mp4. Pinned in Task 18 and Task 19.
5. **Odd pixel sizes** (an 801x501 window at 1x, a crop of 333 px): round down to even before encoding. Pinned in Task 3 and Task 8.

---

## Team and execution with Orca

Each hire is a Claude Code agent in its own Orca worktree, created by the coordinator. One concern per hire. Hires commit after every passing step. The coordinator merges a hire's branch into `main` only after rerunning that branch's tests and reading real output.

| Hire (Orca worktree name) | Tasks |
|---|---|
| `api-core` (API / interface expert) | 2, 3, 4, 5, 6, 19 |
| `chrome-cdp` (Chrome / CDP engineer) | 1, 15, 16, 17, 18 |
| `video-edit` (video engineer) | 7, 8, 9, 10 |
| `mac-capture` (macOS capture engineer) | 11, 12, 13, 14 |
| `mcp-agents` (MCP and agent-integration designer) | 20, 21 |
| `security-review` (security and privacy reviewer) | 22, plus a review of every merge |
| `qa` (QA tester, never tests their own code) | 23, 24, plus layer runs after each merge |
| `docs-dx` (docs and developer experience) | 25 |

### Order and gates

```
Task 1 (chrome-cdp, real machine)  ──► decision recorded in docs/TESTED.md
Task 2-6 (api-core)                ──► merged to main: everyone builds on these interfaces
        ├─► 7-10 video-edit   ┐
        ├─► 11-14 mac-capture ├─ in parallel worktrees
        └─► 15-18 chrome-cdp  ┘  (15-18 only if Task 1 passed; else spec amendment first)
Task 19 (api-core): recording orchestration, after 11-18 are merged
Task 20-21 (mcp-agents) after 19
Task 22 (security-review) after 21; reviews run continuously
Task 23-24 (qa) after 22; Task 23 drives the real screen ALONE
Task 25 (docs-dx) last; its demo GIF uses the finished tool
```

Real-screen rule: Tasks 1, 14 (smoke step), 23 and 25 (demo recording) take over the user's windows. Only one of them runs at a time, and the coordinator tells the user before each.

### Coordinator commands

Run from the repo root.

```bash
orca repo add --path "$PWD" --json                      # once; note repo id
orca worktree create --repo id:<repoId> --name api-core --no-parent \
  --agent claude --prompt "$(cat docs/plans/briefs/api-core.md)" --json
orca worktree set --worktree name:api-core --comment "tasks 2-6 in progress" --json
orca worktree ps --json                                 # watch progress
```

Each brief (`docs/plans/briefs/<hire>.md`, written by the coordinator at dispatch time) contains: the hire's role, their task numbers, "read the spec and this plan first", the Global Constraints, the commit attribution lines, and "report DONE with the test command output, or BLOCKED with the exact error".

Merge protocol per hire branch:

```bash
git fetch . <branch>:<branch> 2>/dev/null || true
git checkout <branch> && npm ci && npm test && git checkout main
git merge --no-ff <branch> -m "merge: <hire> tasks <n-m>"
npm ci && npm test                                       # must pass on main
```

---

## File map

```
package.json  tsconfig.json  .gitignore  LICENSE  README.md  CONTRIBUTING.md  SECURITY.md
bin/screenrec                       node launcher (Task 2)
src/core/errors.ts                  ScreenrecError, codes, JSON shape (Task 2)
src/core/geometry.ts                Rect, even(), display resolution, region to pixels (Task 3)
src/core/targets.ts                 parse CLI target flags, match windows (Task 4)
src/core/state.ts                   state file, liveness, recovery detection (Task 5)
src/core/sidecar.ts                 marks file, sidecar JSON, retime after squeeze (Task 5)
src/core/paths.ts                   recordings dir, default output names (Task 6)
src/cli/args.ts                     argument parsing per command (Task 6)
src/cli/main.ts                     dispatch, text and JSON output (Task 6)
src/commands/*.ts                   one file per command, shared by CLI and MCP (Tasks 6-19)
src/edit/ffmpeg.ts                  run, probe, requireFfmpeg (Task 7)
src/edit/squeeze.ts  crop.ts  trim.ts  frame.ts  gif.ts  blur.ts   (Tasks 7-10)
native/macos/Package.swift          (Task 11)
native/macos/Sources/screenrec-mac/{main,Listing,Screenshot,Recorder,Json}.swift (Tasks 11-13)
src/capture/mac.ts                  helper client (Task 14)
src/capture/cdp/client.ts           CDP JSON-RPC client (Task 15)
src/capture/cdp/endpoint.ts         endpoint discovery + loopback guard (Task 15)
src/capture/cdp/tabs.ts             pure tab tracker (Task 16)
src/capture/cdp/pacer.ts            pure frame pacing (Task 17)
src/capture/cdp/worker.ts           detached tab recorder process (Task 18)
src/recorder.ts                     start/stop/status/mark orchestration (Task 19)
src/mcp/server.ts                   MCP server (Task 20)
plugin/  agents/AGENTS.snippet.md   (Task 21)
test/unit/  test/video/  test/chrome/  test/mcp/  test/security/  test/mac-matrix/  test/cleanroom/
test/fixtures/                      fake helper, two-display geometry, test page
examples/  docs/TESTED.md
```

---

### Task 1: Chrome gate checks on the real machine (chrome-cdp)

Throwaway scripts, kept under `test/mac-matrix/chrome-gate/` because Task 23 reuses them. This task answers spec 6.5 before any Chrome code is built on it. It drives the user's real Chrome; the coordinator announces it first.

**Files:**
- Create: `test/mac-matrix/chrome-gate/probe.mjs`
- Create: `test/fixtures/colour-page.html`
- Create: `docs/TESTED.md`

**Interfaces:**
- Produces: a recorded decision in `docs/TESTED.md` under `## Chrome gate (spec 6.5)`: `PASS` (build Tasks 15-18 as written) or `FAIL: <which check>` (stop; coordinator amends the spec to pull the extension into v1).

- [ ] **Step 1: Write the colour test page**

`test/fixtures/colour-page.html`:

```html
<!doctype html><title>SCREENREC COLOUR</title>
<body style="margin:0;height:100vh;background:#000">
<script>
const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#ffffff', '#808080'];
let i = 0;
setInterval(() => { document.body.style.background = colours[i++ % colours.length]; }, 500);
</script>
```

- [ ] **Step 2: Write the probe**

`test/mac-matrix/chrome-gate/probe.mjs` (plain Node, no build):

```js
// Usage: node probe.mjs <ws-browser-url> <seconds>
// Opens the colour page in a new background tab, screencasts it, counts distinct colours.
import fs from 'node:fs';
const [wsUrl, secs = '4'] = process.argv.slice(2);
const page = new URL('../../fixtures/colour-page.html', import.meta.url).href;
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const msg = { id: ++id, method, params }; if (sessionId) msg.sessionId = sessionId;
  pending.set(msg.id, { res, rej }); ws.send(JSON.stringify(msg));
});
const colours = new Set(); let frames = 0;
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === 'Page.screencastFrame') {
    frames++;
    send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, m.sessionId);
    const buf = Buffer.from(m.params.data, 'base64');
    // centre pixel colour via a coarse hash of a middle slice of the JPEG bytes is unreliable;
    // instead ask the page for its background on each frame (cheap and exact).
    const r = await send('Runtime.evaluate', { expression: 'document.body.style.background' }, m.sessionId);
    colours.add(r.result.value); fs.writeFileSync(`/tmp/screenrec-gate-last.jpg`, buf);
  }
};
ws.onopen = async () => {
  const { targetId } = await send('Target.createTarget', { url: page, background: true });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  await send('Page.startScreencast', { format: 'jpeg', quality: 80 }, sessionId);
  setTimeout(async () => {
    await send('Page.stopScreencast', {}, sessionId);
    await send('Target.closeTarget', { targetId });
    console.log(JSON.stringify({ frames, distinctColours: colours.size }));
    process.exit(colours.size >= 4 ? 0 : 2);
  }, Number(secs) * 1000);
};
ws.onerror = (e) => { console.error('ws error', e.message ?? e); process.exit(1); };
```

- [ ] **Step 3: Check 1 and 3, normal profile endpoint and discovery**

Ask the user (through the coordinator) to open `chrome://inspect#remote-debugging` in their normal Chrome and enable it. Then:

```bash
cat "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
```

Expected: two lines, a port and a path like `/devtools/browser/<uuid>`. Build `ws://127.0.0.1:<port><path>` and run:

```bash
node test/mac-matrix/chrome-gate/probe.mjs "ws://127.0.0.1:<port><path>" 4
```

Expected: Chrome shows a permission dialog (user accepts), then output like `{"frames":>0,"distinctColours":>=4}` and exit 0. Run it a second time immediately and record whether the dialog appeared again (spec 6.5 item 1). If `DevToolsActivePort` is absent, record which mechanism worked instead (item 3).

- [ ] **Step 4: Check 2, coexistence with Claude in Chrome**

Ask the user to start any Claude in Chrome task on a tab (for example "scroll this page slowly"). While it runs, attach the probe to that tab instead of a new one: change `Target.createTarget` to find the target by URL via `Target.getTargets` (keep this variant as `probe-attach.mjs`). Expected: probe gets frames AND Claude in Chrome keeps working (user confirms). Record both.

- [ ] **Step 5: Check 4, occlusion flag on the default profile**

Ask the user for a convenient moment to quit Chrome. Relaunch with `open -a "Google Chrome" --args --disable-backgrounding-occluded-windows`, open the colour page, cover the window with TextEdit, and capture with the spike's ScreenCaptureKit method (or `screencapture -l <windowId>` twice, 2 s apart, and compare). Record live or frozen.

- [ ] **Step 6: Record the decision**

`docs/TESTED.md`:

```markdown
# Tested

Every claim about real-machine behaviour lives here with date, machine and evidence.

## Chrome gate (spec 6.5)

Date: <YYYY-MM-DD>. Machine: <model, macOS, Chrome version>.

| Check | Result | Evidence |
|---|---|---|
| 1. Endpoint 2 on normal profile | PASS/FAIL; dialog: once per connection / once per session | probe output |
| 2. Coexists with Claude in Chrome | PASS/FAIL | probe output + user confirmation |
| 3. Endpoint discovery | DevToolsActivePort / other | file contents (port redacted ok) |
| 4. Occlusion flag, default profile | live / frozen | frame pair |

Decision: PASS | FAIL: <check>
```

- [ ] **Step 7: Commit**

```bash
git add test/mac-matrix/chrome-gate test/fixtures/colour-page.html docs/TESTED.md
git commit -m "test(chrome): record chrome gate results"
```

---

### Task 2: Package scaffold and error model (api-core)

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `bin/screenrec`
- Create: `src/core/errors.ts`
- Test: `test/unit/errors.test.ts`

**Interfaces:**
- Produces:
  - `type ErrorCode = 'E_BAD_ARGS' | 'E_PERMISSION' | 'E_NO_FFMPEG' | 'E_FFMPEG_FAILED' | 'E_TARGET_NOT_FOUND' | 'E_TARGET_AMBIGUOUS' | 'E_ALREADY_RECORDING' | 'E_NOT_RECORDING' | 'E_CDP_UNAVAILABLE' | 'E_REGION_SPANS_DISPLAYS' | 'E_HELPER_CRASHED' | 'E_NO_FRAMES' | 'E_UNSUPPORTED_PLATFORM'`
  - `class ScreenrecError extends Error { code: ErrorCode; fix: string; candidates?: string[] }` with constructor `(code, message, fix, candidates?)`
  - `function errorJson(err: unknown): { ok: false; code: ErrorCode; message: string; fix: string; candidates?: string[] }` (non-ScreenrecError becomes `E_HELPER_CRASHED`? no: becomes code `E_BAD_ARGS` only if thrown by arg parsing; any other unknown error maps to `{ code: 'E_HELPER_CRASHED', fix: 'Re-run with SCREENREC_DEBUG=1 and report the output.' }`)
- Note: `E_BAD_ARGS`, `E_FFMPEG_FAILED`, `E_NO_FRAMES` and `E_UNSUPPORTED_PLATFORM` extend the spec's list (spec section 9 lists the minimum).

- [ ] **Step 1: Scaffold**

`package.json`:

```json
{
  "name": "screenrec",
  "version": "0.1.0",
  "description": "Let AI agents record windows, apps, displays and Chrome tabs, then clean the recording up. Local only.",
  "license": "MIT",
  "type": "module",
  "bin": { "screenrec": "bin/screenrec" },
  "files": ["bin", "dist", "plugin", "agents"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "build:native": "node scripts/build-native.mjs",
    "test": "node --import tsx --test \"test/unit/**/*.test.ts\" \"test/security/**/*.test.ts\"",
    "test:video": "node --import tsx --test \"test/video/**/*.test.ts\"",
    "test:chrome": "node --import tsx --test \"test/chrome/**/*.test.ts\"",
    "test:mcp": "node --import tsx --test \"test/mcp/**/*.test.ts\"",
    "test:mac": "node test/mac-matrix/run.mjs",
    "test:cleanroom": "node test/cleanroom/run.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

Then install dev dependencies (exact current versions are fine; they are recorded in the lockfile):

```bash
npm install --save-dev typescript tsx @types/node
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "outDir": "dist", "rootDir": "src", "strict": true, "declaration": false,
    "esModuleInterop": true, "skipLibCheck": true, "sourceMap": true,
    "rewriteRelativeImportExtensions": true
  },
  "include": ["src"]
}
```

`.gitignore`:

```
node_modules/
dist/
bin/screenrec-mac
native/macos/.build/
recordings/
*.log
```

`bin/screenrec` (make executable with `chmod +x bin/screenrec`):

```js
#!/usr/bin/env node
import('../dist/cli/main.js').then(async (m) => process.exit(await m.main(process.argv.slice(2))));
```

- [ ] **Step 2: Write the failing test**

`test/unit/errors.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenrecError, errorJson } from '../../src/core/errors.ts';

test('ScreenrecError carries code, message, fix and candidates', () => {
  const e = new ScreenrecError('E_TARGET_AMBIGUOUS', '2 windows match "Finder"', 'Add a title: --window "Finder:Downloads"', ['Finder: Downloads', 'Finder: Desktop']);
  assert.equal(e.code, 'E_TARGET_AMBIGUOUS');
  assert.ok(e instanceof Error);
  assert.deepEqual(errorJson(e), {
    ok: false, code: 'E_TARGET_AMBIGUOUS', message: '2 windows match "Finder"',
    fix: 'Add a title: --window "Finder:Downloads"', candidates: ['Finder: Downloads', 'Finder: Desktop'],
  });
});

test('unknown errors map to E_HELPER_CRASHED with a debug fix', () => {
  const j = errorJson(new Error('boom'));
  assert.equal(j.code, 'E_HELPER_CRASHED');
  assert.equal(j.message, 'boom');
  assert.match(j.fix, /SCREENREC_DEBUG=1/);
  assert.equal('candidates' in j, false);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, cannot find module `src/core/errors.ts`.

- [ ] **Step 4: Implement**

`src/core/errors.ts`:

```ts
export type ErrorCode =
  | 'E_BAD_ARGS' | 'E_PERMISSION' | 'E_NO_FFMPEG' | 'E_FFMPEG_FAILED'
  | 'E_TARGET_NOT_FOUND' | 'E_TARGET_AMBIGUOUS' | 'E_ALREADY_RECORDING'
  | 'E_NOT_RECORDING' | 'E_CDP_UNAVAILABLE' | 'E_REGION_SPANS_DISPLAYS'
  | 'E_HELPER_CRASHED' | 'E_NO_FRAMES' | 'E_UNSUPPORTED_PLATFORM';

export class ScreenrecError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly fix: string,
    public readonly candidates?: string[],
  ) {
    super(message);
    this.name = 'ScreenrecError';
  }
}

export interface ErrorJson {
  ok: false; code: ErrorCode; message: string; fix: string; candidates?: string[];
}

export function errorJson(err: unknown): ErrorJson {
  if (err instanceof ScreenrecError) {
    const j: ErrorJson = { ok: false, code: err.code, message: err.message, fix: err.fix };
    if (err.candidates) j.candidates = err.candidates;
    return j;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, code: 'E_HELPER_CRASHED', message, fix: 'Re-run with SCREENREC_DEBUG=1 and report the output.' };
}
```

- [ ] **Step 5: Run tests, typecheck**

Run: `npm test && npm run typecheck`
Expected: 2 tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore bin/screenrec src/core/errors.ts test/unit/errors.test.ts
git commit -m "feat(core): scaffold package and error model"
```

---

### Task 3: Geometry and displays (api-core)

**Files:**
- Create: `src/core/geometry.ts`
- Create: `test/fixtures/two-displays.json`
- Test: `test/unit/geometry.test.ts`

**Interfaces:**
- Consumes: `ScreenrecError` (Task 2).
- Produces:
  - `interface Rect { x: number; y: number; width: number; height: number }`
  - `interface Display { id: number; name: string; x: number; y: number; width: number; height: number; scale: number; main: boolean }` (points, global top-left coordinates, y grows downward, as `CGDisplayBounds`)
  - `even(n: number): number` (round down to even, minimum 2)
  - `resolveDisplay(displays: Display[], sel: string): Display` (`main`, 1-based index, or case-insensitive name substring)
  - `displayOfRect(displays: Display[], r: Rect): Display` (largest overlap; ties go to `main`)
  - `regionToPixels(d: Display, region: Rect): Rect` (display-relative points to display pixels, even sizes; throws `E_REGION_SPANS_DISPLAYS` if the region leaves the display)
  - `pixelSize(widthPt: number, heightPt: number, scale: number): { width: number; height: number }` (even)

- [ ] **Step 1: Fixture from the spike machine** (CG coordinates; the external display sits left of main, top-aligned)

`test/fixtures/two-displays.json`:

```json
[
  { "id": 1, "name": "Built-in Retina Display", "x": 0, "y": 0, "width": 1440, "height": 900, "scale": 2, "main": true },
  { "id": 2, "name": "LG FHD", "x": -1920, "y": 0, "width": 1920, "height": 1080, "scale": 1, "main": false }
]
```

- [ ] **Step 2: Write the failing tests**

`test/unit/geometry.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { even, resolveDisplay, displayOfRect, regionToPixels, pixelSize, type Display } from '../../src/core/geometry.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const displays: Display[] = JSON.parse(fs.readFileSync(new URL('../fixtures/two-displays.json', import.meta.url), 'utf8'));

test('even rounds down and never goes below 2', () => {
  assert.equal(even(801), 800); assert.equal(even(500), 500); assert.equal(even(1), 2); assert.equal(even(333.7), 332);
});

test('resolveDisplay by main, index and name', () => {
  assert.equal(resolveDisplay(displays, 'main').id, 1);
  assert.equal(resolveDisplay(displays, '2').id, 2);
  assert.equal(resolveDisplay(displays, 'lg').id, 2);
  assert.throws(() => resolveDisplay(displays, '3'), (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND' && e.candidates!.length === 2);
});

test('displayOfRect picks the display holding most of the window, including negative x', () => {
  assert.equal(displayOfRect(displays, { x: -1500, y: 100, width: 800, height: 500 }).id, 2);
  assert.equal(displayOfRect(displays, { x: -100, y: 100, width: 800, height: 500 }).id, 1);
});

test('regionToPixels uses that display scale and stays even', () => {
  assert.deepEqual(regionToPixels(displays[0], { x: 10, y: 20, width: 400.5, height: 301 }), { x: 20, y: 40, width: 800, height: 602 });
  assert.deepEqual(regionToPixels(displays[1], { x: 0, y: 0, width: 801, height: 501 }), { x: 0, y: 0, width: 800, height: 500 });
});

test('regionToPixels rejects a region that leaves its display', () => {
  assert.throws(() => regionToPixels(displays[0], { x: 1400, y: 0, width: 100, height: 100 }), (e: ScreenrecError) => e.code === 'E_REGION_SPANS_DISPLAYS');
  assert.throws(() => regionToPixels(displays[0], { x: -1, y: 0, width: 10, height: 10 }), (e: ScreenrecError) => e.code === 'E_REGION_SPANS_DISPLAYS');
});

test('pixelSize for a 1x and a 2x window', () => {
  assert.deepEqual(pixelSize(801, 501, 1), { width: 800, height: 500 });
  assert.deepEqual(pixelSize(800, 500, 2), { width: 1600, height: 1000 });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test`
Expected: FAIL, cannot find module `src/core/geometry.ts`.

- [ ] **Step 4: Implement**

`src/core/geometry.ts`:

```ts
import { ScreenrecError } from './errors.ts';

export interface Rect { x: number; y: number; width: number; height: number }
export interface Display { id: number; name: string; x: number; y: number; width: number; height: number; scale: number; main: boolean }

export function even(n: number): number {
  const f = Math.floor(n);
  return Math.max(2, f - (f % 2));
}

function describe(d: Display, i: number): string {
  return `${i + 1}: ${d.name} ${d.width}x${d.height}@${d.scale}x${d.main ? ' (main)' : ''}`;
}

export function resolveDisplay(displays: Display[], sel: string): Display {
  const s = sel.trim().toLowerCase();
  let found: Display | undefined;
  if (s === 'main') found = displays.find((d) => d.main);
  else if (/^\d+$/.test(s)) found = displays[Number(s) - 1];
  else found = displays.find((d) => d.name.toLowerCase().includes(s));
  if (!found) {
    throw new ScreenrecError('E_TARGET_NOT_FOUND', `No display matches "${sel}"`,
      'Run "screenrec list displays" and pass main, a number or part of a name.', displays.map(describe));
  }
  return found;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function displayOfRect(displays: Display[], r: Rect): Display {
  let best = displays.find((d) => d.main) ?? displays[0];
  let bestArea = overlap(best, r);
  for (const d of displays) {
    const a = overlap(d, r);
    if (a > bestArea) { best = d; bestArea = a; }
  }
  return best;
}

export function regionToPixels(d: Display, region: Rect): Rect {
  const inside = region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
    region.x + region.width <= d.width && region.y + region.height <= d.height;
  if (!inside) {
    throw new ScreenrecError('E_REGION_SPANS_DISPLAYS',
      `Region ${region.x},${region.y},${region.width},${region.height} does not fit display "${d.name}" (${d.width}x${d.height} points)`,
      'Regions are measured in points from the top-left of the chosen display and must stay inside it.');
  }
  return {
    x: Math.round(region.x * d.scale), y: Math.round(region.y * d.scale),
    width: even(region.width * d.scale), height: even(region.height * d.scale),
  };
}

export function pixelSize(widthPt: number, heightPt: number, scale: number): { width: number; height: number } {
  return { width: even(widthPt * scale), height: even(heightPt * scale) };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all geometry tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/geometry.ts test/unit/geometry.test.ts test/fixtures/two-displays.json
git commit -m "feat(core): display geometry with per-display scale"
```

---

### Task 4: Targets (api-core)

**Files:**
- Create: `src/core/targets.ts`
- Test: `test/unit/targets.test.ts`

**Interfaces:**
- Consumes: `Rect` (Task 3), `ScreenrecError` (Task 2).
- Produces:
  - `interface WindowInfo { id: number; app: string; title: string; x: number; y: number; width: number; height: number; onScreen: boolean; z: number; pid: number }` (`z`: 0 is frontmost; points, global top-left)
  - `type Target = { kind: 'window'; app?: string; title?: string; id?: number; followApp: boolean; ignoreApps: string[] } | { kind: 'app'; app: string; followApp: boolean; ignoreApps: string[] } | { kind: 'display'; display: string } | { kind: 'display-of'; window: string } | { kind: 'region'; region: Rect; display: string } | { kind: 'tab'; mode: 'newest' | 'follow' | 'url' | 'title'; pattern?: string; cdp?: string }`
  - `parseTarget(o: TargetFlags): Target` where `interface TargetFlags { window?: string; app?: string; display?: string; 'display-of'?: string; region?: string; tab?: string; cdp?: string; 'follow-app'?: boolean; 'ignore-app'?: string[] }`
  - `parseWindowSelector(s: string): { app?: string; title?: string; id?: number }`
  - `matchWindow(windows: WindowInfo[], sel: { app?: string; title?: string; id?: number }): WindowInfo`
  - `frontWindowOfApp(windows: WindowInfo[], app: string): WindowInfo`
  - `describeWindow(w: WindowInfo): string`

- [ ] **Step 1: Write the failing tests**

`test/unit/targets.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, parseWindowSelector, matchWindow, frontWindowOfApp, type WindowInfo } from '../../src/core/targets.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const w = (id: number, app: string, title: string, z: number, onScreen = true): WindowInfo =>
  ({ id, app, title, x: 0, y: 0, width: 800, height: 500, onScreen, z, pid: 100 + id });
const windows = [
  w(10, 'Finder', 'Downloads', 1), w(11, 'Finder', 'Desktop', 3),
  w(20, 'Google Chrome', 'Docs: Q3: plan', 0), w(30, 'Préview', 'été.png', 2),
];

test('window selector splits app and title on the first colon only', () => {
  assert.deepEqual(parseWindowSelector('Google Chrome:Docs: Q3: plan'), { app: 'Google Chrome', title: 'Docs: Q3: plan' });
  assert.deepEqual(parseWindowSelector('Finder'), { app: 'Finder' });
  assert.deepEqual(parseWindowSelector('3654'), { id: 3654 });
});

test('matchWindow by app and title, case-insensitive, unicode-safe', () => {
  assert.equal(matchWindow(windows, { app: 'finder', title: 'down' }).id, 10);
  assert.equal(matchWindow(windows, { app: 'préview' }).id, 30);
  assert.equal(matchWindow(windows, { app: 'Google Chrome', title: 'Docs: Q3: plan' }).id, 20);
  assert.equal(matchWindow(windows, { id: 11 }).id, 11);
});

test('ambiguous match lists candidates instead of guessing', () => {
  assert.throws(() => matchWindow(windows, { app: 'Finder' }), (e: ScreenrecError) =>
    e.code === 'E_TARGET_AMBIGUOUS' && e.candidates!.length === 2 && e.candidates![0].includes('Downloads'));
});

test('no match is E_TARGET_NOT_FOUND', () => {
  assert.throws(() => matchWindow(windows, { app: 'Safari' }), (e: ScreenrecError) => e.code === 'E_TARGET_NOT_FOUND');
});

test('frontWindowOfApp takes the lowest z among on-screen windows', () => {
  assert.equal(frontWindowOfApp(windows, 'Finder').id, 10);
});

test('parseTarget for each kind and rejects zero or two targets', () => {
  assert.deepEqual(parseTarget({ window: 'Finder:Downloads' }), { kind: 'window', app: 'Finder', title: 'Downloads', followApp: false, ignoreApps: [] });
  assert.deepEqual(parseTarget({ app: 'Safari', 'follow-app': true, 'ignore-app': ['Orca'] }), { kind: 'app', app: 'Safari', followApp: true, ignoreApps: ['Orca'] });
  assert.deepEqual(parseTarget({ display: 'main' }), { kind: 'display', display: 'main' });
  assert.deepEqual(parseTarget({ 'display-of': 'Finder' }), { kind: 'display-of', window: 'Finder' });
  assert.deepEqual(parseTarget({ region: '10,20,300,200', display: '2' }), { kind: 'region', region: { x: 10, y: 20, width: 300, height: 200 }, display: '2' });
  assert.deepEqual(parseTarget({ tab: 'url:github.com', cdp: 'http://127.0.0.1:9222' }), { kind: 'tab', mode: 'url', pattern: 'github.com', cdp: 'http://127.0.0.1:9222' });
  assert.deepEqual(parseTarget({ tab: 'follow' }), { kind: 'tab', mode: 'follow' });
  assert.throws(() => parseTarget({}), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseTarget({ window: 'A', tab: 'newest' }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseTarget({ region: '1,2,3' , display: 'main'}), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseTarget({ tab: 'sideways' }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test` → FAIL, module not found.

- [ ] **Step 3: Implement**

`src/core/targets.ts`:

```ts
import { ScreenrecError } from './errors.ts';
import type { Rect } from './geometry.ts';

export interface WindowInfo {
  id: number; app: string; title: string; x: number; y: number; width: number; height: number;
  onScreen: boolean; z: number; pid: number;
}

export type Target =
  | { kind: 'window'; app?: string; title?: string; id?: number; followApp: boolean; ignoreApps: string[] }
  | { kind: 'app'; app: string; followApp: boolean; ignoreApps: string[] }
  | { kind: 'display'; display: string }
  | { kind: 'display-of'; window: string }
  | { kind: 'region'; region: Rect; display: string }
  | { kind: 'tab'; mode: 'newest' | 'follow' | 'url' | 'title'; pattern?: string; cdp?: string };

export interface TargetFlags {
  window?: string; app?: string; display?: string; 'display-of'?: string; region?: string;
  tab?: string; cdp?: string; 'follow-app'?: boolean; 'ignore-app'?: string[];
}

const bad = (message: string, fix: string) => new ScreenrecError('E_BAD_ARGS', message, fix);

export function parseWindowSelector(s: string): { app?: string; title?: string; id?: number } {
  if (/^\d+$/.test(s.trim())) return { id: Number(s.trim()) };
  const i = s.indexOf(':');
  if (i === -1) return { app: s };
  return { app: s.slice(0, i), title: s.slice(i + 1) };
}

export function describeWindow(w: WindowInfo): string {
  return `${w.id}: ${w.app}: ${w.title || '(untitled)'} ${w.width}x${w.height}${w.onScreen ? '' : ' (hidden)'}`;
}

const lc = (s: string) => s.normalize('NFC').toLowerCase();

export function matchWindow(windows: WindowInfo[], sel: { app?: string; title?: string; id?: number }): WindowInfo {
  const hits = windows.filter((w) =>
    (sel.id === undefined || w.id === sel.id) &&
    (sel.app === undefined || lc(w.app) === lc(sel.app) || lc(w.app).includes(lc(sel.app))) &&
    (sel.title === undefined || lc(w.title).includes(lc(sel.title))));
  const exactApp = sel.app === undefined ? hits : hits.filter((w) => lc(w.app) === lc(sel.app!));
  const pool = exactApp.length > 0 ? exactApp : hits;
  if (pool.length === 1) return pool[0];
  const label = [sel.id, sel.app, sel.title].filter((v) => v !== undefined).join(':');
  if (pool.length === 0) {
    throw new ScreenrecError('E_TARGET_NOT_FOUND', `No window matches "${label}"`,
      'Run "screenrec list windows" and pass "App", "App:title" or a window id.', windows.map(describeWindow));
  }
  const sorted = [...pool].sort((a, b) => a.z - b.z);
  throw new ScreenrecError('E_TARGET_AMBIGUOUS', `${pool.length} windows match "${label}"`,
    'Add part of the title ("App:title") or pass the window id.', sorted.map(describeWindow));
}

export function frontWindowOfApp(windows: WindowInfo[], app: string): WindowInfo {
  const mine = windows.filter((w) => w.onScreen && (lc(w.app) === lc(app) || lc(w.app).includes(lc(app))));
  if (mine.length === 0) {
    throw new ScreenrecError('E_TARGET_NOT_FOUND', `"${app}" has no visible window`,
      'Open a window in that app first, or run "screenrec list windows".', windows.map(describeWindow));
  }
  return [...mine].sort((a, b) => a.z - b.z)[0];
}

function parseRegion(s: string): Rect {
  const n = s.split(',').map((v) => Number(v.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) {
    throw bad(`Bad region "${s}"`, 'Use --region x,y,width,height in points, e.g. --region 0,0,800,600 --display main');
  }
  return { x: n[0], y: n[1], width: n[2], height: n[3] };
}

function parseTab(s: string, cdp?: string): Target {
  const base = (t: Target & { kind: 'tab' }) => (cdp ? { ...t, cdp } : t);
  if (s === 'newest' || s === 'follow') return base({ kind: 'tab', mode: s });
  const m = /^(url|title):(.+)$/.exec(s);
  if (m) return base({ kind: 'tab', mode: m[1] as 'url' | 'title', pattern: m[2] });
  throw bad(`Bad tab selector "${s}"`, 'Use --tab newest, --tab follow, --tab url:<text> or --tab title:<text>');
}

export function parseTarget(o: TargetFlags): Target {
  const kinds = (['window', 'app', 'display-of', 'region', 'tab'] as const).filter((k) => o[k] !== undefined);
  const displayAlone = o.display !== undefined && o.region === undefined;
  const count = kinds.length + (displayAlone ? 1 : 0);
  if (count !== 1) {
    throw bad(count === 0 ? 'No target given' : `Pick one target, got ${count}`,
      'Use exactly one of --window, --app, --display, --display-of, --region (with --display) or --tab.');
  }
  const followApp = o['follow-app'] === true;
  const ignoreApps = o['ignore-app'] ?? [];
  if (o.window !== undefined) return { kind: 'window', ...parseWindowSelector(o.window), followApp, ignoreApps };
  if (o.app !== undefined) return { kind: 'app', app: o.app, followApp, ignoreApps };
  if (o['display-of'] !== undefined) return { kind: 'display-of', window: o['display-of'] };
  if (o.region !== undefined) return { kind: 'region', region: parseRegion(o.region), display: o.display ?? 'main' };
  if (o.tab !== undefined) return parseTab(o.tab, o.cdp);
  return { kind: 'display', display: o.display! };
}
```

- [ ] **Step 4: Run tests** → `npm test`, all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/targets.ts test/unit/targets.test.ts
git commit -m "feat(core): target parsing and window matching"
```

---

### Task 5: State, liveness and sidecar (api-core)

**Files:**
- Create: `src/core/state.ts`, `src/core/sidecar.ts`
- Test: `test/unit/state.test.ts`, `test/unit/sidecar.test.ts`

**Interfaces:**
- Consumes: `Target` (Task 4).
- Produces (state):
  - `interface RecordingState { pid: number; worker: 'mac' | 'cdp'; target: Target; raw: string; out: string; marksFile: string; meta: boolean; startedAt: number; maxMs: number }`
  - `stateDir(): string` (`SCREENREC_HOME` or `~/.screenrec`), `statePath(): string`
  - `readState(): RecordingState | null`, `writeState(s: RecordingState): void` (atomic: write temp then rename), `clearState(): void`
  - `isRecorderAlive(pid: number, psCommand?: (pid: number) => string | null): boolean` (true only if the process exists AND its command line is a recorder: contains `screenrec-mac` or `capture/cdp/worker.`)
- Produces (sidecar):
  - `interface Mark { t: number; text: string }`
  - `interface Sidecar { version: 1; target: Target; startedAt: string; durationSec: number; marks: Mark[] }`
  - `appendMark(marksFile: string, mark: Mark): void`, `readMarks(marksFile: string): Mark[]`
  - `writeSidecar(path: string, s: Sidecar): void`, `readSidecar(path: string): Sidecar | null`
  - `retimeMarks(marks: Mark[], keptPts: number[], fps: number): Mark[]` (each mark moves to `count(keptPts <= t) / fps`, rounded to 0.001)

- [ ] **Step 1: Write the failing tests**

`test/unit/state.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { readState, writeState, clearState, statePath, isRecorderAlive, type RecordingState } from '../../src/core/state.ts';

beforeEach(() => { process.env.SCREENREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-')); });

const s: RecordingState = { pid: 123, worker: 'mac', target: { kind: 'display', display: 'main' }, raw: '/tmp/a.mov',
  out: '/tmp/a.mp4', marksFile: '/tmp/a.marks.jsonl', meta: true, startedAt: 1000, maxMs: 600000 };

test('state round-trips and clears', () => {
  assert.equal(readState(), null);
  writeState(s);
  assert.deepEqual(readState(), s);
  assert.ok(statePath().startsWith(process.env.SCREENREC_HOME!));
  clearState();
  assert.equal(readState(), null);
});

test('corrupt state file reads as null rather than throwing', () => {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), '{not json');
  assert.equal(readState(), null);
});

test('liveness requires a screenrec command line, not just a live pid (pid reuse)', () => {
  assert.equal(isRecorderAlive(42, () => '/usr/bin/screenrec-mac record --window-id 3'), true);
  assert.equal(isRecorderAlive(42, () => 'node /x/dist/capture/cdp/worker.js'), true);
  assert.equal(isRecorderAlive(42, () => 'vim /home/me/screenrec/notes.md'), false); // name alone is not enough
  assert.equal(isRecorderAlive(42, () => '/Applications/Safari.app/Contents/MacOS/Safari'), false);
  assert.equal(isRecorderAlive(42, () => null), false);
  assert.equal(isRecorderAlive(process.pid), false); // the test runner is not a recorder
});
```

`test/unit/sidecar.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { appendMark, readMarks, writeSidecar, readSidecar, retimeMarks } from '../../src/core/sidecar.ts';

test('marks append as JSON lines and read back in order', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'a.marks.jsonl');
  assert.deepEqual(readMarks(f), []);
  appendMark(f, { t: 1.5, text: 'opened Downloads' });
  appendMark(f, { t: 3.25, text: 'clicked "é.png": done' });
  assert.deepEqual(readMarks(f), [{ t: 1.5, text: 'opened Downloads' }, { t: 3.25, text: 'clicked "é.png": done' }]);
});

test('sidecar round-trips', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')), 'a.json');
  const sc = { version: 1 as const, target: { kind: 'display' as const, display: 'main' }, startedAt: '2026-10-17T10:00:00.000Z', durationSec: 12.5, marks: [] };
  writeSidecar(f, sc);
  assert.deepEqual(readSidecar(f), sc);
  assert.equal(readSidecar(f + '.missing'), null);
});

test('retimeMarks maps original times onto squeezed time', () => {
  // 30 fps; frames 0..59 kept (0-2 s), 60..179 dropped (frozen 2-6 s), 180..239 kept (6-8 s)
  const kept = [...Array(60).keys(), ...Array.from({ length: 60 }, (_, i) => 180 + i)].map((f) => f / 30);
  const out = retimeMarks([{ t: 1, text: 'a' }, { t: 4, text: 'b' }, { t: 7, text: 'c' }], kept, 30);
  assert.deepEqual(out.map((m) => m.text), ['a', 'b', 'c']);
  assert.ok(Math.abs(out[0].t - 1.033) < 0.05);
  assert.ok(Math.abs(out[1].t - 2.0) < 0.05);   // inside the frozen span: collapses to its start
  assert.ok(Math.abs(out[2].t - 3.033) < 0.05); // 7 s becomes about 3 s
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`, modules not found.

- [ ] **Step 3: Implement**

`src/core/state.ts`:

```ts
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Target } from './targets.ts';

export interface RecordingState {
  pid: number; worker: 'mac' | 'cdp'; target: Target; raw: string; out: string;
  marksFile: string; meta: boolean; startedAt: number; maxMs: number;
}

export function stateDir(): string { return process.env.SCREENREC_HOME ?? path.join(os.homedir(), '.screenrec'); }
export function statePath(): string { return path.join(stateDir(), 'state.json'); }

export function readState(): RecordingState | null {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as RecordingState; } catch { return null; }
}

export function writeState(s: RecordingState): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, statePath());
}

export function clearState(): void { fs.rmSync(statePath(), { force: true }); }

function psCommandLine(pid: number): string | null {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}

export function isRecorderAlive(pid: number, psCommand: (pid: number) => string | null = psCommandLine): boolean {
  const cmd = psCommand(pid);
  return cmd !== null && /screenrec-mac|capture\/cdp\/worker\./.test(cmd);
}
```

`src/core/sidecar.ts`:

```ts
import fs from 'node:fs';
import type { Target } from './targets.ts';

export interface Mark { t: number; text: string }
export interface Sidecar { version: 1; target: Target; startedAt: string; durationSec: number; marks: Mark[] }

export function appendMark(marksFile: string, mark: Mark): void {
  fs.appendFileSync(marksFile, JSON.stringify(mark) + '\n');
}

export function readMarks(marksFile: string): Mark[] {
  if (!fs.existsSync(marksFile)) return [];
  return fs.readFileSync(marksFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Mark);
}

export function writeSidecar(path: string, s: Sidecar): void { fs.writeFileSync(path, JSON.stringify(s, null, 2) + '\n'); }

export function readSidecar(path: string): Sidecar | null {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')) as Sidecar; } catch { return null; }
}

export function retimeMarks(marks: Mark[], keptPts: number[], fps: number): Mark[] {
  const sorted = [...keptPts].sort((a, b) => a - b);
  const countUpTo = (t: number) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return marks.map((m) => ({ ...m, t: Math.round((countUpTo(m.t) / fps) * 1000) / 1000 }));
}
```

- [ ] **Step 4: Run tests** → `npm test`, all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/state.ts src/core/sidecar.ts test/unit/state.test.ts test/unit/sidecar.test.ts
git commit -m "feat(core): state with pid-reuse-safe liveness, marks and sidecar"
```

---

### Task 6: Paths, argument parsing and CLI dispatch (api-core)

**Files:**
- Create: `src/core/paths.ts`, `src/cli/args.ts`, `src/cli/main.ts`, `src/commands/types.ts`, `src/commands/version.ts`
- Test: `test/unit/paths.test.ts`, `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: `ScreenrecError`, `errorJson` (Task 2), `TargetFlags` (Task 4).
- Produces:
  - `recordingsDir(cwd?: string): string` (creates `./recordings` with `.gitignore` `*`)
  - `defaultRecordingBase(now?: Date): string` (`rec-YYYYMMDD-HHMMSS`, local time)
  - `derivedOut(input: string, command: string, ext: string): string` (`<dir>/<base>.<command>.<ext>`, adds `-2`, `-3` if taken)
  - `stripExt(p: string): string`
  - `interface ParsedArgs { command: string; positionals: string[]; values: Record<string, string | boolean | string[] | undefined>; json: boolean }`
  - `parseCli(argv: string[]): ParsedArgs` (throws `E_BAD_ARGS` on unknown command or flag)
  - `parseDuration(s: string): number` (`'10m' | '90s' | '600'` to milliseconds)
  - `interface CommandResult { ok: true; text: string; [key: string]: unknown }`
  - `type CommandFn = (a: ParsedArgs) => Promise<CommandResult>`; every `src/commands/<name>.ts` default-exports one. `main` loads `../commands/<name>.js` by name, so later tasks add commands without editing a shared registry.
  - `requireInput(a: ParsedArgs): string` (first positional, must exist on disk)
  - `numFlag(a: ParsedArgs, name: string, fallback: number): number`
  - `main(argv: string[], io?: { out: (s: string) => void; err: (s: string) => void }): Promise<number>` (returns the exit code)
- Command names and flags (the single source of truth; MCP in Task 20 mirrors it):

| Command | Positionals | Flags |
|---|---|---|
| `version` | | |
| `doctor` | | |
| `list` | `windows\|displays\|tabs` | `--cdp` |
| `start` | | `--window --app --display --display-of --region --tab --cdp --follow-app --ignore-app (multiple) --out --fps --cursor --max --no-meta` |
| `status`, `stop` | | |
| `mark` | `<text>` | |
| `screenshot` | | target flags as `start` (no follow), `--out` |
| `squeeze` | `<in>` | `--out --fps` |
| `crop` | `<in>` | `--rect --trim-edges --out` |
| `blur` | `<in>` | `--box (multiple) --boxes --out` |
| `trim` | `<in>` | `--from --to --out` |
| `gif` | `<in>` | `--width --fps --out` |
| `frame` | `<in>` | `--at --width --out` |
| `mcp` | | |

All commands also accept `--json`.

- [ ] **Step 1: Write the failing tests**

`test/unit/paths.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { recordingsDir, defaultRecordingBase, derivedOut, stripExt } from '../../src/core/paths.ts';

test('recordingsDir creates the folder with a catch-all .gitignore', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
  const d = recordingsDir(cwd);
  assert.equal(d, path.join(cwd, 'recordings'));
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8').trim(), '*');
});

test('defaultRecordingBase is sortable local time', () => {
  assert.equal(defaultRecordingBase(new Date(2026, 9, 17, 9, 5, 7)), 'rec-20261017-090507');
});

test('derivedOut never overwrites and keeps unicode and spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'do-'));
  const input = path.join(dir, 'My Video é.mp4');
  assert.equal(derivedOut(input, 'squeeze', 'mp4'), path.join(dir, 'My Video é.squeeze.mp4'));
  fs.writeFileSync(path.join(dir, 'My Video é.squeeze.mp4'), '');
  assert.equal(derivedOut(input, 'squeeze', 'mp4'), path.join(dir, 'My Video é.squeeze-2.mp4'));
  assert.equal(stripExt('/a/b.c/d.mp4'), '/a/b.c/d');
});
```

`test/unit/cli.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCli, parseDuration } from '../../src/cli/args.ts';
import { main } from '../../src/cli/main.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const capture = () => { const out: string[] = []; const err: string[] = []; return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err }; };

test('parseCli handles flags, repeats and positionals', () => {
  const a = parseCli(['start', '--window', 'Finder:Downloads', '--ignore-app', 'Orca', '--ignore-app', 'Code', '--follow-app', '--json']);
  assert.equal(a.command, 'start');
  assert.equal(a.values.window, 'Finder:Downloads');
  assert.deepEqual(a.values['ignore-app'], ['Orca', 'Code']);
  assert.equal(a.values['follow-app'], true);
  assert.equal(a.json, true);
  assert.deepEqual(parseCli(['mark', 'clicked Download']).positionals, ['clicked Download']);
});

test('unknown command or flag is E_BAD_ARGS', () => {
  assert.throws(() => parseCli(['explode']), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseCli(['start', '--windwo', 'x']), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('parseDuration', () => {
  assert.equal(parseDuration('10m'), 600000); assert.equal(parseDuration('90s'), 90000); assert.equal(parseDuration('600'), 600000);
  assert.throws(() => parseDuration('soon'), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('main prints JSON success and returns 0', async () => {
  const c = capture();
  assert.equal(await main(['version', '--json'], c.io), 0);
  const j = JSON.parse(c.out.join(''));
  assert.equal(j.ok, true); assert.match(j.version, /^\d+\.\d+\.\d+/);
});

test('main prints JSON errors with code and fix, returns 1', async () => {
  const c = capture();
  assert.equal(await main(['explode', '--json'], c.io), 1);
  const j = JSON.parse(c.out.join(''));
  assert.equal(j.ok, false); assert.equal(j.code, 'E_BAD_ARGS'); assert.ok(j.fix.length > 0);
});

test('main prints human text without --json', async () => {
  const c = capture();
  assert.equal(await main(['version'], c.io), 0);
  assert.match(c.out.join(''), /screenrec \d+\.\d+\.\d+/);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`, modules not found.

- [ ] **Step 3: Implement `src/core/paths.ts`**

```ts
import fs from 'node:fs'; import path from 'node:path';

export function recordingsDir(cwd: string = process.cwd()): string {
  const d = path.join(cwd, 'recordings');
  fs.mkdirSync(d, { recursive: true });
  const gi = path.join(d, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  return d;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function defaultRecordingBase(now: Date = new Date()): string {
  return `rec-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function stripExt(p: string): string {
  const ext = path.extname(p);
  return ext ? p.slice(0, -ext.length) : p;
}

export function derivedOut(input: string, command: string, ext: string): string {
  const base = `${stripExt(input)}.${command}`;
  let candidate = `${base}.${ext}`;
  for (let i = 2; fs.existsSync(candidate); i++) candidate = `${base}-${i}.${ext}`;
  return candidate;
}
```

- [ ] **Step 4: Implement `src/commands/types.ts`**

```ts
import fs from 'node:fs';
import { ScreenrecError } from '../core/errors.ts';

export interface ParsedArgs {
  command: string; positionals: string[];
  values: Record<string, string | boolean | string[] | undefined>; json: boolean;
}
export interface CommandResult { ok: true; text: string; [key: string]: unknown }
export type CommandFn = (a: ParsedArgs) => Promise<CommandResult>;

export function requireInput(a: ParsedArgs): string {
  const input = a.positionals[0];
  if (!input) throw new ScreenrecError('E_BAD_ARGS', `"${a.command}" needs an input file`, `Usage: screenrec ${a.command} <file> [flags]`);
  if (!fs.existsSync(input)) throw new ScreenrecError('E_BAD_ARGS', `Input not found: ${input}`, 'Check the path; quote it if it contains spaces.');
  return input;
}

export function numFlag(a: ParsedArgs, name: string, fallback: number): number {
  const v = a.values[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ScreenrecError('E_BAD_ARGS', `--${name} must be a positive number, got "${String(v)}"`, `Example: --${name} ${fallback}`);
  return n;
}
```

- [ ] **Step 5: Implement `src/cli/args.ts`**

```ts
import { parseArgs } from 'node:util';
import { ScreenrecError } from '../core/errors.ts';
import type { ParsedArgs } from '../commands/types.ts';

type Opt = { type: 'string' | 'boolean'; multiple?: boolean };
const S: Opt = { type: 'string' }; const B: Opt = { type: 'boolean' };
const target = { window: S, app: S, display: S, 'display-of': S, region: S, tab: S, cdp: S };

export const COMMANDS: Record<string, Record<string, Opt>> = {
  version: {}, doctor: {}, status: {}, stop: {}, mcp: {},
  list: { cdp: S },
  start: { ...target, 'follow-app': B, 'ignore-app': { type: 'string', multiple: true }, out: S, fps: S, cursor: B, max: S, 'no-meta': B },
  mark: {},
  screenshot: { ...target, out: S },
  squeeze: { out: S, fps: S },
  crop: { rect: S, 'trim-edges': S, out: S },
  blur: { box: { type: 'string', multiple: true }, boxes: S, out: S },
  trim: { from: S, to: S, out: S },
  gif: { width: S, fps: S, out: S },
  frame: { at: S, width: S, out: S },
};

export function parseCli(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !(command in COMMANDS)) {
    throw new ScreenrecError('E_BAD_ARGS', command ? `Unknown command "${command}"` : 'No command given',
      `Commands: ${Object.keys(COMMANDS).join(', ')}`);
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, strict: true,
      options: { ...COMMANDS[command], json: B, help: B },
    });
    const json = values.json === true;
    delete (values as Record<string, unknown>).json;
    return { command, positionals, values: values as ParsedArgs['values'], json };
  } catch (e) {
    throw new ScreenrecError('E_BAD_ARGS', (e as Error).message, `Run "screenrec ${command} --help" for the flags it accepts.`);
  }
}

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new ScreenrecError('E_BAD_ARGS', `Bad duration "${s}"`, 'Use e.g. 90s, 10m, 1h or plain seconds.');
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  return Math.round(n * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit]!);
}
```

- [ ] **Step 6: Implement `src/commands/version.ts` and `src/cli/main.ts`**

`src/commands/version.ts`:

```ts
import fs from 'node:fs';
import type { CommandFn } from './types.ts';

const version: CommandFn = async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return { ok: true, text: `screenrec ${pkg.version}`, version: pkg.version };
};
export default version;
```

`src/cli/main.ts`:

```ts
import { parseCli } from './args.ts';
import { errorJson } from '../core/errors.ts';
import type { CommandFn } from '../commands/types.ts';

export interface Io { out: (s: string) => void; err: (s: string) => void }
const defaultIo: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const json = argv.includes('--json');
  try {
    const a = parseCli(argv);
    const mod = (await import(`../commands/${a.command}.js`).catch(() => import(`../commands/${a.command}.ts`))) as { default: CommandFn };
    const result = await mod.default(a);
    io.out(a.json ? JSON.stringify(result) + '\n' : result.text + '\n');
    return 0;
  } catch (e) {
    const j = errorJson(e);
    if (process.env.SCREENREC_DEBUG === '1' && e instanceof Error) io.err(String(e.stack) + '\n');
    if (json) io.out(JSON.stringify(j) + '\n');
    else io.err(`error ${j.code}: ${j.message}\nfix: ${j.fix}\n${j.candidates ? j.candidates.map((c) => `  ${c}`).join('\n') + '\n' : ''}`);
    return 1;
  }
}
```

Note: the `.js` then `.ts` import covers both the built package (`dist/`) and tests run through `tsx`.

- [ ] **Step 7: Run tests and typecheck** → `npm test && npm run typecheck`, all pass.

- [ ] **Step 8: Build and smoke the real binary**

```bash
npm run build && ./bin/screenrec version && ./bin/screenrec explode --json; echo "exit=$?"
```

Expected: `screenrec 0.1.0`, then a JSON error with `"code":"E_BAD_ARGS"` and `exit=1`.

- [ ] **Step 9: Commit**

```bash
git add src/core/paths.ts src/cli src/commands test/unit/paths.test.ts test/unit/cli.test.ts
git commit -m "feat(cli): argument parsing, dispatch and JSON output"
```

---

### Task 7: ffmpeg runner and squeeze (video-edit)

**Files:**
- Create: `src/edit/ffmpeg.ts`, `src/edit/squeeze.ts`, `src/commands/squeeze.ts`
- Create: `test/video/helpers.ts`
- Test: `test/unit/squeeze.test.ts`, `test/video/squeeze.test.ts`

**Interfaces:**
- Consumes: `ScreenrecError` (2), `derivedOut`, `stripExt` (6), `readSidecar`, `writeSidecar`, `retimeMarks` (5), `requireInput`, `numFlag`, `CommandFn` (6).
- Produces:
  - `ffmpegBin(): string`, `ffprobeBin(): string` (env `SCREENREC_FFMPEG` / `SCREENREC_FFPROBE` override)
  - `requireFfmpeg(): Promise<string>` (first line of `ffmpeg -version`; throws `E_NO_FFMPEG`)
  - `runFfmpeg(args: string[]): Promise<string>` (stderr text; throws `E_FFMPEG_FAILED` with the last 15 stderr lines)
  - `interface Probe { duration: number; width: number; height: number; fps: number }`, `probe(file: string): Promise<Probe>`
  - `ENCODE: string[]` = `['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']`
  - `MPDECIMATE = 'mpdecimate=hi=768:lo=320:frac=0.5'`
  - `squeezeArgs(input: string, output: string, fps: number): string[]`
  - `parseShowinfoPts(stderr: string): number[]`
  - `squeeze(input: string, opts?: { out?: string; fps?: number }): Promise<{ out: string; beforeSec: number; afterSec: number; sidecar?: string }>`
  - test helpers: `makeVideo(file: string, kind: 'moving' | 'moving-frozen-moving', opts?: { size?: string; seconds?: number }): Promise<void>`, `grayRegion(file: string, atSec: number, r: Rect): Promise<Buffer>`, `detail(buf: Buffer, width: number): number`, `meanAbsDiff(a: Buffer, b: Buffer): number`

- [ ] **Step 1: Write the failing unit test**

`test/unit/squeeze.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squeezeArgs, parseShowinfoPts } from '../../src/edit/squeeze.ts';

test('squeezeArgs builds an argument array, no shell, paths untouched', () => {
  const a = squeezeArgs('/v/My Clip é.mp4', '/v/out file.mp4', 30);
  assert.equal(a[a.indexOf('-i') + 1], '/v/My Clip é.mp4');
  assert.equal(a.at(-1), '/v/out file.mp4');
  assert.ok(a.includes('mpdecimate=hi=768:lo=320:frac=0.5,setpts=N/30/TB'));
  assert.ok(a.includes('yuv420p'));
});

test('parseShowinfoPts reads pts_time values in order', () => {
  const s = '[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0       duration\n[Parsed_showinfo_1 @ 0x1] n:   1 pts:   6000 pts_time:2.033333 x\n';
  assert.deepEqual(parseShowinfoPts(s), [0, 2.033333]);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`, module not found.

- [ ] **Step 3: Implement `src/edit/ffmpeg.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ScreenrecError } from '../core/errors.ts';

const exec = promisify(execFile);
export const ffmpegBin = () => process.env.SCREENREC_FFMPEG ?? 'ffmpeg';
export const ffprobeBin = () => process.env.SCREENREC_FFPROBE ?? 'ffprobe';
export const ENCODE = ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
export const MPDECIMATE = 'mpdecimate=hi=768:lo=320:frac=0.5';

const noFfmpeg = () => new ScreenrecError('E_NO_FFMPEG', 'ffmpeg was not found',
  'Install it (macOS: brew install ffmpeg; Windows: winget install ffmpeg; Linux: your package manager), or set SCREENREC_FFMPEG.');

export async function requireFfmpeg(): Promise<string> {
  try { const { stdout } = await exec(ffmpegBin(), ['-version']); return stdout.split('\n')[0]; }
  catch { throw noFfmpeg(); }
}

export async function runFfmpeg(args: string[]): Promise<string> {
  try {
    const { stderr } = await exec(ffmpegBin(), ['-hide_banner', ...args], { maxBuffer: 256 * 1024 * 1024 });
    return stderr;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') throw noFfmpeg();
    const tail = String(err.stderr ?? err.message).trim().split('\n').slice(-15).join('\n');
    throw new ScreenrecError('E_FFMPEG_FAILED', `ffmpeg failed:\n${tail}`, 'Check the input file plays; re-run with SCREENREC_DEBUG=1 for the full command.');
  }
}

export interface Probe { duration: number; width: number; height: number; fps: number }

export async function probe(file: string): Promise<Probe> {
  try {
    const { stdout } = await exec(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate:format=duration', '-of', 'json', file]);
    const j = JSON.parse(stdout) as { streams: { width: number; height: number; avg_frame_rate: string }[]; format: { duration: string } };
    const [n, d] = j.streams[0].avg_frame_rate.split('/').map(Number);
    return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration), fps: d ? n / d : n };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw noFfmpeg();
    throw new ScreenrecError('E_FFMPEG_FAILED', `Could not read video info from ${file}`, 'Is it a finished, playable video file?');
  }
}
```

- [ ] **Step 4: Implement `src/edit/squeeze.ts` and `src/commands/squeeze.ts`**

`src/edit/squeeze.ts`:

```ts
import { runFfmpeg, probe, ENCODE, MPDECIMATE } from './ffmpeg.ts';
import { derivedOut, stripExt } from '../core/paths.ts';
import { readSidecar, writeSidecar, retimeMarks } from '../core/sidecar.ts';

export function squeezeArgs(input: string, output: string, fps: number): string[] {
  return ['-v', 'error', '-y', '-i', input, '-vf', `${MPDECIMATE},setpts=N/${fps}/TB`, '-r', String(fps), '-an', ...ENCODE, output];
}

export function parseShowinfoPts(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
}

export async function squeeze(input: string, opts: { out?: string; fps?: number } = {}) {
  const fps = opts.fps ?? 30;
  const out = opts.out ?? derivedOut(input, 'squeeze', 'mp4');
  const beforeSec = (await probe(input)).duration;
  await runFfmpeg(squeezeArgs(input, out, fps));
  const afterSec = (await probe(out)).duration;
  let sidecar: string | undefined;
  const sc = readSidecar(`${stripExt(input)}.json`);
  if (sc) {
    const kept = parseShowinfoPts(await runFfmpeg(['-v', 'info', '-i', input, '-vf', `${MPDECIMATE},showinfo`, '-f', 'null', '-']));
    sidecar = `${stripExt(out)}.json`;
    writeSidecar(sidecar, { ...sc, durationSec: afterSec, marks: retimeMarks(sc.marks, kept, fps) });
  }
  return { out, beforeSec, afterSec, sidecar };
}
```

`src/commands/squeeze.ts`:

```ts
import { squeeze } from '../edit/squeeze.ts';
import { requireInput, numFlag, type CommandFn } from './types.ts';

const cmd: CommandFn = async (a) => {
  const r = await squeeze(requireInput(a), { out: a.values.out as string | undefined, fps: numFlag(a, 'fps', 30) });
  return { ok: true, text: `squeezed ${r.beforeSec.toFixed(1)} s to ${r.afterSec.toFixed(1)} s: ${r.out}`, ...r };
};
export default cmd;
```

- [ ] **Step 5: Run unit tests** → `npm test`, pass.

- [ ] **Step 6: Write video test helpers and the failing video test**

`test/video/helpers.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Rect } from '../../src/core/geometry.ts';
const exec = promisify(execFile);

export async function makeVideo(file: string, kind: 'moving' | 'moving-frozen-moving', opts: { size?: string; seconds?: number } = {}) {
  const size = opts.size ?? '320x240';
  const src = kind === 'moving'
    // noise gives every region real detail, so blur measurements are stable
    ? `testsrc2=size=${size}:rate=30:duration=${opts.seconds ?? 2},noise=alls=40:allf=t+u`
    // 2 s moving, frame 59 held for 120 frames (4 s), then 2 s moving: 8 s total
    : `testsrc2=size=${size}:rate=30:duration=4,loop=loop=120:size=1:start=59,setpts=N/30/TB`;
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', file]);
}

export async function grayRegion(file: string, atSec: number, r: Rect): Promise<Buffer> {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1',
    '-vf', `crop=${r.width}:${r.height}:${r.x}:${r.y},format=gray`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 << 20 });
  return stdout as unknown as Buffer;
}

/** Mean absolute difference between horizontal neighbours: high for detailed images, low for blurred ones. */
export function detail(buf: Buffer, width: number): number {
  let sum = 0, n = 0;
  for (let i = 0; i < buf.length - 1; i++) { if ((i + 1) % width === 0) continue; sum += Math.abs(buf[i] - buf[i + 1]); n++; }
  return sum / n;
}

export function meanAbsDiff(a: Buffer, b: Buffer): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length;
}
```

`test/video/squeeze.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeVideo } from './helpers.ts';
import { squeeze } from '../../src/edit/squeeze.ts';
import { writeSidecar, readSidecar } from '../../src/core/sidecar.ts';

test('squeeze removes a 4 s frozen stretch and retimes marks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
  const input = path.join(dir, 'clip with space.mp4');
  await makeVideo(input, 'moving-frozen-moving');
  writeSidecar(path.join(dir, 'clip with space.json'), { version: 1, target: { kind: 'display', display: 'main' },
    startedAt: '2026-10-17T00:00:00Z', durationSec: 8, marks: [{ t: 7, text: 'late step' }] });
  const r = await squeeze(input);
  assert.ok(r.beforeSec > 7.8 && r.beforeSec < 8.2, `before ${r.beforeSec}`);
  assert.ok(r.afterSec > 3.5 && r.afterSec < 5.0, `after ${r.afterSec}`);
  const sc = readSidecar(r.sidecar!)!;
  assert.ok(sc.marks[0].t > 2.5 && sc.marks[0].t < 4.0, `mark ${sc.marks[0].t}`);
  assert.ok(fs.existsSync(input), 'input untouched');
});
```

- [ ] **Step 7: Run the video test** → `npm run test:video`. Expected: PASS. If `afterSec` is outside the bounds, print `ffprobe` output for both files and adjust only the test video construction, never the bounds.

- [ ] **Step 8: Commit**

```bash
git add src/edit/ffmpeg.ts src/edit/squeeze.ts src/commands/squeeze.ts test/unit/squeeze.test.ts test/video
git commit -m "feat(edit): ffmpeg runner and squeeze with mark retiming"
```

---

### Task 8: Crop, trim and frame (video-edit)

**Files:**
- Create: `src/edit/crop.ts`, `src/edit/trim.ts`, `src/edit/frame.ts`, `src/commands/crop.ts`, `src/commands/trim.ts`, `src/commands/frame.ts`
- Test: `test/unit/crop.test.ts`, `test/video/crop-trim-frame.test.ts`

**Interfaces:**
- Consumes: Task 7 exports, `even` and `Rect` (3), `derivedOut`, `stripExt` (6), sidecar functions (5).
- Produces:
  - `parseRect(s: string): Rect` (`x,y,w,h`, throws `E_BAD_ARGS`)
  - `cropRect(frame: { width: number; height: number }, opts: { rect?: Rect; trimEdges?: number }): Rect` (even sizes; throws `E_BAD_ARGS` if outside the frame or neither option given)
  - `cropArgs(input: string, output: string, r: Rect): string[]`
  - `crop(input: string, opts: { rect?: Rect; trimEdges?: number; out?: string }): Promise<{ out: string; rect: Rect }>`
  - `trimArgs(input: string, output: string, from: number, to: number): string[]`
  - `trim(input: string, opts: { from: number; to: number; out?: string }): Promise<{ out: string; durationSec: number; sidecar?: string }>` (marks inside the range shift by `-from`; others dropped)
  - `frameArgs(input: string, output: string, at: number, width?: number): string[]`
  - `frame(input: string, opts: { at: number; width?: number; out?: string }): Promise<{ out: string }>`

- [ ] **Step 1: Write the failing unit test**

`test/unit/crop.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRect, cropRect, cropArgs } from '../../src/edit/crop.ts';
import { trimArgs } from '../../src/edit/trim.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

const frame = { width: 1600, height: 1000 };

test('cropRect rounds odd sizes down to even', () => {
  assert.deepEqual(cropRect(frame, { rect: { x: 10, y: 10, width: 333, height: 201 } }), { x: 10, y: 10, width: 332, height: 200 });
});

test('trimEdges removes an equal border', () => {
  assert.deepEqual(cropRect(frame, { trimEdges: 8 }), { x: 8, y: 8, width: 1584, height: 984 });
});

test('cropRect rejects a rectangle outside the frame, or no option', () => {
  assert.throws(() => cropRect(frame, { rect: { x: 1500, y: 0, width: 200, height: 100 } }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => cropRect(frame, {}), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => parseRect('1,2,3'), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('cropArgs and trimArgs are argument arrays', () => {
  assert.ok(cropArgs('in.mp4', 'out.mp4', { x: 1, y: 2, width: 4, height: 6 }).includes('crop=4:6:1:2'));
  const t = trimArgs('in.mp4', 'out.mp4', 2, 5);
  assert.deepEqual(t.slice(0, 8), ['-v', 'error', '-y', '-ss', '2', '-to', '5', '-i']);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`.

- [ ] **Step 3: Implement**

`src/edit/crop.ts`:

```ts
import { runFfmpeg, probe, ENCODE } from './ffmpeg.ts';
import { even, type Rect } from '../core/geometry.ts';
import { derivedOut } from '../core/paths.ts';
import { ScreenrecError } from '../core/errors.ts';

export function parseRect(s: string): Rect {
  const n = s.split(',').map((v) => Number(v.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new ScreenrecError('E_BAD_ARGS', `Bad rectangle "${s}"`, 'Use x,y,width,height in output pixels, e.g. --rect 0,80,1600,900');
  }
  return { x: n[0], y: n[1], width: n[2], height: n[3] };
}

export function cropRect(frame: { width: number; height: number }, opts: { rect?: Rect; trimEdges?: number }): Rect {
  let r: Rect;
  if (opts.rect) r = opts.rect;
  else if (opts.trimEdges !== undefined) { const t = opts.trimEdges; r = { x: t, y: t, width: frame.width - 2 * t, height: frame.height - 2 * t }; }
  else throw new ScreenrecError('E_BAD_ARGS', 'crop needs --rect or --trim-edges', 'Example: screenrec crop in.mp4 --trim-edges 8');
  const out = { x: Math.round(r.x), y: Math.round(r.y), width: even(r.width), height: even(r.height) };
  if (out.x < 0 || out.y < 0 || out.x + out.width > frame.width || out.y + out.height > frame.height || r.width < 2 || r.height < 2) {
    throw new ScreenrecError('E_BAD_ARGS', `Crop ${out.x},${out.y},${out.width},${out.height} is outside the ${frame.width}x${frame.height} frame`,
      'Measure with "screenrec frame <in> --at <s>" and use output pixels.');
  }
  return out;
}

export function cropArgs(input: string, output: string, r: Rect): string[] {
  return ['-v', 'error', '-y', '-i', input, '-vf', `crop=${r.width}:${r.height}:${r.x}:${r.y}`, '-an', ...ENCODE, output];
}

export async function crop(input: string, opts: { rect?: Rect; trimEdges?: number; out?: string }) {
  const p = await probe(input);
  const rect = cropRect(p, opts);
  const out = opts.out ?? derivedOut(input, 'crop', 'mp4');
  await runFfmpeg(cropArgs(input, out, rect));
  return { out, rect };
}
```

`src/edit/trim.ts`:

```ts
import { runFfmpeg, probe, ENCODE } from './ffmpeg.ts';
import { derivedOut, stripExt } from '../core/paths.ts';
import { readSidecar, writeSidecar } from '../core/sidecar.ts';
import { ScreenrecError } from '../core/errors.ts';

export function trimArgs(input: string, output: string, from: number, to: number): string[] {
  return ['-v', 'error', '-y', '-ss', String(from), '-to', String(to), '-i', input, '-an', ...ENCODE, output];
}

export async function trim(input: string, opts: { from: number; to: number; out?: string }) {
  if (!(opts.to > opts.from && opts.from >= 0)) throw new ScreenrecError('E_BAD_ARGS', `--from ${opts.from} --to ${opts.to} is empty`, 'Use --from < --to, in seconds.');
  const out = opts.out ?? derivedOut(input, 'trim', 'mp4');
  await runFfmpeg(trimArgs(input, out, opts.from, opts.to));
  const durationSec = (await probe(out)).duration;
  let sidecar: string | undefined;
  const sc = readSidecar(`${stripExt(input)}.json`);
  if (sc) {
    sidecar = `${stripExt(out)}.json`;
    const marks = sc.marks.filter((m) => m.t >= opts.from && m.t <= opts.to).map((m) => ({ ...m, t: Math.round((m.t - opts.from) * 1000) / 1000 }));
    writeSidecar(sidecar, { ...sc, durationSec, marks });
  }
  return { out, durationSec, sidecar };
}
```

`src/edit/frame.ts`:

```ts
import { runFfmpeg } from './ffmpeg.ts';
import { derivedOut } from '../core/paths.ts';

export function frameArgs(input: string, output: string, at: number, width?: number): string[] {
  return ['-v', 'error', '-y', '-ss', String(at), '-i', input, '-frames:v', '1', ...(width ? ['-vf', `scale=${width}:-2`] : []), output];
}

export async function frame(input: string, opts: { at: number; width?: number; out?: string }) {
  const out = opts.out ?? derivedOut(input, `frame-${opts.at}s`, 'png');
  await runFfmpeg(frameArgs(input, out, opts.at, opts.width));
  return { out };
}
```

Commands (`src/commands/crop.ts`, `trim.ts`, `frame.ts`):

```ts
// src/commands/crop.ts
import { crop, parseRect } from '../edit/crop.ts';
import { requireInput, numFlag, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const r = await crop(requireInput(a), {
    rect: a.values.rect ? parseRect(a.values.rect as string) : undefined,
    trimEdges: a.values['trim-edges'] !== undefined ? numFlag(a, 'trim-edges', 8) : undefined,
    out: a.values.out as string | undefined,
  });
  return { ok: true, text: `cropped to ${r.rect.width}x${r.rect.height}: ${r.out}`, ...r };
};
export default cmd;
```

```ts
// src/commands/trim.ts
import { trim } from '../edit/trim.ts';
import { requireInput, type CommandFn } from './types.ts';
import { ScreenrecError } from '../core/errors.ts';
const cmd: CommandFn = async (a) => {
  const from = Number(a.values.from ?? 0); const to = Number(a.values.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ScreenrecError('E_BAD_ARGS', 'trim needs --to (and optional --from) in seconds', 'Example: screenrec trim in.mp4 --from 3 --to 40');
  const r = await trim(requireInput(a), { from, to, out: a.values.out as string | undefined });
  return { ok: true, text: `trimmed to ${r.durationSec.toFixed(1)} s: ${r.out}`, ...r };
};
export default cmd;
```

```ts
// src/commands/frame.ts
import { frame } from '../edit/frame.ts';
import { requireInput, numFlag, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const at = Number(a.values.at ?? 0);
  const r = await frame(requireInput(a), { at, width: a.values.width ? numFlag(a, 'width', 800) : undefined, out: a.values.out as string | undefined });
  return { ok: true, text: `frame at ${at} s: ${r.out}`, ...r };
};
export default cmd;
```

- [ ] **Step 4: Run unit tests** → `npm test`, pass.

- [ ] **Step 5: Write and run the video test**

`test/video/crop-trim-frame.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeVideo } from './helpers.ts';
import { crop } from '../../src/edit/crop.ts';
import { trim } from '../../src/edit/trim.ts';
import { frame } from '../../src/edit/frame.ts';
import { probe } from '../../src/edit/ffmpeg.ts';

test('crop, trim and frame produce the expected sizes and durations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctf-'));
  const input = path.join(dir, 'in.mp4');
  await makeVideo(input, 'moving', { seconds: 8 });
  const c = await crop(input, { rect: { x: 10, y: 10, width: 101, height: 51 } });
  const pc = await probe(c.out); assert.equal(pc.width, 100); assert.equal(pc.height, 50);
  const t = await trim(input, { from: 2, to: 5 });
  assert.ok(t.durationSec > 2.8 && t.durationSec < 3.2, `trim ${t.durationSec}`);
  const f = await frame(input, { at: 1, width: 160 });
  const pf = await probe(f.out); assert.equal(pf.width, 160);
});
```

Run: `npm run test:video` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/edit/crop.ts src/edit/trim.ts src/edit/frame.ts src/commands/crop.ts src/commands/trim.ts src/commands/frame.ts test/unit/crop.test.ts test/video/crop-trim-frame.test.ts
git commit -m "feat(edit): crop, trim and frame"
```

---

### Task 9: Blur boxes, static and keyframed (video-edit)

**Files:**
- Create: `src/edit/blur.ts`, `src/commands/blur.ts`, `examples/blur-boxes.json`
- Test: `test/unit/blur.test.ts`, `test/video/blur.test.ts`

**Interfaces:**
- Consumes: Task 7 exports, `derivedOut` (6), `ScreenrecError` (2).
- Produces:
  - `interface Keyframe { t: number; x: number; y: number }`
  - `interface BlurBox { w: number; h: number; x?: number; y?: number; from?: number; to?: number; keyframes?: Keyframe[] }`
  - `parseBoxFlag(s: string): BlurBox` (`x,y,w,h` or `x,y,w,h@t0-t1`)
  - `loadBoxes(file: string): BlurBox[]`
  - `validateBoxes(boxes: BlurBox[], frame: { width: number; height: number }): void` (min 8x8 px; static boxes and every keyframe inside the frame; keyframes strictly increasing in `t`)
  - `lerpExpr(kfs: Keyframe[], axis: 'x' | 'y'): string`
  - `blurGraph(boxes: BlurBox[]): { graph: string; out: string }`
  - `blur(input: string, opts: { boxes: BlurBox[]; out?: string }): Promise<{ out: string; boxes: number }>`

- [ ] **Step 1: Write the failing unit test**

`test/unit/blur.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoxFlag, lerpExpr, blurGraph, validateBoxes } from '../../src/edit/blur.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

test('parseBoxFlag with and without a time window', () => {
  assert.deepEqual(parseBoxFlag('10,20,300,40'), { x: 10, y: 20, w: 300, h: 40 });
  assert.deepEqual(parseBoxFlag('10,20,300,40@2.0-5.5'), { x: 10, y: 20, w: 300, h: 40, from: 2, to: 5.5 });
  assert.throws(() => parseBoxFlag('10,20,300'), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('lerpExpr: constant for one keyframe, clamped piecewise-linear for several', () => {
  assert.equal(lerpExpr([{ t: 1, x: 40, y: 600 }], 'x'), '40');
  const e = lerpExpr([{ t: 2, x: 40, y: 600 }, { t: 4.5, x: 40, y: 120 }], 'y');
  assert.equal(e, 'if(lt(t,2),600,if(lt(t,4.5),600+(-480)*(t-2)/2.5,120))');
});

test('blurGraph chains one pixelate+blur+overlay per box with time windows', () => {
  const g = blurGraph([{ x: 10, y: 20, w: 120, h: 40 }, { w: 60, h: 40, keyframes: [{ t: 0, x: 20, y: 100 }, { t: 1.5, x: 220, y: 100 }] }]);
  assert.equal(g.out, 'v1');
  assert.match(g.graph, /^\[0:v\]split=3\[base\]\[s0\]\[s1\];/);
  assert.match(g.graph, /\[s0\]crop=w=120:h=40:x='max\(0,min\(iw-120,10\)\)'/);
  assert.match(g.graph, /flags=neighbor,scale=120:40:flags=neighbor,boxblur=/);
  assert.match(g.graph, /overlay=x='[^']+':y='[^']+':enable='between\(t,0,1.5\)'\[v1\]$/);
});

test('validateBoxes rejects tiny or out-of-frame boxes and unsorted keyframes', () => {
  const f = { width: 320, height: 240 };
  assert.throws(() => validateBoxes([{ x: 0, y: 0, w: 4, h: 4 }], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => validateBoxes([{ x: 300, y: 0, w: 40, h: 40 }], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  assert.throws(() => validateBoxes([{ w: 40, h: 40, keyframes: [{ t: 2, x: 0, y: 0 }, { t: 1, x: 0, y: 0 }] }], f), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  validateBoxes([{ x: 0, y: 0, w: 40, h: 40 }], f);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`.

- [ ] **Step 3: Implement `src/edit/blur.ts`**

```ts
import fs from 'node:fs';
import { runFfmpeg, probe, ENCODE } from './ffmpeg.ts';
import { derivedOut } from '../core/paths.ts';
import { ScreenrecError } from '../core/errors.ts';

export interface Keyframe { t: number; x: number; y: number }
export interface BlurBox { w: number; h: number; x?: number; y?: number; from?: number; to?: number; keyframes?: Keyframe[] }

const bad = (m: string) => new ScreenrecError('E_BAD_ARGS', m,
  'Boxes are x,y,w,h in output pixels (optionally @from-to seconds), at least 8x8, inside the frame. Measure with "screenrec frame".');

export function parseBoxFlag(s: string): BlurBox {
  const m = /^(\d+),(\d+),(\d+),(\d+)(?:@([\d.]+)-([\d.]+))?$/.exec(s.trim());
  if (!m) throw bad(`Bad --box "${s}"`);
  const b: BlurBox = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
  if (m[5] !== undefined) { b.from = +m[5]; b.to = +m[6]; }
  return b;
}

export function loadBoxes(file: string): BlurBox[] {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(j)) throw new Error('not an array'); return j as BlurBox[]; }
  catch (e) { throw bad(`Could not read boxes from ${file}: ${(e as Error).message}`); }
}

export function validateBoxes(boxes: BlurBox[], frame: { width: number; height: number }): void {
  if (boxes.length === 0) throw bad('No boxes given');
  for (const b of boxes) {
    if (b.w < 8 || b.h < 8) throw bad(`Box ${b.w}x${b.h} is smaller than 8x8`);
    const points = b.keyframes ?? [{ t: 0, x: b.x ?? -1, y: b.y ?? -1 }];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.x < 0 || p.y < 0 || p.x + b.w > frame.width || p.y + b.h > frame.height) throw bad(`Box at ${p.x},${p.y} size ${b.w}x${b.h} leaves the ${frame.width}x${frame.height} frame`);
      if (i > 0 && !(p.t > points[i - 1].t)) throw bad('Keyframe times must increase');
    }
  }
}

const num = (n: number) => String(Math.round(n * 1000) / 1000);

export function lerpExpr(kfs: Keyframe[], axis: 'x' | 'y'): string {
  if (kfs.length === 1) return num(kfs[0][axis]);
  let acc = num(kfs[kfs.length - 1][axis]);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i], b = kfs[i + 1];
    acc = `if(lt(t,${num(b.t)}),${num(a[axis])}+(${num(b[axis] - a[axis])})*(t-${num(a.t)})/${num(b.t - a.t)},${acc})`;
  }
  return `if(lt(t,${num(kfs[0].t)}),${num(kfs[0][axis])},${acc})`;
}

export function blurGraph(boxes: BlurBox[]): { graph: string; out: string } {
  const parts = [`[0:v]split=${boxes.length + 1}[base]${boxes.map((_, i) => `[s${i}]`).join('')}`];
  let cur = 'base';
  boxes.forEach((b, i) => {
    const X = b.keyframes ? lerpExpr(b.keyframes, 'x') : num(b.x!);
    const Y = b.keyframes ? lerpExpr(b.keyframes, 'y') : num(b.y!);
    const sw = Math.max(1, Math.round(b.w / 12)), sh = Math.max(1, Math.round(b.h / 12));
    const r = Math.max(1, Math.min(10, Math.floor(Math.min(b.w, b.h) / 4) - 1));
    parts.push(`[s${i}]crop=w=${b.w}:h=${b.h}:x='max(0,min(iw-${b.w},${X}))':y='max(0,min(ih-${b.h},${Y}))',` +
      `scale=${sw}:${sh}:flags=neighbor,scale=${b.w}:${b.h}:flags=neighbor,boxblur=${r}:1[b${i}]`);
    const from = b.from ?? b.keyframes?.[0].t, to = b.to ?? b.keyframes?.at(-1)!.t;
    const enable = from !== undefined && to !== undefined ? `:enable='between(t,${num(from)},${num(to)})'` : '';
    parts.push(`[${cur}][b${i}]overlay=x='max(0,min(main_w-${b.w},${X}))':y='max(0,min(main_h-${b.h},${Y}))'${enable}[v${i}]`);
    cur = `v${i}`;
  });
  return { graph: parts.join(';'), out: cur };
}

export async function blur(input: string, opts: { boxes: BlurBox[]; out?: string }) {
  validateBoxes(opts.boxes, await probe(input));
  const { graph, out: label } = blurGraph(opts.boxes);
  const out = opts.out ?? derivedOut(input, 'blur', 'mp4');
  await runFfmpeg(['-v', 'error', '-y', '-i', input, '-filter_complex', graph, '-map', `[${label}]`, '-an', ...ENCODE, out]);
  return { out, boxes: opts.boxes.length };
}
```

Note on the spec: a keyframed box is active only between its first and last keyframe unless `from`/`to` are given (spec 7). The `enable` line implements exactly that.

`src/commands/blur.ts`:

```ts
import { blur, parseBoxFlag, loadBoxes, type BlurBox } from '../edit/blur.ts';
import { requireInput, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const boxes: BlurBox[] = [
    ...((a.values.box as string[] | undefined) ?? []).map(parseBoxFlag),
    ...(a.values.boxes ? loadBoxes(a.values.boxes as string) : []),
  ];
  const r = await blur(requireInput(a), { boxes, out: a.values.out as string | undefined });
  return { ok: true, text: `blurred ${r.boxes} box(es): ${r.out}`, ...r };
};
export default cmd;
```

`examples/blur-boxes.json`:

```json
[
  { "x": 40, "y": 60, "w": 360, "h": 48 },
  { "w": 300, "h": 40, "keyframes": [{ "t": 2.0, "x": 40, "y": 600 }, { "t": 4.5, "x": 40, "y": 120 }] }
]
```

- [ ] **Step 4: Run unit tests** → `npm test`, pass. If the `lerpExpr` expected string differs only in number formatting, fix `num`, not the test.

- [ ] **Step 5: Write and run the video test**

`test/video/blur.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeVideo, grayRegion, detail, meanAbsDiff } from './helpers.ts';
import { blur } from '../../src/edit/blur.ts';

const box = { x: 100, y: 80, width: 80, height: 60 };
const outside = { x: 0, y: 0, width: 80, height: 60 };

test('static box: detail gone inside, unchanged outside', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
  const input = path.join(dir, 'in.mp4');
  await makeVideo(input, 'moving');
  const { out } = await blur(input, { boxes: [{ x: box.x, y: box.y, w: box.width, h: box.height }] });
  const before = detail(await grayRegion(input, 1, box), box.width);
  const after = detail(await grayRegion(out, 1, box), box.width);
  assert.ok(after < before * 0.25, `inside detail ${before} -> ${after}`);
  const inOut = await grayRegion(input, 1, outside), outOut = await grayRegion(out, 1, outside);
  const diff = meanAbsDiff(inOut, outOut);
  assert.ok(diff < 12, `outside changed by ${diff}`); // re-encode loss only
  assert.ok(detail(outOut, outside.width) > detail(inOut, outside.width) * 0.8, 'outside keeps its detail');
});

test('keyframed box follows its path and is off outside its window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-'));
  const input = path.join(dir, 'in.mp4');
  await makeVideo(input, 'moving', { seconds: 3 });
  const { out } = await blur(input, { boxes: [{ w: 60, h: 40, keyframes: [{ t: 0, x: 20, y: 100 }, { t: 1.5, x: 220, y: 100 }] }] });
  const left = { x: 20, y: 100, width: 60, height: 40 }, right = { x: 220, y: 100, width: 60, height: 40 };
  const d = async (f: string, t: number, r: typeof left) => detail(await grayRegion(f, t, r), r.width);
  assert.ok(await d(out, 0.05, left) < (await d(input, 0.05, left)) * 0.35, 'blurred at the start position');
  assert.ok(await d(out, 1.45, right) < (await d(input, 1.45, right)) * 0.35, 'blurred at the end position');
  assert.ok(await d(out, 1.45, left) > (await d(input, 1.45, left)) * 0.7, 'start position clear once the box moved');
  assert.ok(await d(out, 2.5, right) > (await d(input, 2.5, right)) * 0.7, 'off after the last keyframe');
});
```

Run: `npm run test:video` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/edit/blur.ts src/commands/blur.ts examples/blur-boxes.json test/unit/blur.test.ts test/video/blur.test.ts
git commit -m "feat(edit): pixelate-then-blur boxes, static and keyframed"
```

---

### Task 10: GIF export (video-edit)

**Files:**
- Create: `src/edit/gif.ts`, `src/commands/gif.ts`
- Test: `test/unit/gif.test.ts`, `test/video/gif.test.ts`

**Interfaces:**
- Consumes: Task 7 exports, `derivedOut` (6).
- Produces: `gifArgs(input: string, output: string, width: number, fps: number): string[]`; `gif(input: string, opts?: { width?: number; fps?: number; out?: string }): Promise<{ out: string; bytes: number }>` (defaults width 800, fps 12; width is capped at the source width).

- [ ] **Step 1: Write the failing unit test**

`test/unit/gif.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifArgs } from '../../src/edit/gif.ts';

test('gifArgs uses a two-pass palette in one filter graph', () => {
  const a = gifArgs('in.mp4', 'out.gif', 640, 12);
  const vf = a[a.indexOf('-vf') + 1];
  assert.equal(vf, 'fps=12,scale=640:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5');
  assert.equal(a.at(-1), 'out.gif');
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`.

- [ ] **Step 3: Implement**

`src/edit/gif.ts`:

```ts
import fs from 'node:fs';
import { runFfmpeg, probe } from './ffmpeg.ts';
import { derivedOut } from '../core/paths.ts';

export function gifArgs(input: string, output: string, width: number, fps: number): string[] {
  const vf = `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`;
  return ['-v', 'error', '-y', '-i', input, '-vf', vf, '-loop', '0', output];
}

export async function gif(input: string, opts: { width?: number; fps?: number; out?: string } = {}) {
  const src = await probe(input);
  const width = Math.min(opts.width ?? 800, src.width);
  const out = opts.out ?? derivedOut(input, 'gif', 'gif');
  await runFfmpeg(gifArgs(input, out, width - (width % 2), opts.fps ?? 12));
  return { out, bytes: fs.statSync(out).size };
}
```

`src/commands/gif.ts`:

```ts
import { gif } from '../edit/gif.ts';
import { requireInput, numFlag, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const r = await gif(requireInput(a), { width: numFlag(a, 'width', 800), fps: numFlag(a, 'fps', 12), out: a.values.out as string | undefined });
  return { ok: true, text: `gif ${(r.bytes / 1024 / 1024).toFixed(2)} MB: ${r.out}`, ...r };
};
export default cmd;
```

- [ ] **Step 4: Write and run the video test**

`test/video/gif.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeVideo } from './helpers.ts';
import { gif } from '../../src/edit/gif.ts';

test('gif is created, starts with the GIF signature and stays small', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-'));
  const input = path.join(dir, 'in.mp4');
  await makeVideo(input, 'moving', { seconds: 2 });
  const r = await gif(input, { width: 1000 });
  assert.equal(fs.readFileSync(r.out).subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.ok(r.bytes > 10_000 && r.bytes < 3_000_000, `bytes ${r.bytes}`);
});
```

Run: `npm test && npm run test:video` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/edit/gif.ts src/commands/gif.ts test/unit/gif.test.ts test/video/gif.test.ts
git commit -m "feat(edit): two-pass palette gif export"
```

---

### Task 11: Swift helper: package, listing, permission (mac-capture)

The helper is deliberately thin: it lists, captures and writes. All decisions (which window, what size, file names) are made in TypeScript (Task 14), where they are unit-tested. Swift has no XCTest dependency, because Command Line Tools installs may not ship XCTest; the helper is tested through Node smoke tests and the Task 23 matrix.

**Files:**
- Create: `native/macos/Package.swift`
- Create: `native/macos/Sources/screenrec-mac/main.swift`, `Json.swift`, `Listing.swift`
- Create: `scripts/build-native.mjs`
- Test: `test/mac-smoke/helper.test.ts` (runs only on macOS with the binary built)

**Interfaces (helper command line, JSON lines on stdout):**
- `screenrec-mac displays` → `{"ok":true,"displays":[{"id","name","x","y","width","height","scale","main"}]}` (points, global top-left coordinates; same shape as `Display` in Task 3)
- `screenrec-mac windows` → `{"ok":true,"windows":[{"id","app","title","x","y","width","height","onScreen","z","pid"}]}` (layer-0 windows at least 50x50 points; `z` 0 is frontmost, 9999 if not on screen; same shape as `WindowInfo` in Task 4)
- `screenrec-mac permission [--request]` → `{"ok":true,"granted":bool}`
- Errors: `{"ok":false,"code":"E_PERMISSION"|"E_TARGET_NOT_FOUND"|"E_BAD_ARGS"|"E_NO_FRAMES"|"E_HELPER_CRASHED","message":"..."}`, exit 1
- Later tasks add `screenshot` (12) and `record` (13).

- [ ] **Step 1: Write the smoke test first**

`test/mac-smoke/helper.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const bin = new URL('../../bin/screenrec-mac', import.meta.url).pathname;
const skip = process.platform !== 'darwin' || !fs.existsSync(bin) ? 'needs macOS and npm run build:native' : false;
const run = (...args: string[]) => JSON.parse(execFileSync(bin, args, { encoding: 'utf8' }).trim().split('\n').at(-1)!);

test('displays lists at least the main display with a scale', { skip }, () => {
  const r = run('displays');
  assert.equal(r.ok, true);
  assert.ok(r.displays.length >= 1);
  const main = r.displays.find((d: { main: boolean }) => d.main);
  assert.ok(main && main.scale >= 1 && main.width > 0);
});

test('permission reports a boolean', { skip }, () => {
  assert.equal(typeof run('permission').granted, 'boolean');
});

test('windows returns layer-0 windows with z order', { skip }, () => {
  const r = run('windows');
  assert.equal(r.ok, true);
  for (const w of r.windows) { assert.equal(typeof w.id, 'number'); assert.equal(typeof w.z, 'number'); assert.ok(w.width >= 50); }
});
```

Add to `package.json` scripts: `"test:mac-smoke": "node --import tsx --test \"test/mac-smoke/**/*.test.ts\""`.

- [ ] **Step 2: Run to see it skip** → `npm run test:mac-smoke`. Expected: tests reported as skipped (binary not built yet).

- [ ] **Step 3: Write the package and sources**

`native/macos/Package.swift`:

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "screenrec-mac",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "screenrec-mac", path: "Sources/screenrec-mac")]
)
```

`native/macos/Sources/screenrec-mac/Json.swift`:

```swift
import Foundation

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "message": message])
    exit(1)
}

struct Args {
    let command: String
    private var values: [String: [String]] = [:]

    init(_ argv: [String]) {
        command = argv.first ?? ""
        var i = 1
        while i < argv.count {
            let a = argv[i]
            guard a.hasPrefix("--") else { i += 1; continue }
            let key = String(a.dropFirst(2))
            if i + 1 < argv.count, !argv[i + 1].hasPrefix("--") {
                values[key, default: []].append(argv[i + 1]); i += 2
            } else {
                values[key, default: []].append("true"); i += 1
            }
        }
    }

    func str(_ k: String) -> String? { values[k]?.last }
    func all(_ k: String) -> [String] { values[k] ?? [] }
    func bool(_ k: String) -> Bool { values[k] != nil }
    func int(_ k: String) -> Int? { str(k).flatMap { Int($0) } }
    func double(_ k: String) -> Double? { str(k).flatMap { Double($0) } }
    func nums(_ k: String) -> [Double]? {
        guard let s = str(k) else { return nil }
        let parts = s.split(separator: ",").compactMap { Double(String($0)) }
        return parts.isEmpty ? nil : parts
    }
}

func appendMark(_ file: String?, t: Double, text: String) {
    guard let file else { return }
    let line = (try? JSONSerialization.data(withJSONObject: ["t": (t * 1000).rounded() / 1000, "text": text], options: [.sortedKeys])) ?? Data()
    if !FileManager.default.fileExists(atPath: file) { FileManager.default.createFile(atPath: file, contents: nil) }
    guard let h = FileHandle(forWritingAtPath: file) else { return }
    h.seekToEndOfFile(); h.write(line); h.write(Data([0x0A])); h.closeFile()
}
```

`native/macos/Sources/screenrec-mac/Listing.swift`:

```swift
import AppKit
import ScreenCaptureKit

func displayName(_ id: CGDirectDisplayID) -> String {
    for s in NSScreen.screens {
        if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber, n.uint32Value == id {
            return s.localizedName
        }
    }
    return "Display \(id)"
}

func listDisplays() -> [[String: Any]] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.map { id in
        let b = CGDisplayBounds(id)
        var scale = 1.0
        if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 { scale = Double(mode.pixelWidth) / Double(mode.width) }
        return ["id": Int(id), "name": displayName(id), "x": Double(b.origin.x), "y": Double(b.origin.y),
                "width": Double(b.width), "height": Double(b.height), "scale": scale, "main": CGDisplayIsMain(id) != 0]
    }
}

/// Front-to-back order of on-screen layer-0 windows; 0 is frontmost.
func zOrder() -> [CGWindowID: Int] {
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [:] }
    var z: [CGWindowID: Int] = [:]
    var i = 0
    for w in info where (w[kCGWindowLayer as String] as? Int) == 0 {
        if let n = w[kCGWindowNumber as String] as? Int { z[CGWindowID(n)] = i; i += 1 }
    }
    return z
}

func shareable() async -> SCShareableContent {
    do { return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) }
    catch { fail("E_PERMISSION", "Screen Recording permission is not granted: \(error.localizedDescription)") }
}

func normalWindows(_ content: SCShareableContent) -> [SCWindow] {
    content.windows.filter { $0.windowLayer == 0 && $0.frame.width >= 50 && $0.frame.height >= 50 }
}

func windowDicts(_ content: SCShareableContent) -> [[String: Any]] {
    let z = zOrder()
    return normalWindows(content).map { w in
        ["id": Int(w.windowID), "app": w.owningApplication?.applicationName ?? "", "title": w.title ?? "",
         "x": Double(w.frame.origin.x), "y": Double(w.frame.origin.y), "width": Double(w.frame.width), "height": Double(w.frame.height),
         "onScreen": w.isOnScreen, "z": z[w.windowID] ?? 9999, "pid": Int(w.owningApplication?.processID ?? 0)]
    }
}
```

`native/macos/Sources/screenrec-mac/main.swift`:

```swift
import AppKit

// Command-line tools must initialise AppKit's connection to the window server before
// any ScreenCaptureKit call, or they abort in CGS_REQUIRE_INIT (spike finding).
_ = NSApplication.shared

let args = Args(Array(CommandLine.arguments.dropFirst()))
switch args.command {
case "displays":
    emit(["ok": true, "displays": listDisplays()])
case "windows":
    emit(["ok": true, "windows": windowDicts(await shareable())])
case "permission":
    if args.bool("request") { _ = CGRequestScreenCaptureAccess() }
    emit(["ok": true, "granted": CGPreflightScreenCaptureAccess()])
default:
    fail("E_BAD_ARGS", "unknown command \(args.command)")
}
exit(0)
```

`scripts/build-native.mjs`:

```js
// Builds native/macos into bin/screenrec-mac. Tries a universal binary, falls back to the host architecture.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
if (process.platform !== 'darwin') { console.log('build:native skipped (not macOS)'); process.exit(0); }
const pkg = path.resolve('native/macos'); const out = path.resolve('bin/screenrec-mac');
const build = (extra) => execFileSync('swift', ['build', '-c', 'release', '--package-path', pkg, ...extra], { stdio: 'inherit' });
const productFor = (triple) => path.join(pkg, '.build', triple, 'release', 'screenrec-mac');
try {
  const triples = ['arm64-apple-macosx13.0', 'x86_64-apple-macosx13.0'];
  for (const t of triples) build(['--triple', t]);
  execFileSync('lipo', ['-create', '-output', out, ...triples.map(productFor)], { stdio: 'inherit' });
  console.log(`universal binary: ${out}`);
} catch (e) {
  console.warn(`universal build failed (${e.message.split('\n')[0]}); building host architecture only`);
  build([]);
  fs.copyFileSync(path.join(pkg, '.build', 'release', 'screenrec-mac'), out);
}
fs.chmodSync(out, 0o755);
execFileSync('lipo', ['-info', out], { stdio: 'inherit' });
```

- [ ] **Step 4: Build and run the smoke tests**

Run: `npm run build:native && npm run test:mac-smoke`
Expected: `lipo -info` prints the architectures (record in the commit message whether universal succeeded), and all three smoke tests pass. On this Intel Mac the first optimised build can take several minutes.

- [ ] **Step 5: Commit**

```bash
git add native/macos scripts/build-native.mjs test/mac-smoke package.json
git commit -m "feat(mac): swift helper with display, window and permission listing"
```

---

### Task 12: Swift helper: capture spec and screenshot (mac-capture)

**Files:**
- Create: `native/macos/Sources/screenrec-mac/Capture.swift`, `Screenshot.swift`
- Modify: `native/macos/Sources/screenrec-mac/main.swift` (add the `screenshot` case)
- Test: `test/mac-smoke/helper.test.ts` (add a screenshot test)

**Interfaces:**
- Capture flags shared by `screenshot` and `record`: exactly one of `--window-id <id>` or `--display-id <id>`; optional `--region x,y,w,h` (points, relative to the display; display capture only); required `--size W,H` (output pixels, even); optional `--cursor`; `--fps <n>` (record only, default 30).
- `screenrec-mac screenshot <capture flags> --out <file.png>` → `{"ok":true,"out","width","height"}`; `E_NO_FRAMES` if no complete frame arrives within 3 s (for example a minimized window).

- [ ] **Step 1: Add the failing smoke test**

Append to `test/mac-smoke/helper.test.ts`:

```ts
import os from 'node:os'; import path from 'node:path';

test('screenshot of the main display writes a PNG of the requested size', { skip }, () => {
  const d = run('displays').displays.find((x: { main: boolean }) => x.main);
  const w = Math.floor((d.width * d.scale) / 4) * 2, h = Math.floor((d.height * d.scale) / 4) * 2; // half size, even
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shot-')), 'main.png');
  const r = run('screenshot', '--display-id', String(d.id), '--size', `${w},${h}`, '--out', out);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(out).subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(r.width, w); assert.equal(r.height, h);
});
```

- [ ] **Step 2: Run to verify failure** → `npm run build:native && npm run test:mac-smoke`. Expected: the new test fails with `unknown command screenshot`.

- [ ] **Step 3: Implement**

`native/macos/Sources/screenrec-mac/Capture.swift`:

```swift
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

func makeSpec(_ a: Args) -> CaptureSpec {
    guard let size = a.nums("size"), size.count == 2 else { fail("E_BAD_ARGS", "--size W,H is required") }
    var region: CGRect? = nil
    if let r = a.nums("region") {
        guard r.count == 4 else { fail("E_BAD_ARGS", "--region needs x,y,w,h") }
        region = CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
    }
    let spec = CaptureSpec(windowID: a.int("window-id").map { CGWindowID($0) },
                           displayID: a.int("display-id").map { CGDirectDisplayID($0) },
                           region: region, width: Int(size[0]), height: Int(size[1]),
                           cursor: a.bool("cursor"), fps: a.int("fps") ?? 30)
    if (spec.windowID == nil) == (spec.displayID == nil) { fail("E_BAD_ARGS", "pass exactly one of --window-id or --display-id") }
    return spec
}

func makeFilter(_ spec: CaptureSpec, _ content: SCShareableContent) -> SCContentFilter {
    if let wid = spec.windowID {
        guard let w = content.windows.first(where: { $0.windowID == wid }) else { fail("E_TARGET_NOT_FOUND", "window \(wid) no longer exists") }
        return SCContentFilter(desktopIndependentWindow: w)
    }
    guard let d = content.displays.first(where: { $0.displayID == spec.displayID }) else { fail("E_TARGET_NOT_FOUND", "display \(spec.displayID ?? 0) not found") }
    return SCContentFilter(display: d, excludingWindows: [])
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

/// True only for frames that carry new content (idle and blank frames are skipped).
func frameComplete(_ sb: CMSampleBuffer) -> Bool {
    guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = arr.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { return false }
    return status == .complete
}
```

`native/macos/Sources/screenrec-mac/Screenshot.swift`:

```swift
import ScreenCaptureKit
import CoreImage
import ImageIO
import UniformTypeIdentifiers

private final class OneFrame: NSObject, SCStreamOutput {
    let queue = DispatchQueue(label: "screenrec.shot")
    var done = false
    var cont: CheckedContinuation<CGImage?, Never>?

    func finish(_ img: CGImage?) {  // always called on `queue`
        guard !done else { return }
        done = true
        cont?.resume(returning: img)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, frameComplete(sb), let pb = sb.imageBuffer else { return }
        let ci = CIImage(cvPixelBuffer: pb)
        finish(CIContext().createCGImage(ci, from: ci.extent))
    }
}

func screenshot(_ a: Args) async {
    guard let outPath = a.str("out") else { fail("E_BAD_ARGS", "--out is required") }
    let spec = makeSpec(a)
    let content = await shareable()
    let stream = SCStream(filter: makeFilter(spec, content), configuration: makeConfig(spec), delegate: nil)
    let output = OneFrame()
    do { try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue) }
    catch { fail("E_HELPER_CRASHED", "addStreamOutput: \(error.localizedDescription)") }
    let image: CGImage? = await withCheckedContinuation { c in
        output.queue.async {
            output.cont = c
            output.queue.asyncAfter(deadline: .now() + 3) { output.finish(nil) }
        }
        Task { do { try await stream.startCapture() } catch { output.queue.async { output.finish(nil) } } }
    }
    try? await stream.stopCapture()
    guard let img = image else { fail("E_NO_FRAMES", "no frame within 3 s (is the window minimized or on another Space?)") }
    let url = URL(fileURLWithPath: outPath) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { fail("E_BAD_ARGS", "cannot write \(outPath)") }
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { fail("E_BAD_ARGS", "cannot write \(outPath)") }
    emit(["ok": true, "out": outPath, "width": img.width, "height": img.height])
}
```

In `main.swift`, add before `default:`:

```swift
case "screenshot":
    await screenshot(args)
```

- [ ] **Step 4: Build and run** → `npm run build:native && npm run test:mac-smoke`. Expected: all pass. This step briefly captures the screen; it does not move windows.

- [ ] **Step 5: Commit**

```bash
git add native/macos test/mac-smoke
git commit -m "feat(mac): capture spec and one-frame screenshot"
```

---

### Task 13: Swift helper: record with follow-app and stop handling (mac-capture)

**Files:**
- Create: `native/macos/Sources/screenrec-mac/Recorder.swift`, `Record.swift`
- Modify: `native/macos/Sources/screenrec-mac/main.swift` (add `record`)
- Test: `test/mac-smoke/record.test.ts`

**Interfaces:**
- `screenrec-mac record <capture flags> --out <file.mov> [--max-seconds N] [--marks <file.jsonl>] [--t0-ms <epoch ms>] [--follow-app] [--ignore-pid <pid> ...] [--ignore-app <name> ...]`
- Events (JSON lines): `{"event":"started","width","height"}`, `{"event":"first-frame"}`, `{"event":"switched","windowId","app","title"}`, `{"event":"warning","message"}`, `{"event":"stopped","reason":"signal|stdin|max|target-closed|stream-error","frames"}`.
- Stops cleanly on SIGINT, SIGTERM, a `stop` line on stdin, `--max-seconds`, or (without `--follow-app`) the window closing. Exit code 0 if at least one frame was written, 5 if none (`E_NO_FRAMES` on the Node side).
- The `.mov` is written with a 2 s movie fragment interval, so a killed helper still leaves a playable file (crash recovery in Task 19 remuxes it).
- Marks: on each switch, appends `{"t": seconds since --t0-ms, "text": "switched to <app>: <title>"}` to `--marks`.

- [ ] **Step 1: Write the failing smoke test**

`test/mac-smoke/record.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const bin = new URL('../../bin/screenrec-mac', import.meta.url).pathname;
const skip = process.platform !== 'darwin' || !fs.existsSync(bin) ? 'needs macOS and npm run build:native' : false;
const lines = (s: string) => s.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('records the main display for about 2 s and stops on SIGINT with a playable file', { skip }, async () => {
  const d = JSON.parse(execFileSync(bin, ['displays'], { encoding: 'utf8' })).displays.find((x: { main: boolean }) => x.main);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), 'a.mov');
  const w = Math.floor((d.width * d.scale) / 4) * 2, h = Math.floor((d.height * d.scale) / 4) * 2;
  const p = spawn(bin, ['record', '--display-id', String(d.id), '--size', `${w},${h}`, '--fps', '30', '--out', out, '--max-seconds', '20']);
  let stdout = ''; p.stdout.on('data', (b) => (stdout += b));
  await new Promise((r) => setTimeout(r, 2500));
  p.kill('SIGINT');
  const code: number = await new Promise((r) => p.on('exit', (c) => r(c ?? -1)));
  const ev = lines(stdout);
  assert.equal(ev[0].event, 'started');
  assert.equal(ev.at(-1).event, 'stopped'); assert.equal(ev.at(-1).reason, 'signal');
  assert.equal(code, 0);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }));
  assert.ok(dur > 1.5 && dur < 4, `duration ${dur}`);
});

test('max-seconds stops on its own', { skip }, async () => {
  const d = JSON.parse(execFileSync(bin, ['displays'], { encoding: 'utf8' })).displays.find((x: { main: boolean }) => x.main);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recmax-')), 'a.mov');
  const p = spawn(bin, ['record', '--display-id', String(d.id), '--size', '640,400', '--out', out, '--max-seconds', '1.5']);
  let stdout = ''; p.stdout.on('data', (b) => (stdout += b));
  const code: number = await new Promise((r) => p.on('exit', (c) => r(c ?? -1)));
  assert.equal(code, 0);
  assert.equal(lines(stdout).at(-1).reason, 'max');
});
```

Add `test/mac-smoke` to nothing else: it stays out of `npm test` because CI cannot grant Screen Recording.

- [ ] **Step 2: Run to verify failure** → `npm run build:native && npm run test:mac-smoke`, `unknown command record`.

- [ ] **Step 3: Implement the writer**

`native/macos/Sources/screenrec-mac/Recorder.swift`:

```swift
import ScreenCaptureKit
import AVFoundation

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "screenrec.record")
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private(set) var frames = 0
    private var started = false
    var onStreamError: ((Error) -> Void)?

    init(url: URL, width: Int, height: Int) throws {
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)  // killed files stay playable
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
        ])
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, frameComplete(sb) else { return }
        if !started {
            writer.startWriting()
            writer.startSession(atSourceTime: sb.presentationTimeStamp)
            started = true
            emit(["event": "first-frame"])
        }
        if input.isReadyForMoreMediaData, input.append(sb) { frames += 1 }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.onStreamError?(error) }
    }

    /// Ends the file at "now" so a still final stretch keeps its real length.
    func finish() async -> Int {
        let count: Int = await withCheckedContinuation { c in queue.async { c.resume(returning: self.frames) } }
        guard started else { return 0 }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMClockGetTime(CMClockGetHostTimeClock()))
        await writer.finishWriting()
        return count
    }
}
```

- [ ] **Step 4: Implement the record command**

`native/macos/Sources/screenrec-mac/Record.swift`:

```swift
import ScreenCaptureKit
import Foundation

private final class Stopper {
    private var reason: String?
    private var cont: CheckedContinuation<String, Never>?
    private let lock = NSLock()
    func fire(_ r: String) {
        lock.lock(); defer { lock.unlock() }
        guard reason == nil else { return }
        reason = r
        cont?.resume(returning: r); cont = nil
    }
    func wait() async -> String {
        await withCheckedContinuation { c in
            lock.lock(); defer { lock.unlock() }
            if let r = reason { c.resume(returning: r) } else { cont = c }
        }
    }
}

private var signalSources: [DispatchSourceSignal] = []

/// Mutable recording state shared with background tasks (a class, so tasks share one instance).
private final class RecordState {
    var stream: SCStream
    var current: CGWindowID?
    var known: Set<CGWindowID>
    init(stream: SCStream, current: CGWindowID?, known: Set<CGWindowID>) {
        self.stream = stream; self.current = current; self.known = known
    }
}

func record(_ a: Args) async {
    guard let outPath = a.str("out") else { fail("E_BAD_ARGS", "--out is required") }
    let spec = makeSpec(a)
    let follow = a.bool("follow-app") && spec.windowID != nil
    let ignorePids = Set(a.all("ignore-pid").compactMap { Int32($0) })
    let ignoreApps = Set(a.all("ignore-app").map { $0.lowercased() })
    let marks = a.str("marks")
    let t0 = (a.double("t0-ms") ?? Date().timeIntervalSince1970 * 1000) / 1000

    let content = await shareable()
    let recorder: Recorder
    do { recorder = try Recorder(url: URL(fileURLWithPath: outPath), width: spec.width, height: spec.height) }
    catch { fail("E_BAD_ARGS", "cannot write \(outPath): \(error.localizedDescription)") }

    let config = makeConfig(spec)
    let st = RecordState(stream: SCStream(filter: makeFilter(spec, content), configuration: config, delegate: recorder),
                         current: spec.windowID, known: Set(content.windows.map { $0.windowID }))
    func startStream(_ s: SCStream) async throws {
        try s.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.queue)
        try await s.startCapture()
    }
    do { try await startStream(st.stream) } catch { fail("E_PERMISSION", "startCapture: \(error.localizedDescription)") }
    emit(["event": "started", "width": spec.width, "height": spec.height])

    let stopper = Stopper()
    signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
    for sig in [SIGINT, SIGTERM] {
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler { stopper.fire("signal") }
        src.resume(); signalSources.append(src)
    }
    if let max = a.double("max-seconds") { DispatchQueue.main.asyncAfter(deadline: .now() + max) { stopper.fire("max") } }
    Thread.detachNewThread { while let line = readLine() { if line.trimmingCharacters(in: .whitespaces) == "stop" { stopper.fire("stdin"); return } } }

    // A stream that dies (for example the window was minimized on some macOS versions) is restarted while the window exists.
    recorder.onStreamError = { error in
        Task {
            emit(["event": "warning", "message": "stream stopped: \(error.localizedDescription); restarting"])
            let fresh = await shareable()
            let alive = spec.windowID.map { wid in fresh.windows.contains { $0.windowID == wid } } ?? true
            guard alive else { stopper.fire("target-closed"); return }
            st.stream = SCStream(filter: makeFilter(spec, fresh), configuration: config, delegate: recorder)
            do { try await startStream(st.stream) } catch { stopper.fire("stream-error") }
        }
    }

    let watcher = Task {
        guard spec.windowID != nil else { return }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let now = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) else { continue }
            let ids = Set(now.windows.map { $0.windowID })
            let fresh = normalWindows(now).filter { w in
                !st.known.contains(w.windowID) && w.frame.width >= 100 && w.frame.height >= 100 &&
                !ignorePids.contains(w.owningApplication?.processID ?? -1) &&
                !ignoreApps.contains((w.owningApplication?.applicationName ?? "").lowercased())
            }
            st.known.formUnion(ids)
            let gone = st.current.map { !ids.contains($0) } ?? false
            if follow, let next = fresh.max(by: { $0.windowID < $1.windowID }) {
                do {
                    try await st.stream.updateContentFilter(SCContentFilter(desktopIndependentWindow: next))
                    st.current = next.windowID
                    let app = next.owningApplication?.applicationName ?? "", title = next.title ?? ""
                    appendMark(marks, t: Date().timeIntervalSince1970 - t0, text: "switched to \(app): \(title)")
                    emit(["event": "switched", "windowId": Int(next.windowID), "app": app, "title": title])
                } catch { emit(["event": "warning", "message": "switch failed: \(error.localizedDescription)"]) }
            } else if gone {
                stopper.fire("target-closed")
                return
            }
        }
    }

    let reason = await stopper.wait()
    watcher.cancel()
    try? await st.stream.stopCapture()
    let frames = await recorder.finish()
    emit(["event": "stopped", "reason": reason, "frames": frames])
    exit(frames > 0 ? 0 : 5)
}
```

In `main.swift`, add before `default:`:

```swift
case "record":
    await record(args)
```

- [ ] **Step 5: Build and run the smoke tests** → `npm run build:native && npm run test:mac-smoke`. Expected: all pass. If the SIGINT test shows `frames` 0 on a perfectly still screen, move the mouse during the run: ScreenCaptureKit only sends frames when pixels change, and that is correct behaviour (the Node side reports `E_NO_FRAMES`).

- [ ] **Step 6: Commit**

```bash
git add native/macos test/mac-smoke/record.test.ts
git commit -m "feat(mac): record with fragmented mov, follow-app and clean stop"
```

---

### Task 14: TypeScript client for the helper (mac-capture)

**Files:**
- Create: `src/capture/mac.ts`
- Create: `test/fixtures/fake-screenrec-mac.mjs`
- Test: `test/unit/mac.test.ts`

**Interfaces:**
- Consumes: `Display`, `displayOfRect`, `resolveDisplay`, `regionToPixels`, `pixelSize`, `Rect` (3); `Target`, `WindowInfo`, `matchWindow`, `frontWindowOfApp`, `parseWindowSelector` (4); `ScreenrecError` (2).
- Produces:
  - `helperPath(): string` (`SCREENREC_MAC_HELPER` or `<package>/bin/screenrec-mac`)
  - `helperJson<T>(args: string[]): Promise<T>` (maps `{ok:false}` to `ScreenrecError` with a fix from `HELPER_FIXES`)
  - `listDisplays(): Promise<Display[]>`, `listWindows(): Promise<WindowInfo[]>`, `permission(request?: boolean): Promise<boolean>`
  - `interface CaptureSpec { windowId?: number; displayId?: number; regionPt?: Rect; sizePx: { width: number; height: number }; cursor: boolean }`
  - `resolveCaptureSpec(target: Target, displays: Display[], windows: WindowInfo[], cursor: boolean): { spec: CaptureSpec; label: string }` (throws `E_BAD_ARGS` for `tab` targets)
  - `captureArgs(spec: CaptureSpec): string[]`
  - `screenshot(spec: CaptureSpec, out: string): Promise<{ out: string; width: number; height: number }>`
  - `ancestorPids(pid?: number, ppidOf?: (pid: number) => number | null): number[]`
  - `interface RecordOptions { out: string; fps: number; maxSeconds: number; followApp: boolean; ignoreApps: string[]; ignorePids: number[]; marksFile: string; t0Ms: number; logFile: string }`
  - `recordArgs(spec: CaptureSpec, o: RecordOptions): string[]`
  - `spawnRecord(spec: CaptureSpec, o: RecordOptions): number` (detached; stdout and stderr to `logFile`; returns pid)
  - `assertMac(): void` (throws `E_UNSUPPORTED_PLATFORM` elsewhere)

- [ ] **Step 1: Write the fake helper**

`test/fixtures/fake-screenrec-mac.mjs` (executable, `chmod +x`):

```js
#!/usr/bin/env node
// Mimics screenrec-mac for unit tests. Behaviour is chosen with FAKE_HELPER_MODE.
const [cmd] = process.argv.slice(2);
const mode = process.env.FAKE_HELPER_MODE ?? 'ok';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (mode === 'no-permission') { out({ ok: false, code: 'E_PERMISSION', message: 'not granted' }); process.exit(1); }
if (cmd === 'displays') out({ ok: true, displays: [{ id: 1, name: 'Built-in', x: 0, y: 0, width: 1440, height: 900, scale: 2, main: true }] });
else if (cmd === 'windows') out({ ok: true, windows: [{ id: 7, app: 'Finder', title: 'Downloads', x: 10, y: 10, width: 801, height: 501, onScreen: true, z: 0, pid: 99 }] });
else if (cmd === 'permission') out({ ok: true, granted: true });
else out({ ok: false, code: 'E_BAD_ARGS', message: `fake: ${cmd}` });
```

- [ ] **Step 2: Write the failing tests**

`test/unit/mac.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listDisplays, listWindows, permission, resolveCaptureSpec, captureArgs, recordArgs, ancestorPids } from '../../src/capture/mac.ts';
import { ScreenrecError } from '../../src/core/errors.ts';
import type { Display } from '../../src/core/geometry.ts';
import type { WindowInfo } from '../../src/core/targets.ts';

const fake = new URL('../fixtures/fake-screenrec-mac.mjs', import.meta.url).pathname;
beforeEach(() => { process.env.SCREENREC_MAC_HELPER = fake; delete process.env.FAKE_HELPER_MODE; });

const displays: Display[] = JSON.parse(fs.readFileSync(new URL('../fixtures/two-displays.json', import.meta.url), 'utf8'));
const win = (id: number, app: string, title: string, x: number, width = 801, height = 501): WindowInfo =>
  ({ id, app, title, x, y: 100, width, height, onScreen: true, z: id, pid: 1 });
const windows = [win(1, 'Finder', 'Downloads', 100), win(2, 'Google Chrome', 'Agent', -1500)];

test('listing goes through the helper JSON protocol', async () => {
  assert.equal((await listDisplays())[0].scale, 2);
  assert.equal((await listWindows())[0].title, 'Downloads');
  assert.equal(await permission(), true);
});

test('helper errors become ScreenrecError with a fix', async () => {
  process.env.FAKE_HELPER_MODE = 'no-permission';
  await assert.rejects(listDisplays(), (e: ScreenrecError) => e.code === 'E_PERMISSION' && /Screen Recording/.test(e.fix));
});

test('window on the 2x display records at 2x, window on the 1x display at 1x, sizes even', () => {
  const a = resolveCaptureSpec({ kind: 'window', app: 'Finder', followApp: false, ignoreApps: [] }, displays, windows, false);
  assert.deepEqual(a.spec, { windowId: 1, sizePx: { width: 1602, height: 1002 }, cursor: false });
  const b = resolveCaptureSpec({ kind: 'window', app: 'Google Chrome', followApp: false, ignoreApps: [] }, displays, windows, true);
  assert.deepEqual(b.spec, { windowId: 2, sizePx: { width: 800, height: 500 }, cursor: true });
});

test('display, display-of and region specs', () => {
  assert.deepEqual(resolveCaptureSpec({ kind: 'display', display: '2' }, displays, windows, false).spec,
    { displayId: 2, sizePx: { width: 1920, height: 1080 }, cursor: false });
  assert.equal(resolveCaptureSpec({ kind: 'display-of', window: 'Google Chrome' }, displays, windows, false).spec.displayId, 2);
  assert.deepEqual(resolveCaptureSpec({ kind: 'region', region: { x: 10, y: 10, width: 301, height: 201 }, display: 'main' }, displays, windows, false).spec,
    { displayId: 1, regionPt: { x: 10, y: 10, width: 301, height: 201 }, sizePx: { width: 602, height: 402 }, cursor: false });
  assert.throws(() => resolveCaptureSpec({ kind: 'tab', mode: 'newest' }, displays, windows, false), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
});

test('captureArgs and recordArgs', () => {
  assert.deepEqual(captureArgs({ windowId: 7, sizePx: { width: 800, height: 500 }, cursor: true }), ['--window-id', '7', '--size', '800,500', '--cursor']);
  const r = recordArgs({ displayId: 1, regionPt: { x: 1, y: 2, width: 3, height: 4 }, sizePx: { width: 6, height: 8 }, cursor: false },
    { out: '/tmp/a b.mov', fps: 30, maxSeconds: 600, followApp: true, ignoreApps: ['Orca'], ignorePids: [10, 11], marksFile: '/tmp/m.jsonl', t0Ms: 5, logFile: '/tmp/l' });
  assert.deepEqual(r, ['record', '--display-id', '1', '--region', '1,2,3,4', '--size', '6,8', '--fps', '30', '--out', '/tmp/a b.mov',
    '--max-seconds', '600', '--marks', '/tmp/m.jsonl', '--t0-ms', '5', '--follow-app', '--ignore-app', 'Orca', '--ignore-pid', '10', '--ignore-pid', '11']);
});

test('ancestorPids walks parents and stops at pid 1', () => {
  const parents: Record<number, number> = { 50: 40, 40: 30, 30: 1 };
  assert.deepEqual(ancestorPids(50, (p) => parents[p] ?? null), [40, 30]);
});
```

- [ ] **Step 3: Run to verify failure** → `npm test`.

- [ ] **Step 4: Implement `src/capture/mac.ts`**

```ts
import fs from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ScreenrecError, type ErrorCode } from '../core/errors.ts';
import { displayOfRect, resolveDisplay, regionToPixels, pixelSize, type Display, type Rect } from '../core/geometry.ts';
import { matchWindow, frontWindowOfApp, parseWindowSelector, type Target, type WindowInfo } from '../core/targets.ts';

const exec = promisify(execFile);

export function assertMac(): void {
  if (process.platform !== 'darwin') {
    throw new ScreenrecError('E_UNSUPPORTED_PLATFORM', `Window, display and region capture are macOS-only in v1 (this is ${process.platform})`,
      'Use --tab to record a Chrome tab, which works on every platform.');
  }
}

export function helperPath(): string {
  return process.env.SCREENREC_MAC_HELPER ?? fileURLToPath(new URL('../../bin/screenrec-mac', import.meta.url));
}

export const HELPER_FIXES: Partial<Record<ErrorCode, string>> = {
  E_PERMISSION: 'Open System Settings > Privacy & Security > Screen Recording, enable the app that runs screenrec (your terminal or IDE), then quit and reopen that app.',
  E_TARGET_NOT_FOUND: 'Run "screenrec list windows" or "screenrec list displays" and try again.',
  E_NO_FRAMES: 'The target showed no content: un-minimize the window or move it to the current Space.',
  E_BAD_ARGS: 'This is a screenrec bug; please report it with SCREENREC_DEBUG=1 output.',
};

export async function helperJson<T>(args: string[]): Promise<T> {
  let stdout = '';
  try { stdout = (await exec(helperPath(), args, { maxBuffer: 16 << 20 })).stdout; }
  catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string };
    if (err.code === 'ENOENT') throw new ScreenrecError('E_HELPER_CRASHED', `Helper not found at ${helperPath()}`, 'Run "npm run build:native" (from source) or reinstall screenrec.');
    stdout = err.stdout ?? '';
  }
  const last = stdout.trim().split('\n').at(-1) ?? '';
  let j: { ok: boolean; code?: ErrorCode; message?: string } & T;
  try { j = JSON.parse(last); } catch { throw new ScreenrecError('E_HELPER_CRASHED', `Helper printed no JSON: ${stdout.slice(0, 200)}`, 'Re-run with SCREENREC_DEBUG=1 and report the output.'); }
  if (!j.ok) {
    const code = j.code ?? 'E_HELPER_CRASHED';
    throw new ScreenrecError(code, j.message ?? 'helper failed', HELPER_FIXES[code] ?? 'Re-run with SCREENREC_DEBUG=1 and report the output.');
  }
  return j;
}

export const listDisplays = async () => (await helperJson<{ displays: Display[] }>(['displays'])).displays;
export const listWindows = async () => (await helperJson<{ windows: WindowInfo[] }>(['windows'])).windows;
export const permission = async (request = false) =>
  (await helperJson<{ granted: boolean }>(request ? ['permission', '--request'] : ['permission'])).granted;

export interface CaptureSpec { windowId?: number; displayId?: number; regionPt?: Rect; sizePx: { width: number; height: number }; cursor: boolean }

function windowSpec(w: WindowInfo, displays: Display[], cursor: boolean): CaptureSpec {
  const d = displayOfRect(displays, w);
  return { windowId: w.id, sizePx: pixelSize(w.width, w.height, d.scale), cursor };
}

export function resolveCaptureSpec(target: Target, displays: Display[], windows: WindowInfo[], cursor: boolean): { spec: CaptureSpec; label: string } {
  switch (target.kind) {
    case 'window': { const w = matchWindow(windows, target); return { spec: windowSpec(w, displays, cursor), label: `${w.app}: ${w.title}` }; }
    case 'app': { const w = frontWindowOfApp(windows, target.app); return { spec: windowSpec(w, displays, cursor), label: `${w.app}: ${w.title}` }; }
    case 'display': { const d = resolveDisplay(displays, target.display); return { spec: { displayId: d.id, sizePx: pixelSize(d.width, d.height, d.scale), cursor }, label: d.name }; }
    case 'display-of': {
      const d = displayOfRect(displays, matchWindow(windows, parseWindowSelector(target.window)));
      return { spec: { displayId: d.id, sizePx: pixelSize(d.width, d.height, d.scale), cursor }, label: d.name };
    }
    case 'region': {
      const d = resolveDisplay(displays, target.display);
      const px = regionToPixels(d, target.region);
      return { spec: { displayId: d.id, regionPt: target.region, sizePx: { width: px.width, height: px.height }, cursor }, label: `${d.name} region` };
    }
    case 'tab':
      throw new ScreenrecError('E_BAD_ARGS', 'Tab targets are recorded through Chrome, not the macOS helper', 'This is a screenrec bug; please report it.');
  }
}

export function captureArgs(spec: CaptureSpec): string[] {
  const a: string[] = [];
  if (spec.windowId !== undefined) a.push('--window-id', String(spec.windowId));
  if (spec.displayId !== undefined) a.push('--display-id', String(spec.displayId));
  if (spec.regionPt) a.push('--region', [spec.regionPt.x, spec.regionPt.y, spec.regionPt.width, spec.regionPt.height].join(','));
  a.push('--size', `${spec.sizePx.width},${spec.sizePx.height}`);
  if (spec.cursor) a.push('--cursor');
  return a;
}

export async function screenshot(spec: CaptureSpec, out: string) {
  return helperJson<{ out: string; width: number; height: number }>(['screenshot', ...captureArgs(spec), '--out', out]);
}

function ppid(pid: number): number | null {
  try { const v = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); return Number.isFinite(v) ? v : null; }
  catch { return null; }
}

export function ancestorPids(pid: number = process.pid, ppidOf: (pid: number) => number | null = ppid): number[] {
  const out: number[] = [];
  for (let p = ppidOf(pid); p !== null && p > 1 && out.length < 64; p = ppidOf(p)) out.push(p);
  return out;
}

export interface RecordOptions {
  out: string; fps: number; maxSeconds: number; followApp: boolean; ignoreApps: string[];
  ignorePids: number[]; marksFile: string; t0Ms: number; logFile: string;
}

export function recordArgs(spec: CaptureSpec, o: RecordOptions): string[] {
  return ['record', ...captureArgs(spec), '--fps', String(o.fps), '--out', o.out, '--max-seconds', String(o.maxSeconds),
    '--marks', o.marksFile, '--t0-ms', String(o.t0Ms),
    ...(o.followApp ? ['--follow-app'] : []),
    ...o.ignoreApps.flatMap((a) => ['--ignore-app', a]),
    ...o.ignorePids.flatMap((p) => ['--ignore-pid', String(p)])];
}

export function spawnRecord(spec: CaptureSpec, o: RecordOptions): number {
  const log = fs.openSync(o.logFile, 'a');
  const p = spawn(helperPath(), recordArgs(spec, o), { detached: true, stdio: ['ignore', log, log] });
  p.unref();
  if (!p.pid) throw new ScreenrecError('E_HELPER_CRASHED', 'Could not start the capture helper', HELPER_FIXES.E_PERMISSION!);
  return p.pid;
}
```

- [ ] **Step 5: Run unit tests** → `npm test`, all pass. Then `npm run typecheck`.

- [ ] **Step 6: Real smoke (macOS, the coordinator announces it first)**

```bash
npm run build && npm run build:native
node -e "import('./dist/capture/mac.js').then(async m => { const w = await m.listWindows(); console.log(w.slice(0,5)); })"
```

Expected: real windows with `z` values. Record the output (titles may be redacted) in the commit message body.

- [ ] **Step 7: Commit**

```bash
git add src/capture/mac.ts test/fixtures/fake-screenrec-mac.mjs test/unit/mac.test.ts
git commit -m "feat(mac): typescript helper client and capture spec resolution"
```

---

### Task 15: CDP client and endpoint discovery (chrome-cdp)

**Files:**
- Create: `src/capture/cdp/client.ts`, `src/capture/cdp/endpoint.ts`
- Test: `test/unit/cdp-client.test.ts`, `test/unit/cdp-endpoint.test.ts`

**Interfaces:**
- Consumes: `ScreenrecError` (2).
- Produces:
  - `class CdpClient { static connect(wsUrl: string, Impl?: typeof WebSocket): Promise<CdpClient>; send<T = any>(method: string, params?: object, sessionId?: string): Promise<T>; on(method: string, fn: (params: any, sessionId?: string) => void): () => void; onClose(fn: () => void): void; close(): void }`
  - `assertLoopback(url: string): void` (throws `E_CDP_UNAVAILABLE` for any host other than `127.0.0.1`, `localhost`, `::1`)
  - `chromeUserDataDirs(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): string[]`
  - `readDevToolsActivePort(dir: string): { port: number; path: string } | null`
  - `resolveEndpoint(o: { cdp?: string; env?: NodeJS.ProcessEnv; dirs?: string[]; fetchJson?: (url: string) => Promise<any> }): Promise<{ wsUrl: string; source: 'flag' | 'env' | 'chrome' }>`

- [ ] **Step 1: Write the failing tests**

`test/unit/cdp-endpoint.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { assertLoopback, readDevToolsActivePort, resolveEndpoint, chromeUserDataDirs } from '../../src/capture/cdp/endpoint.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

test('only loopback hosts are allowed', () => {
  for (const u of ['ws://127.0.0.1:9222/devtools/browser/x', 'http://localhost:9222', 'ws://[::1]:9222/x']) assertLoopback(u);
  for (const u of ['ws://10.0.0.5:9222/x', 'http://example.com:9222', 'ws://127.0.0.1.evil.com/x'])
    assert.throws(() => assertLoopback(u), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
});

test('DevToolsActivePort is parsed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'));
  assert.equal(readDevToolsActivePort(dir), null);
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '53123\n/devtools/browser/abc-123\n');
  assert.deepEqual(readDevToolsActivePort(dir), { port: 53123, path: '/devtools/browser/abc-123' });
});

test('resolveEndpoint order: flag, env, chrome dirs, else E_CDP_UNAVAILABLE', async () => {
  const fetchJson = async (u: string) => { assert.equal(u, 'http://127.0.0.1:9222/json/version'); return { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/F' }; };
  assert.deepEqual(await resolveEndpoint({ cdp: 'http://127.0.0.1:9222', fetchJson, dirs: [] }), { wsUrl: 'ws://127.0.0.1:9222/devtools/browser/F', source: 'flag' });
  assert.deepEqual(await resolveEndpoint({ env: { SCREENREC_CDP: 'ws://127.0.0.1:1/devtools/browser/E' }, dirs: [] }), { wsUrl: 'ws://127.0.0.1:1/devtools/browser/E', source: 'env' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud2-'));
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '4444\n/devtools/browser/C\n');
  assert.deepEqual(await resolveEndpoint({ env: {}, dirs: ['/nope', dir] }), { wsUrl: 'ws://127.0.0.1:4444/devtools/browser/C', source: 'chrome' });
  await assert.rejects(resolveEndpoint({ env: {}, dirs: [] }), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE' && /chrome:\/\/inspect/.test(e.fix));
  await assert.rejects(resolveEndpoint({ cdp: 'http://192.168.1.2:9222', dirs: [] }), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
});

test('user data dirs include Chrome on each platform', () => {
  assert.ok(chromeUserDataDirs('darwin', '/Users/a').includes('/Users/a/Library/Application Support/Google/Chrome'));
  assert.ok(chromeUserDataDirs('linux', '/home/a').includes('/home/a/.config/google-chrome'));
  assert.ok(chromeUserDataDirs('win32', 'C:\\Users\\a', { LOCALAPPDATA: 'C:\\L' }).some((d) => d.includes('Google') && d.includes('Chrome')));
});
```

`test/unit/cdp-client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient } from '../../src/capture/cdp/client.ts';

class FakeWs {
  static last: FakeWs;
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: (e: unknown) => void;
  sent: any[] = [];
  constructor(public url: string) { FakeWs.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(s: string) { const m = JSON.parse(s); this.sent.push(m);
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(m.method === 'Bad.method' ? { id: m.id, error: { message: 'nope' } } : { id: m.id, result: { echo: m.method }, sessionId: m.sessionId }) }), 0); }
  close() { this.onclose?.(); }
}

test('send resolves by id, rejects on error, routes events with sessionId', async () => {
  const c = await CdpClient.connect('ws://127.0.0.1:1/devtools/browser/x', FakeWs as unknown as typeof WebSocket);
  assert.deepEqual(await c.send('Target.getTargets'), { echo: 'Target.getTargets' });
  await c.send('Page.enable', {}, 'S1');
  assert.equal(FakeWs.last.sent.at(-1).sessionId, 'S1');
  await assert.rejects(c.send('Bad.method'), /nope/);
  const got: any[] = [];
  c.on('Page.screencastFrame', (p, s) => got.push([p.n, s]));
  FakeWs.last.onmessage!({ data: JSON.stringify({ method: 'Page.screencastFrame', params: { n: 1 }, sessionId: 'S1' }) });
  assert.deepEqual(got, [[1, 'S1']]);
  let closed = false; c.onClose(() => (closed = true)); c.close(); assert.equal(closed, true);
});

test('connect refuses non-loopback URLs before opening a socket', async () => {
  await assert.rejects(CdpClient.connect('ws://8.8.8.8:9222/x', FakeWs as unknown as typeof WebSocket), /loopback/);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`.

- [ ] **Step 3: Implement**

`src/capture/cdp/endpoint.ts`:

```ts
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { ScreenrecError } from '../../core/errors.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ENABLE_FIX = 'In Chrome 144+, open chrome://inspect/#remote-debugging and enable it, or start a test browser and pass --cdp http://127.0.0.1:<port>.';

export function assertLoopback(url: string): void {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* handled below */ }
  if (!LOOPBACK.has(host)) {
    throw new ScreenrecError('E_CDP_UNAVAILABLE', `Refusing CDP endpoint "${url}": only loopback hosts are allowed`, 'Use 127.0.0.1 or localhost; screenrec never connects to other machines.');
  }
}

export function chromeUserDataDirs(platform: NodeJS.Platform = process.platform, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'Microsoft Edge', 'BraveSoftware/Brave-Browser'].map((d) => path.join(base, d));
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [['Google', 'Chrome'], ['Chromium'], ['Microsoft', 'Edge'], ['BraveSoftware', 'Brave-Browser']].map((p) => path.join(base, ...p, 'User Data'));
  }
  const cfg = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser'].map((d) => path.join(cfg, d));
}

export function readDevToolsActivePort(dir: string): { port: number; path: string } | null {
  try {
    const [port, p] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n').map((s) => s.trim());
    const n = Number(port);
    return Number.isInteger(n) && n > 0 && p?.startsWith('/devtools/') ? { port: n, path: p } : null;
  } catch { return null; }
}

async function defaultFetchJson(url: string): Promise<any> {
  assertLoopback(url);
  const r = await fetch(url); // loopback only, asserted above
  return r.json();
}

async function toWs(url: string, fetchJson: (u: string) => Promise<any>): Promise<string> {
  assertLoopback(url);
  if (url.startsWith('ws://')) return url;
  try {
    const j = await fetchJson(`${url.replace(/\/$/, '')}/json/version`);
    const ws = String(j.webSocketDebuggerUrl ?? '');
    assertLoopback(ws);
    return ws;
  } catch (e) {
    if (e instanceof ScreenrecError) throw e;
    throw new ScreenrecError('E_CDP_UNAVAILABLE', `No browser answered at ${url}`, ENABLE_FIX);
  }
}

export async function resolveEndpoint(o: { cdp?: string; env?: NodeJS.ProcessEnv; dirs?: string[]; fetchJson?: (url: string) => Promise<any> }) {
  const fetchJson = o.fetchJson ?? defaultFetchJson;
  const env = o.env ?? process.env;
  if (o.cdp) return { wsUrl: await toWs(o.cdp, fetchJson), source: 'flag' as const };
  if (env.SCREENREC_CDP) return { wsUrl: await toWs(env.SCREENREC_CDP, fetchJson), source: 'env' as const };
  for (const dir of o.dirs ?? chromeUserDataDirs()) {
    const p = readDevToolsActivePort(dir);
    if (p) return { wsUrl: `ws://127.0.0.1:${p.port}${p.path}`, source: 'chrome' as const };
  }
  throw new ScreenrecError('E_CDP_UNAVAILABLE', 'No Chrome with remote debugging was found', ENABLE_FIX);
}
```

`src/capture/cdp/client.ts`:

```ts
import { ScreenrecError } from '../../core/errors.ts';
import { assertLoopback } from './endpoint.ts';

type Handler = (params: any, sessionId?: string) => void;

export class CdpClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private handlers = new Map<string, Set<Handler>>();
  private closeHandlers: (() => void)[] = [];

  private constructor(private ws: WebSocket) {}

  static connect(wsUrl: string, Impl: typeof WebSocket = WebSocket): Promise<CdpClient> {
    assertLoopback(wsUrl);
    return new Promise((resolve, reject) => {
      const ws = new Impl(wsUrl);
      const client = new CdpClient(ws);
      ws.onopen = () => resolve(client);
      ws.onerror = () => reject(new ScreenrecError('E_CDP_UNAVAILABLE', `Could not connect to ${wsUrl}`,
        'Chrome may have closed, or you declined its permission dialog. Re-enable chrome://inspect/#remote-debugging and retry.'));
      ws.onmessage = (e: MessageEvent) => client.dispatch(String(e.data));
      ws.onclose = () => client.handleClose();
    });
  }

  private dispatch(raw: string): void {
    const m = JSON.parse(raw) as { id?: number; result?: any; error?: { message: string }; method?: string; params?: any; sessionId?: string };
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
      return;
    }
    if (m.method) for (const h of this.handlers.get(m.method) ?? []) h(m.params, m.sessionId);
  }

  private handleClose(): void {
    for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
    this.pending.clear();
    for (const h of this.closeHandlers) h();
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.nextId;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(method: string, fn: Handler): () => void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(fn);
    return () => this.handlers.get(method)!.delete(fn);
  }

  onClose(fn: () => void): void { this.closeHandlers.push(fn); }
  close(): void { this.ws.close(); }
}
```

- [ ] **Step 4: Run tests** → `npm test && npm run typecheck`, pass.

- [ ] **Step 5: Commit**

```bash
git add src/capture/cdp/client.ts src/capture/cdp/endpoint.ts test/unit/cdp-client.test.ts test/unit/cdp-endpoint.test.ts
git commit -m "feat(chrome): loopback-only CDP client and endpoint discovery"
```

---

### Task 16: Tab tracker (chrome-cdp)

Spec 6.3 says `follow` switches "when the agent creates or activates another tab". CDP cannot tell the agent's clicks from the user's, so this plan narrows activation to **tabs created after `start`** (the agent's tabs), mirroring `--follow-app` in spec 6.1. The user clicking their own older tabs never moves the recording. The coordinator records this clarification in the spec when merging Task 16.

**Files:**
- Create: `src/capture/cdp/tabs.ts`
- Test: `test/unit/tabs.test.ts`

**Interfaces:**
- Produces:
  - `interface TabInfo { targetId: string; url: string; title: string }`
  - `type TabMode = 'newest' | 'follow' | 'url' | 'title'`
  - `class TabTracker { constructor(mode: TabMode, pattern: string | undefined, existing: TabInfo[]); created(t: TabInfo): void; changed(t: TabInfo): void; destroyed(targetId: string): void; activated(targetId: string): void; current(): string | null; agentTabs(): string[]; label(targetId: string): string }`
  - Rules: `newest` and `follow` only ever choose tabs created after construction; `url`/`title` match existing and new tabs (case-insensitive substring) and stick to the first match until it closes; `activated` only matters in `follow` mode and only for agent tabs.

- [ ] **Step 1: Write the failing tests**

`test/unit/tabs.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabTracker } from '../../src/capture/cdp/tabs.ts';

const t = (id: string, url = `https://x.test/${id}`, title = id) => ({ targetId: id, url, title });

test('newest ignores tabs that existed before start and falls back when the newest closes', () => {
  const k = new TabTracker('newest', undefined, [t('old')]);
  assert.equal(k.current(), null);
  k.created(t('a')); assert.equal(k.current(), 'a');
  k.created(t('b')); assert.equal(k.current(), 'b');
  k.destroyed('b'); assert.equal(k.current(), 'a');
  k.destroyed('a'); assert.equal(k.current(), null);
});

test('follow switches on creation and on activation of agent tabs only', () => {
  const k = new TabTracker('follow', undefined, [t('user')]);
  k.created(t('a')); k.created(t('b')); assert.equal(k.current(), 'b');
  k.activated('a'); assert.equal(k.current(), 'a');
  k.activated('user'); assert.equal(k.current(), 'a', "the user's own tab never takes over");
  k.destroyed('a'); assert.equal(k.current(), 'b');
  assert.deepEqual(k.agentTabs(), ['b']);
});

test('url and title modes match existing tabs, stick, and re-match after close', () => {
  const k = new TabTracker('url', 'GitHub.com', [t('x', 'https://example.com'), t('g', 'https://github.com/a')]);
  assert.equal(k.current(), 'g');
  k.created(t('g2', 'https://github.com/b')); assert.equal(k.current(), 'g', 'sticky');
  k.destroyed('g'); assert.equal(k.current(), 'g2');
  const tt = new TabTracker('title', 'inbox', [t('m', 'https://mail.test', 'Inbox (3)')]);
  assert.equal(tt.current(), 'm');
  tt.changed({ targetId: 'm', url: 'https://mail.test', title: 'Sent' }); assert.equal(tt.current(), 'm', 'sticky after title change');
});

test('label is human readable', () => {
  const k = new TabTracker('newest', undefined, []);
  k.created(t('a', 'https://x.test/a', 'Docs: Q3'));
  assert.equal(k.label('a'), 'Docs: Q3 (https://x.test/a)');
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`.

- [ ] **Step 3: Implement `src/capture/cdp/tabs.ts`**

```ts
export interface TabInfo { targetId: string; url: string; title: string }
export type TabMode = 'newest' | 'follow' | 'url' | 'title';

export class TabTracker {
  private tabs = new Map<string, TabInfo>();
  private agent: string[] = [];          // agent tabs in creation order
  private focusOrder: string[] = [];     // follow: most recent creation or activation last
  private sticky: string | null = null;  // url/title mode

  constructor(private mode: TabMode, private pattern: string | undefined, existing: TabInfo[]) {
    for (const e of existing) this.tabs.set(e.targetId, e);
  }

  private matches(t: TabInfo): boolean {
    const p = (this.pattern ?? '').toLowerCase();
    return (this.mode === 'url' ? t.url : t.title).toLowerCase().includes(p);
  }

  created(t: TabInfo): void {
    this.tabs.set(t.targetId, t);
    this.agent.push(t.targetId);
    this.focusOrder.push(t.targetId);
  }

  changed(t: TabInfo): void { if (this.tabs.has(t.targetId)) this.tabs.set(t.targetId, t); }

  destroyed(id: string): void {
    this.tabs.delete(id);
    this.agent = this.agent.filter((x) => x !== id);
    this.focusOrder = this.focusOrder.filter((x) => x !== id);
    if (this.sticky === id) this.sticky = null;
  }

  activated(id: string): void {
    if (this.mode !== 'follow' || !this.agent.includes(id)) return;
    this.focusOrder = [...this.focusOrder.filter((x) => x !== id), id];
  }

  current(): string | null {
    if (this.mode === 'newest') return this.agent.at(-1) ?? null;
    if (this.mode === 'follow') return this.focusOrder.at(-1) ?? null;
    if (this.sticky && this.tabs.has(this.sticky)) return this.sticky;
    const hit = [...this.tabs.values()].find((t) => this.matches(t));
    this.sticky = hit?.targetId ?? null;
    return this.sticky;
  }

  agentTabs(): string[] { return [...this.agent]; }

  label(id: string): string {
    const t = this.tabs.get(id);
    return t ? `${t.title || '(untitled)'} (${t.url})` : id;
  }
}
```

- [ ] **Step 4: Run tests** → `npm test`, pass.

- [ ] **Step 5: Commit**

```bash
git add src/capture/cdp/tabs.ts test/unit/tabs.test.ts
git commit -m "feat(chrome): tab tracker that only follows agent-created tabs"
```

---

### Task 17: Frame pacing (chrome-cdp)

**Files:**
- Create: `src/capture/cdp/pacer.ts`
- Test: `test/unit/pacer.test.ts`

**Interfaces:**
- Produces:
  - `framesDue(startMs: number, nowMs: number, fps: number, written: number): number` (`max(0, floor((now - start) * fps / 1000) - written)`)
  - `class FrameHolder { set(jpeg: Buffer): void; get(): Buffer | null; readonly received: number }`
  - `outputSize(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number }` (even, uses `even` from Task 3)
  - `encoderArgs(out: string, fps: number, size: { width: number; height: number }): string[]` (image2pipe MJPEG in, scaled and padded to the fixed size, libx264 to `.mkv`)
  - `NO_FRAMES_EXIT = 5`

- [ ] **Step 1: Write the failing tests**

`test/unit/pacer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesDue, FrameHolder, outputSize, encoderArgs } from '../../src/capture/cdp/pacer.ts';

test('framesDue catches up a gap with held frames and never goes negative', () => {
  assert.equal(framesDue(0, 1000, 30, 0), 30);   // first frame arrived 1 s after start: hold it for 30 frames
  assert.equal(framesDue(0, 1000, 30, 30), 0);
  assert.equal(framesDue(0, 1033, 30, 30), 0);
  assert.equal(framesDue(0, 1034, 30, 30), 1);
  assert.equal(framesDue(0, 500, 30, 40), 0);
});

test('FrameHolder keeps the latest frame and counts arrivals', () => {
  const h = new FrameHolder();
  assert.equal(h.get(), null); assert.equal(h.received, 0);
  h.set(Buffer.from('a')); h.set(Buffer.from('b'));
  assert.equal(h.get()!.toString(), 'b'); assert.equal(h.received, 2);
});

test('outputSize is even device pixels', () => {
  assert.deepEqual(outputSize(1280, 721, 2), { width: 2560, height: 1442 });
  assert.deepEqual(outputSize(801, 501, 1), { width: 800, height: 500 });
});

test('encoderArgs pads every tab to one fixed size', () => {
  const a = encoderArgs('/tmp/x y.mkv', 30, { width: 800, height: 500 });
  assert.deepEqual(a.slice(0, 9), ['-hide_banner', '-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '30']);
  assert.ok(a.includes('scale=800:500:force_original_aspect_ratio=decrease,pad=800:500:(ow-iw)/2:(oh-ih)/2,format=yuv420p'));
  assert.equal(a.at(-1), '/tmp/x y.mkv');
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`.

- [ ] **Step 3: Implement `src/capture/cdp/pacer.ts`**

```ts
import { even } from '../../core/geometry.ts';

export const NO_FRAMES_EXIT = 5;

export function framesDue(startMs: number, nowMs: number, fps: number, written: number): number {
  return Math.max(0, Math.floor(((nowMs - startMs) * fps) / 1000) - written);
}

export class FrameHolder {
  private frame: Buffer | null = null;
  private count = 0;
  set(jpeg: Buffer): void { this.frame = jpeg; this.count++; }
  get(): Buffer | null { return this.frame; }
  get received(): number { return this.count; }
}

export function outputSize(cssWidth: number, cssHeight: number, dpr: number) {
  return { width: even(cssWidth * dpr), height: even(cssHeight * dpr) };
}

export function encoderArgs(out: string, fps: number, size: { width: number; height: number }): string[] {
  const { width: w, height: h } = size;
  return ['-hide_banner', '-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-y', out];
}
```

- [ ] **Step 4: Run tests** → `npm test`, pass.

- [ ] **Step 5: Commit**

```bash
git add src/capture/cdp/pacer.ts test/unit/pacer.test.ts
git commit -m "feat(chrome): constant-rate frame pacing and encoder args"
```

---

### Task 18: Tab recording worker and the Chrome CI test (chrome-cdp)

**Files:**
- Create: `src/capture/cdp/worker.ts`, `src/capture/cdp/tabs-list.ts`
- Create: `test/chrome/launch.ts`, `test/chrome/tab-capture.test.ts`
- Modify: `package.json` (devDependency `@puppeteer/browsers`, Apache-2.0, test-only)

**Interfaces:**
- Consumes: `CdpClient`, `resolveEndpoint` (15), `TabTracker` (16), `framesDue`, `FrameHolder`, `outputSize`, `encoderArgs`, `NO_FRAMES_EXIT` (17), `appendMark` (5), `ffmpegBin` (7).
- Produces:
  - `interface WorkerConfig { wsUrl: string; mode: TabMode; pattern?: string; out: string; fps: number; maxSeconds: number; marksFile: string; t0Ms: number }`
  - `runWorker(cfg: WorkerConfig): Promise<number>` (exit code: 0 ok, `NO_FRAMES_EXIT` if no frame ever arrived)
  - Process entry: `node dist/capture/cdp/worker.js '<WorkerConfig JSON>'` (or `.ts` via tsx in tests). Stops on SIGINT, SIGTERM, a `stop` line on stdin, `maxSeconds`, or the browser disconnecting.
  - `listTabs(wsUrl: string): Promise<{ targetId: string; url: string; title: string }[]>` (for `screenrec list tabs`)

- [ ] **Step 1: Write the browser launcher for tests**

```bash
npm install --save-dev @puppeteer/browsers
```

`test/chrome/launch.ts`:

```ts
import { install, Browser, detectBrowserPlatform, resolveBuildId, computeExecutablePath } from '@puppeteer/browsers';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { readDevToolsActivePort } from '../../src/capture/cdp/endpoint.ts';

const cacheDir = path.resolve('.cache/chrome');

export async function launchChrome(): Promise<{ wsUrl: string; proc: ChildProcess; userDataDir: string }> {
  const platform = detectBrowserPlatform()!;
  const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
  await install({ browser: Browser.CHROME, buildId, cacheDir });
  const exe = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srchrome-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=800,500', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    const p = readDevToolsActivePort(userDataDir);
    if (p) return { wsUrl: `ws://127.0.0.1:${p.port}${p.path}`, proc, userDataDir };
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('Chrome for Testing did not start');
}
```

Add `.cache/` to `.gitignore`.

- [ ] **Step 2: Write the failing Chrome test**

`test/chrome/tab-capture.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { launchChrome } from './launch.ts';
import { CdpClient } from '../../src/capture/cdp/client.ts';
import { readMarks } from '../../src/core/sidecar.ts';
const exec = promisify(execFile);

const page = (palette: 'colour' | 'grey') => new URL('../fixtures/colour-page.html', import.meta.url).href + (palette === 'grey' ? '?grey' : '');
const workerTs = new URL('../../src/capture/cdp/worker.ts', import.meta.url).pathname;
const chrome = await launchChrome();
after(() => chrome.proc.kill());

async function centreColours(file: string, seconds: number): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let t = 0.25; t < seconds; t += 0.25) {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1',
      '-vf', 'crop=4:4:(iw-4)/2:(ih-4)/2,scale=1:1,format=rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
    const b = stdout as unknown as Buffer;
    seen.add([b[0], b[1], b[2]].map((v) => Math.round(v / 64)).join(','));  // coarse buckets survive compression
  }
  return seen;
}

function startWorker(cfg: object) {
  const p = spawn(process.execPath, ['--import', 'tsx', workerTs, JSON.stringify(cfg)], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<number>((r) => p.on('exit', (c) => r(c ?? -1)));
  return { stop: () => p.stdin.write('stop\n'), done };
}

test('records a hidden background tab opened after start (newest), live colours', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-'));
  const out = path.join(dir, 'tab.mkv'); const marksFile = path.join(dir, 'm.jsonl');
  const w = startWorker({ wsUrl: chrome.wsUrl, mode: 'newest', out, fps: 30, maxSeconds: 30, marksFile, t0Ms: Date.now() });
  await new Promise((r) => setTimeout(r, 500));
  const c = await CdpClient.connect(chrome.wsUrl);
  await c.send('Target.createTarget', { url: page('colour'), background: true });
  await new Promise((r) => setTimeout(r, 3500));
  w.stop();
  assert.equal(await w.done, 0);
  const colours = await centreColours(out, 3.5);
  assert.ok(colours.size >= 4, `distinct colours ${colours.size}`);
  c.close();
});

test('follow: switches to a second agent tab, notes the switch, survives the first closing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fol-'));
  const out = path.join(dir, 'f.mkv'); const marksFile = path.join(dir, 'm.jsonl');
  const w = startWorker({ wsUrl: chrome.wsUrl, mode: 'follow', out, fps: 30, maxSeconds: 30, marksFile, t0Ms: Date.now() });
  await new Promise((r) => setTimeout(r, 500));
  const c = await CdpClient.connect(chrome.wsUrl);
  const a = await c.send('Target.createTarget', { url: page('colour'), background: true });
  await new Promise((r) => setTimeout(r, 2000));
  await c.send('Target.createTarget', { url: page('grey'), background: true });
  await c.send('Target.closeTarget', { targetId: a.targetId });
  await new Promise((r) => setTimeout(r, 2000));
  w.stop();
  assert.equal(await w.done, 0);
  const marks = readMarks(marksFile);
  assert.ok(marks.filter((m) => m.text.startsWith('switched to tab')).length >= 2, JSON.stringify(marks));
  c.close();
});

test('no frames at all exits with code 5 and leaves no file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nof-'));
  const out = path.join(dir, 'none.mkv');
  const w = startWorker({ wsUrl: chrome.wsUrl, mode: 'newest', out, fps: 30, maxSeconds: 30, marksFile: path.join(dir, 'm.jsonl'), t0Ms: Date.now() });
  await new Promise((r) => setTimeout(r, 800));
  w.stop();
  assert.equal(await w.done, 5);
  assert.equal(fs.existsSync(out), false);
});
```

Update `test/fixtures/colour-page.html` so `?grey` uses a grey palette (`['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff']`): add `const grey = location.search.includes('grey');` and pick the array accordingly.

- [ ] **Step 3: Run to verify failure** → `npm run test:chrome`. Expected: FAIL, worker module missing.

- [ ] **Step 4: Implement `src/capture/cdp/worker.ts` and `tabs-list.ts`**

`src/capture/cdp/worker.ts`:

```ts
import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CdpClient } from './client.ts';
import { TabTracker, type TabMode, type TabInfo } from './tabs.ts';
import { framesDue, FrameHolder, outputSize, encoderArgs, NO_FRAMES_EXIT } from './pacer.ts';
import { appendMark } from '../../core/sidecar.ts';
import { ffmpegBin } from '../../edit/ffmpeg.ts';

export interface WorkerConfig { wsUrl: string; mode: TabMode; pattern?: string; out: string; fps: number; maxSeconds: number; marksFile: string; t0Ms: number }

type TargetInfo = { targetId: string; type: string; url: string; title: string };
const isPage = (t: TargetInfo) => t.type === 'page';
const info = (t: TargetInfo): TabInfo => ({ targetId: t.targetId, url: t.url, title: t.title });

export async function runWorker(cfg: WorkerConfig): Promise<number> {
  const cdp = await CdpClient.connect(cfg.wsUrl);
  const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
  const tracker = new TabTracker(cfg.mode, cfg.pattern, targetInfos.filter(isPage).map(info));
  const holder = new FrameHolder();
  let session: { targetId: string; sessionId: string } | null = null;
  let size: { width: number; height: number } | null = null;
  let ffmpeg: ChildProcessWithoutNullStreams | null = null;
  let written = 0;
  let stopping = false;
  const mark = (text: string) => appendMark(cfg.marksFile, { t: Math.round(Date.now() - cfg.t0Ms) / 1000, text });

  cdp.on('Page.screencastFrame', (p, sessionId) => {
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId).catch(() => {});
    if (sessionId === session?.sessionId) holder.set(Buffer.from(p.data, 'base64'));
  });

  async function detach() {
    if (!session) return;
    const s = session; session = null;
    await cdp.send('Page.stopScreencast', {}, s.sessionId).catch(() => {});
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, s.sessionId).catch(() => {});
    await cdp.send('Target.detachFromTarget', { sessionId: s.sessionId }).catch(() => {});
  }

  async function attach(targetId: string) {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
    if (!size) {
      const m = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, sessionId);
      const dpr = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }, sessionId)).result.value || 1;
      size = outputSize(m.cssVisualViewport.clientWidth, m.cssVisualViewport.clientHeight, dpr);
    }
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 }, sessionId);
    session = { targetId, sessionId };
    mark(`switched to tab: ${tracker.label(targetId)}`);
  }

  let switching = Promise.resolve();
  function reconcile() {
    switching = switching.then(async () => {
      if (stopping) return;
      const want = tracker.current();
      if (want === (session?.targetId ?? null)) return;
      await detach();
      if (want) await attach(want).catch(() => { /* tab vanished while attaching; next event reconciles */ });
    });
  }

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  cdp.on('Target.targetCreated', (p) => { if (isPage(p.targetInfo)) { tracker.created(info(p.targetInfo)); reconcile(); } });
  cdp.on('Target.targetInfoChanged', (p) => { if (isPage(p.targetInfo)) { tracker.changed(info(p.targetInfo)); reconcile(); } });
  cdp.on('Target.targetDestroyed', (p) => { tracker.destroyed(p.targetId); reconcile(); });
  reconcile();

  // follow mode: notice when the agent brings one of its own older tabs to the front
  const visibilityPoll = cfg.mode === 'follow' ? setInterval(async () => {
    for (const id of tracker.agentTabs()) {
      if (id === session?.targetId) continue;
      try {
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: id, flatten: true });
        const r = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sessionId);
        await cdp.send('Target.detachFromTarget', { sessionId });
        if (r.result.value === 'visible') { tracker.activated(id); reconcile(); }
      } catch { /* tab closed meanwhile */ }
    }
  }, 1000) : null;

  const tick = setInterval(() => {
    const frame = holder.get();
    if (!frame || !size) return;
    if (!ffmpeg) {
      ffmpeg = spawn(ffmpegBin(), encoderArgs(cfg.out, cfg.fps, size));
      ffmpeg.stdin.on('error', () => {});
    }
    const n = framesDue(cfg.t0Ms, Date.now(), cfg.fps, written);
    for (let i = 0; i < n; i++) ffmpeg.stdin.write(frame);
    written += n;
  }, Math.round(1000 / cfg.fps));

  const reason = await new Promise<string>((resolve) => {
    process.once('SIGINT', () => resolve('signal'));
    process.once('SIGTERM', () => resolve('signal'));
    process.stdin.on('data', (d) => { if (String(d).includes('stop')) resolve('stdin'); });
    setTimeout(() => resolve('max'), cfg.maxSeconds * 1000).unref();
    cdp.onClose(() => resolve('browser-closed'));
  });
  stopping = true;
  clearInterval(tick);
  if (visibilityPoll) clearInterval(visibilityPoll);
  await switching;
  await detach();
  cdp.close();
  mark(`stopped: ${reason}`);
  if (!ffmpeg) { fs.rmSync(cfg.out, { force: true }); return NO_FRAMES_EXIT; }
  const enc: ChildProcessWithoutNullStreams = ffmpeg;
  await new Promise<void>((r) => { enc.on('exit', () => r()); enc.stdin.end(); });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  runWorker(JSON.parse(process.argv[2]) as WorkerConfig).then((code) => process.exit(code), (e) => {
    process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1);
  });
}
```

`src/capture/cdp/tabs-list.ts`:

```ts
import { CdpClient } from './client.ts';

export async function listTabs(wsUrl: string) {
  const c = await CdpClient.connect(wsUrl);
  try {
    const { targetInfos } = await c.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page').map(({ targetId, url, title }) => ({ targetId, url, title }));
  } finally { c.close(); }
}
```

- [ ] **Step 5: Run the Chrome tests** → `npm run test:chrome`. Expected: 3 pass. The first run downloads Chrome for Testing into `.cache/chrome`. If the follow test sees only one switch mark, print the marks file and fix `reconcile`, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/capture/cdp/worker.ts src/capture/cdp/tabs-list.ts test/chrome test/fixtures/colour-page.html package.json package-lock.json .gitignore
git commit -m "feat(chrome): hidden-tab recording worker with follow and no-frames exit"
```

---

### Task 19: Recording orchestration and the remaining commands (api-core)

**Files:**
- Create: `src/recorder.ts`, `src/capture/chrome-applescript.ts`
- Create: `src/commands/start.ts`, `stop.ts`, `status.ts`, `mark.ts`, `screenshot.ts`, `list.ts`, `doctor.ts`
- Modify: `src/capture/mac.ts` (`assertMac(platform: NodeJS.Platform = process.platform)`)
- Modify: `test/fixtures/fake-screenrec-mac.mjs` (add `record` and a Chrome window)
- Test: `test/unit/chrome-applescript.test.ts`, `test/video/recorder.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-18.
- Produces:
  - `interface StartOptions { target: Target; out?: string; fps: number; cursor: boolean; maxMs: number; meta: boolean; cwd?: string }`
  - `interface StartResult { out: string; pid: number; worker: 'mac' | 'cdp'; target: string; warnings: string[]; recovered?: StopResult }`
  - `interface StopResult { out: string; durationSec: number; sidecar?: string; reason: string }`
  - `interface RecorderDeps { platform: NodeJS.Platform; now(): number; sleep(ms: number): Promise<void>; isAlive(pid: number): boolean; signal(pid: number, sig: NodeJS.Signals): void; mac: { listDisplays(): Promise<Display[]>; listWindows(): Promise<WindowInfo[]>; spawnRecord(spec: CaptureSpec, o: RecordOptions): number; ancestorPids(): number[] }; cdp: { resolveEndpoint(o: { cdp?: string }): Promise<{ wsUrl: string }>; spawnWorker(cfg: WorkerConfig, logFile: string): number }; chromeActiveTabs(): Promise<ChromeActiveTab[]>; remux(raw: string, out: string): Promise<void>; duration(file: string): Promise<number> }`
  - `realDeps: RecorderDeps`
  - `startRecording(o: StartOptions, deps?: RecorderDeps): Promise<StartResult>`
  - `stopRecording(deps?: RecorderDeps): Promise<StopResult>`
  - `recordingStatus(deps?: RecorderDeps): { recording: boolean; pending?: boolean; elapsedSec?: number; out?: string; target?: string; text: string }`
  - `addMark(text: string, deps?: RecorderDeps): { t: number }`
  - `interface ChromeActiveTab { windowIndex: number; title: string; url: string }`, `parseActiveTabs(out: string): ChromeActiveTab[]`, `chromeActiveTabs(): Promise<ChromeActiveTab[]>`
- File layout of one recording with base `B`: `B.rec.mov` or `B.rec.mkv` (raw, deleted after stop), `B.marks.jsonl` (deleted after stop), `B.rec.log` (deleted unless `SCREENREC_DEBUG=1`), results `B.mp4` and `B.json`.

- [ ] **Step 1: Extend the fake helper**

Replace `test/fixtures/fake-screenrec-mac.mjs` with:

```js
#!/usr/bin/env node
// Mimics screenrec-mac for tests. FAKE_HELPER_MODE: ok | no-permission | no-frames | target-closes
import { spawn } from 'node:child_process';
const [cmd, ...rest] = process.argv.slice(2);
const mode = process.env.FAKE_HELPER_MODE ?? 'ok';
const print = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const flag = (k) => { const i = rest.indexOf(`--${k}`); return i === -1 ? undefined : rest[i + 1]; };
if (mode === 'no-permission') { print({ ok: false, code: 'E_PERMISSION', message: 'not granted' }); process.exit(1); }
if (cmd === 'displays') print({ ok: true, displays: [{ id: 1, name: 'Built-in', x: 0, y: 0, width: 1440, height: 900, scale: 2, main: true }] });
else if (cmd === 'windows') print({ ok: true, windows: [
  { id: 7, app: 'Finder', title: 'Downloads', x: 10, y: 10, width: 801, height: 501, onScreen: true, z: 0, pid: 99 },
  { id: 8, app: 'Google Chrome', title: 'Agent Docs', x: 100, y: 100, width: 800, height: 500, onScreen: true, z: 1, pid: 98 }] });
else if (cmd === 'permission') print({ ok: true, granted: true });
else if (cmd === 'record') {
  print({ event: 'started', width: 320, height: 240 });
  if (mode === 'no-frames') {
    process.on('SIGINT', () => { print({ event: 'stopped', reason: 'signal', frames: 0 }); process.exit(5); });
    setInterval(() => {}, 1000);
  } else {
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '60',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mov', flag('out')], { stdio: ['pipe', 'ignore', 'ignore'] });
    let stopping = false;
    const stop = (reason) => { if (stopping) return; stopping = true; ff.on('exit', () => { print({ event: 'stopped', reason, frames: 1 }); process.exit(0); }); ff.stdin.write('q'); };
    process.on('SIGINT', () => stop('signal'));
    if (mode === 'target-closes') setTimeout(() => stop('target-closed'), 1500);
  }
}
else print({ ok: false, code: 'E_BAD_ARGS', message: `fake: ${cmd}` });
```

The file name contains `screenrec-mac`, so `isRecorderAlive` (Task 5) recognises it like the real helper.

- [ ] **Step 2: Write the failing tests**

`test/unit/chrome-applescript.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseActiveTabs } from '../../src/capture/chrome-applescript.ts';

test('parseActiveTabs reads index, title and url per line, titles may contain colons', () => {
  const out = '1\tInbox (3): Mail\thttps://mail.test/\n2\tAgent Docs\thttps://docs.test/a\n';
  assert.deepEqual(parseActiveTabs(out), [
    { windowIndex: 1, title: 'Inbox (3): Mail', url: 'https://mail.test/' },
    { windowIndex: 2, title: 'Agent Docs', url: 'https://docs.test/a' },
  ]);
  assert.deepEqual(parseActiveTabs(''), []);
});
```

`test/video/recorder.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { startRecording, stopRecording, recordingStatus, addMark, realDeps, type RecorderDeps } from '../../src/recorder.ts';
import { readSidecar } from '../../src/core/sidecar.ts';
import { readState, writeState } from '../../src/core/state.ts';
import { ScreenrecError } from '../../src/core/errors.ts';
import { makeVideo } from './helpers.ts';

const fake = new URL('../fixtures/fake-screenrec-mac.mjs', import.meta.url).pathname;
let cwd = '';
beforeEach(() => {
  process.env.SCREENREC_MAC_HELPER = fake; delete process.env.FAKE_HELPER_MODE;
  process.env.SCREENREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'srh-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
});
const deps = (over: Partial<RecorderDeps> = {}): RecorderDeps => ({ ...realDeps, platform: 'darwin', ...over });
const win = { kind: 'window' as const, app: 'Finder', followApp: false, ignoreApps: [] };
const opts = (extra = {}) => ({ target: win, fps: 30, cursor: false, maxMs: 60000, meta: true, cwd, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('start, status, mark, double start refused, stop finalises mp4 and sidecar', async () => {
  const s = await startRecording(opts(), deps());
  assert.equal(s.worker, 'mac'); assert.ok(s.out.startsWith(path.join(cwd, 'recordings')));
  assert.equal(fs.readFileSync(path.join(cwd, 'recordings', '.gitignore'), 'utf8').trim(), '*');
  assert.equal(recordingStatus(deps()).recording, true);
  await sleep(600);
  addMark('opened Downloads', deps());
  await assert.rejects(startRecording(opts(), deps()), (e: ScreenrecError) => e.code === 'E_ALREADY_RECORDING');
  await sleep(600);
  const r = await stopRecording(deps());
  assert.ok(fs.existsSync(r.out)); assert.ok(r.durationSec > 0.5, `duration ${r.durationSec}`);
  assert.equal(readSidecar(r.sidecar!)!.marks[0].text, 'opened Downloads');
  assert.equal(readState(), null);
  assert.deepEqual(fs.readdirSync(path.dirname(r.out)).filter((f) => /\.rec\.|marks/.test(f)), [], 'raw, marks and log removed');
});

test('target closes before stop: stop still saves it and reports the reason', async () => {
  process.env.FAKE_HELPER_MODE = 'target-closes';
  await startRecording(opts(), deps());
  await sleep(2500);
  const st = recordingStatus(deps());
  assert.equal(st.recording, false); assert.equal(st.pending, true);
  const r = await stopRecording(deps());
  assert.ok(fs.existsSync(r.out)); assert.equal(r.reason, 'target-closed');
});

test('no frames gives E_NO_FRAMES and clears state', async () => {
  process.env.FAKE_HELPER_MODE = 'no-frames';
  await startRecording(opts(), deps());
  await sleep(300);
  await assert.rejects(stopRecording(deps()), (e: ScreenrecError) => e.code === 'E_NO_FRAMES');
  assert.equal(readState(), null);
});

test('helper permission error surfaces at start with the fix', async () => {
  process.env.FAKE_HELPER_MODE = 'no-permission';
  await assert.rejects(startRecording(opts(), deps()), (e: ScreenrecError) => e.code === 'E_PERMISSION' && /Screen Recording/.test(e.fix));
});

test('stale state from a crash is recovered on the next start', async () => {
  const raw = path.join(cwd, 'old.rec.mov');
  await makeVideo(raw, 'moving', { seconds: 1 });
  writeState({ pid: 999999, worker: 'mac', target: win, raw, out: path.join(cwd, 'old.mp4'), marksFile: path.join(cwd, 'old.marks.jsonl'), meta: true, startedAt: Date.now() - 5000, maxMs: 60000 });
  const s = await startRecording(opts(), deps());
  assert.ok(s.recovered && fs.existsSync(s.recovered.out));
  await stopRecording(deps());
});

test('--no-meta writes no sidecar', async () => {
  await startRecording(opts({ meta: false }), deps());
  await sleep(800);
  const r = await stopRecording(deps());
  assert.equal(r.sidecar, undefined);
  assert.equal(fs.existsSync(r.out.replace(/\.mp4$/, '.json')), false);
});

test('tab target falls back to the Chrome window when remote debugging is off and the tab is active', async () => {
  const noCdp = async () => { throw new ScreenrecError('E_CDP_UNAVAILABLE', 'off', 'enable'); };
  const d = deps({ cdp: { ...realDeps.cdp, resolveEndpoint: noCdp }, chromeActiveTabs: async () => [{ windowIndex: 1, title: 'Agent Docs', url: 'https://docs.test/a' }] });
  const s = await startRecording(opts({ target: { kind: 'tab', mode: 'url', pattern: 'docs.test' } }), d);
  assert.equal(s.worker, 'mac'); assert.match(s.warnings.join(' '), /remote debugging is off/);
  await sleep(800); await stopRecording(d);
  await assert.rejects(startRecording(opts({ target: { kind: 'tab', mode: 'newest' } }), d), (e: ScreenrecError) => e.code === 'E_CDP_UNAVAILABLE');
});

test('window capture on another platform is E_UNSUPPORTED_PLATFORM', async () => {
  await assert.rejects(startRecording(opts(), deps({ platform: 'linux' })), (e: ScreenrecError) => e.code === 'E_UNSUPPORTED_PLATFORM');
});
```

- [ ] **Step 3: Run to verify failure** → `npm test && npm run test:video`. Expected: module-not-found failures.

- [ ] **Step 4: Implement `src/capture/chrome-applescript.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export interface ChromeActiveTab { windowIndex: number; title: string; url: string }

export function parseActiveTabs(out: string): ChromeActiveTab[] {
  return out.split('\n').filter(Boolean).map((line) => {
    const [i, ...restParts] = line.split('\t');
    const url = restParts.pop() ?? '';
    return { windowIndex: Number(i), title: restParts.join('\t'), url };
  });
}

const SCRIPT = `
if application "Google Chrome" is not running then return ""
set out to ""
tell application "Google Chrome"
  repeat with i from 1 to (count of windows)
    set t to active tab of window i
    set out to out & i & tab & (title of t) & tab & (URL of t) & linefeed
  end repeat
end tell
return out`;

/** Active tab of each Chrome window, via AppleScript. Never launches Chrome. macOS asks once for Automation permission. */
export async function chromeActiveTabs(): Promise<ChromeActiveTab[]> {
  if (process.platform !== 'darwin') return [];
  try { return parseActiveTabs((await exec('osascript', ['-e', SCRIPT])).stdout); } catch { return []; }
}
```

- [ ] **Step 5: Implement `src/recorder.ts`**

```ts
import fs from 'node:fs'; import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ScreenrecError } from './core/errors.ts';
import type { Display } from './core/geometry.ts';
import type { Target, WindowInfo } from './core/targets.ts';
import { readState, writeState, clearState, isRecorderAlive, type RecordingState } from './core/state.ts';
import { appendMark, readMarks, writeSidecar } from './core/sidecar.ts';
import { recordingsDir, defaultRecordingBase, stripExt } from './core/paths.ts';
import * as mac from './capture/mac.ts';
import { resolveEndpoint } from './capture/cdp/endpoint.ts';
import type { WorkerConfig } from './capture/cdp/worker.ts';
import { chromeActiveTabs, type ChromeActiveTab } from './capture/chrome-applescript.ts';
import { runFfmpeg, probe, ENCODE } from './edit/ffmpeg.ts';

export interface StartOptions { target: Target; out?: string; fps: number; cursor: boolean; maxMs: number; meta: boolean; cwd?: string }
export interface StopResult { out: string; durationSec: number; sidecar?: string; reason: string }
export interface StartResult { out: string; pid: number; worker: 'mac' | 'cdp'; target: string; warnings: string[]; recovered?: StopResult }

export interface RecorderDeps {
  platform: NodeJS.Platform;
  now(): number;
  sleep(ms: number): Promise<void>;
  isAlive(pid: number): boolean;
  signal(pid: number, sig: NodeJS.Signals): void;
  mac: { listDisplays(): Promise<Display[]>; listWindows(): Promise<WindowInfo[]>; spawnRecord(spec: mac.CaptureSpec, o: mac.RecordOptions): number; ancestorPids(): number[] };
  cdp: { resolveEndpoint(o: { cdp?: string }): Promise<{ wsUrl: string }>; spawnWorker(cfg: WorkerConfig, logFile: string): number };
  chromeActiveTabs(): Promise<ChromeActiveTab[]>;
  remux(raw: string, out: string): Promise<void>;
  duration(file: string): Promise<number>;
}

const isTs = import.meta.url.endsWith('.ts');

function spawnWorker(cfg: WorkerConfig, logFile: string): number {
  const worker = fileURLToPath(new URL(`./capture/cdp/worker${isTs ? '.ts' : '.js'}`, import.meta.url));
  const log = fs.openSync(logFile, 'a');
  const p = spawn(process.execPath, [...(isTs ? ['--import', 'tsx'] : []), worker, JSON.stringify(cfg)], { detached: true, stdio: ['ignore', log, log] });
  p.unref();
  if (!p.pid) throw new ScreenrecError('E_HELPER_CRASHED', 'Could not start the tab recorder', 'Re-run with SCREENREC_DEBUG=1 and report the output.');
  return p.pid;
}

async function remux(raw: string, out: string): Promise<void> {
  try { await runFfmpeg(['-v', 'error', '-y', '-i', raw, '-c', 'copy', '-movflags', '+faststart', out]); }
  catch { await runFfmpeg(['-v', 'error', '-y', '-err_detect', 'ignore_err', '-i', raw, '-an', ...ENCODE, out]); }
}

export const realDeps: RecorderDeps = {
  platform: process.platform,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  isAlive: (pid) => isRecorderAlive(pid),
  signal: (pid, sig) => { try { process.kill(pid, sig); } catch { /* already gone */ } },
  mac: { listDisplays: mac.listDisplays, listWindows: mac.listWindows, spawnRecord: mac.spawnRecord, ancestorPids: () => mac.ancestorPids() },
  cdp: { resolveEndpoint: (o) => resolveEndpoint(o), spawnWorker },
  chromeActiveTabs,
  remux,
  duration: async (f) => (await probe(f)).duration,
};

const logOf = (s: { out: string }) => `${stripExt(s.out)}.rec.log`;

function lastLogEvent(logFile: string): Record<string, unknown> | null {
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').reverse();
    for (const l of lines) { try { return JSON.parse(l); } catch { /* not JSON */ } }
  } catch { /* no log */ }
  return null;
}

function endReason(s: RecordingState): string | null {
  const ev = lastLogEvent(logOf(s));
  if (ev?.event === 'stopped' && typeof ev.reason === 'string') return ev.reason;
  const m = readMarks(s.marksFile).reverse().find((x) => x.text.startsWith('stopped: '));
  return m ? m.text.slice('stopped: '.length) : null;
}

async function finalize(s: RecordingState, deps: RecorderDeps, reason: string): Promise<StopResult> {
  clearState(); // first, so a failure below never blocks the next start
  const marks = readMarks(s.marksFile);
  const cleanup = () => {
    for (const f of [s.raw, s.marksFile]) fs.rmSync(f, { force: true });
    if (process.env.SCREENREC_DEBUG !== '1') fs.rmSync(logOf(s), { force: true });
  };
  const hasFrames = fs.existsSync(s.raw) && fs.statSync(s.raw).size > 0 && !(lastLogEvent(logOf(s))?.frames === 0);
  if (!hasFrames) {
    cleanup();
    throw new ScreenrecError('E_NO_FRAMES', 'The recording captured no frames',
      'The target never changed on screen or was hidden. Un-minimize it, or for tabs make sure the agent opened one after start.');
  }
  await deps.remux(s.raw, s.out);
  const durationSec = await deps.duration(s.out);
  let sidecar: string | undefined;
  if (s.meta) {
    sidecar = `${stripExt(s.out)}.json`;
    writeSidecar(sidecar, { version: 1, target: s.target, startedAt: new Date(s.startedAt).toISOString(), durationSec, marks });
  }
  cleanup();
  return { out: s.out, durationSec, sidecar, reason };
}

async function failIfDiedEarly(pid: number, logFile: string, deps: RecorderDeps): Promise<void> {
  await deps.sleep(800);
  if (deps.isAlive(pid)) return;
  const ev = lastLogEvent(logFile) as { ok?: boolean; code?: string; message?: string; event?: string } | null;
  if (ev?.ok === false && ev.code) {
    const code = ev.code as ScreenrecError['code'];
    throw new ScreenrecError(code, ev.message ?? 'capture failed', mac.HELPER_FIXES[code] ?? 'Re-run with SCREENREC_DEBUG=1 and report the output.');
  }
  if (ev?.event !== 'stopped') {
    let tail = ''; try { tail = fs.readFileSync(logFile, 'utf8').slice(-400); } catch { /* none */ }
    throw new ScreenrecError('E_HELPER_CRASHED', `The recorder exited immediately: ${tail}`, 'Run "screenrec doctor", then retry with SCREENREC_DEBUG=1.');
  }
}

async function startMac(target: Target, base: string, o: StartOptions, deps: RecorderDeps, t0Ms: number, marksFile: string, logFile: string) {
  mac.assertMac(deps.platform);
  const [displays, windows] = await Promise.all([deps.mac.listDisplays(), deps.mac.listWindows()]);
  const { spec, label } = mac.resolveCaptureSpec(target, displays, windows, o.cursor);
  const raw = `${base}.rec.mov`;
  const follow = (target.kind === 'window' || target.kind === 'app') && target.followApp;
  const ignoreApps = target.kind === 'window' || target.kind === 'app' ? target.ignoreApps : [];
  const pid = deps.mac.spawnRecord(spec, { out: raw, fps: o.fps, maxSeconds: o.maxMs / 1000, followApp: follow, ignoreApps,
    ignorePids: deps.mac.ancestorPids(), marksFile, t0Ms, logFile });
  return { pid, raw, label };
}

export async function startRecording(o: StartOptions, deps: RecorderDeps = realDeps): Promise<StartResult> {
  let recovered: StopResult | undefined;
  const existing = readState();
  if (existing) {
    if (deps.isAlive(existing.pid)) {
      throw new ScreenrecError('E_ALREADY_RECORDING', `Already recording to ${existing.out}`, 'Run "screenrec stop" first (one recording at a time).');
    }
    recovered = await finalize(existing, deps, 'recovered after a crash or reboot').catch(() => undefined);
  }
  const base = o.out ? stripExt(path.resolve(o.out)) : path.join(recordingsDir(o.cwd), defaultRecordingBase(new Date(deps.now())));
  fs.mkdirSync(path.dirname(base), { recursive: true });
  const out = `${base}.mp4`, marksFile = `${base}.marks.jsonl`, logFile = `${base}.rec.log`, t0Ms = deps.now();
  fs.rmSync(marksFile, { force: true });
  const warnings: string[] = [];
  let pid: number, raw: string, label: string, worker: 'mac' | 'cdp';

  if (o.target.kind === 'tab') {
    const t = o.target;
    try {
      const { wsUrl } = await deps.cdp.resolveEndpoint({ cdp: t.cdp });
      raw = `${base}.rec.mkv`; worker = 'cdp';
      label = `Chrome tab (${t.mode}${t.pattern ? `: ${t.pattern}` : ''})`;
      pid = deps.cdp.spawnWorker({ wsUrl, mode: t.mode, pattern: t.pattern, out: raw, fps: o.fps, maxSeconds: o.maxMs / 1000, marksFile, t0Ms }, logFile);
    } catch (e) {
      const canFallBack = e instanceof ScreenrecError && e.code === 'E_CDP_UNAVAILABLE' && deps.platform === 'darwin' && (t.mode === 'url' || t.mode === 'title');
      const hit = canFallBack
        ? (await deps.chromeActiveTabs()).find((x) => (t.mode === 'url' ? x.url : x.title).toLowerCase().includes(t.pattern!.toLowerCase()))
        : undefined;
      if (!hit) throw e;
      warnings.push(`Chrome remote debugging is off, so this records the Chrome window "${hit.title}" instead of the tab. ` +
        'Covering that window or switching its tab will freeze or change the recording. Enable chrome://inspect/#remote-debugging to record hidden tabs.');
      ({ pid, raw, label } = await startMac({ kind: 'window', app: 'Google Chrome', title: hit.title, followApp: false, ignoreApps: [] }, base, o, deps, t0Ms, marksFile, logFile));
      worker = 'mac';
    }
  } else {
    ({ pid, raw, label } = await startMac(o.target, base, o, deps, t0Ms, marksFile, logFile));
    worker = 'mac';
    if (o.target.kind === 'display' || o.target.kind === 'region' || o.target.kind === 'display-of') {
      warnings.push('Display capture records notifications and every window on that display. Consider turning on a Focus mode, or record a --window instead.');
    }
  }

  writeState({ pid, worker, target: o.target, raw, out, marksFile, meta: o.meta, startedAt: t0Ms, maxMs: o.maxMs });
  try { await failIfDiedEarly(pid, logFile, deps); }
  catch (e) { clearState(); for (const f of [raw, marksFile, logFile]) fs.rmSync(f, { force: true }); throw e; }
  return { out, pid, worker, target: label, warnings, recovered };
}

export async function stopRecording(deps: RecorderDeps = realDeps): Promise<StopResult> {
  const s = readState();
  if (!s) throw new ScreenrecError('E_NOT_RECORDING', 'Nothing is recording', 'Start one with "screenrec start --window <App>".');
  let reason = endReason(s) ?? 'ended on its own';
  if (deps.isAlive(s.pid)) {
    deps.signal(s.pid, 'SIGINT');
    for (let i = 0; i < 150 && deps.isAlive(s.pid); i++) await deps.sleep(100);
    if (deps.isAlive(s.pid)) { deps.signal(s.pid, 'SIGKILL'); await deps.sleep(500); }
    reason = 'stopped';
  }
  return finalize(s, deps, reason);
}

export function recordingStatus(deps: RecorderDeps = realDeps) {
  const s = readState();
  if (!s) return { recording: false, text: 'idle' };
  const elapsedSec = Math.round((deps.now() - s.startedAt) / 100) / 10;
  if (deps.isAlive(s.pid)) return { recording: true, elapsedSec, out: s.out, target: JSON.stringify(s.target), text: `recording ${elapsedSec} s to ${s.out}` };
  return { recording: false, pending: true, out: s.out, text: `the recording ended on its own (${endReason(s) ?? 'unknown'}); run "screenrec stop" to save it` };
}

export function addMark(text: string, deps: RecorderDeps = realDeps): { t: number } {
  const s = readState();
  if (!s) throw new ScreenrecError('E_NOT_RECORDING', 'Nothing is recording', 'Start a recording before adding step notes.');
  const t = Math.round(deps.now() - s.startedAt) / 1000;
  appendMark(s.marksFile, { t, text });
  return { t };
}
```

Change the signature in `src/capture/mac.ts` to `export function assertMac(platform: NodeJS.Platform = process.platform): void` and use `platform` in its check.

- [ ] **Step 6: Implement the commands**

```ts
// src/commands/start.ts
import { startRecording } from '../recorder.ts';
import { parseTarget, type TargetFlags } from '../core/targets.ts';
import { parseDuration } from '../cli/args.ts';
import { numFlag, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const r = await startRecording({
    target: parseTarget(a.values as TargetFlags), out: a.values.out as string | undefined, fps: numFlag(a, 'fps', 30),
    cursor: a.values.cursor === true, maxMs: parseDuration((a.values.max as string | undefined) ?? '10m'), meta: a.values['no-meta'] !== true,
  });
  const lines = [`recording ${r.target} -> ${r.out}`, 'stop with: screenrec stop', ...r.warnings.map((w) => `warning: ${w}`)];
  if (r.recovered) lines.unshift(`recovered an earlier recording: ${r.recovered.out}`);
  return { ok: true, text: lines.join('\n'), ...r };
};
export default cmd;
```

```ts
// src/commands/stop.ts
import { stopRecording } from '../recorder.ts';
import type { CommandFn } from './types.ts';
const cmd: CommandFn = async () => {
  const r = await stopRecording();
  return { ok: true, text: `saved ${r.out} (${r.durationSec.toFixed(1)} s, ${r.reason})`, ...r };
};
export default cmd;
```

```ts
// src/commands/status.ts
import { recordingStatus } from '../recorder.ts';
import type { CommandFn } from './types.ts';
const cmd: CommandFn = async () => ({ ok: true, ...recordingStatus() });
export default cmd;
```

```ts
// src/commands/mark.ts
import { addMark } from '../recorder.ts';
import { ScreenrecError } from '../core/errors.ts';
import type { CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const text = a.positionals.join(' ').trim();
  if (!text) throw new ScreenrecError('E_BAD_ARGS', 'mark needs some text', 'Example: screenrec mark "clicked Download"');
  const r = addMark(text);
  return { ok: true, text: `noted at ${r.t} s: ${text}`, ...r };
};
export default cmd;
```

```ts
// src/commands/screenshot.ts
import fs from 'node:fs'; import path from 'node:path';
import * as mac from '../capture/mac.ts';
import { parseTarget, type TargetFlags } from '../core/targets.ts';
import { recordingsDir, defaultRecordingBase } from '../core/paths.ts';
import { resolveEndpoint } from '../capture/cdp/endpoint.ts';
import { CdpClient } from '../capture/cdp/client.ts';
import { listTabs } from '../capture/cdp/tabs-list.ts';
import { ScreenrecError } from '../core/errors.ts';
import type { CommandFn } from './types.ts';

const cmd: CommandFn = async (a) => {
  const target = parseTarget(a.values as TargetFlags);
  const out = path.resolve((a.values.out as string | undefined) ?? path.join(recordingsDir(), `${defaultRecordingBase()}.png`));
  if (target.kind === 'tab') {
    if (target.mode !== 'url' && target.mode !== 'title') {
      throw new ScreenrecError('E_BAD_ARGS', 'Tab screenshots need a specific tab', 'Use --tab url:<text> or --tab title:<text>.');
    }
    const { wsUrl } = await resolveEndpoint({ cdp: target.cdp });
    const p = target.pattern!.toLowerCase();
    const tab = (await listTabs(wsUrl)).find((t) => (target.mode === 'url' ? t.url : t.title).toLowerCase().includes(p));
    if (!tab) throw new ScreenrecError('E_TARGET_NOT_FOUND', `No tab matches "${target.pattern}"`, 'Run "screenrec list tabs".');
    const c = await CdpClient.connect(wsUrl);
    try {
      const { sessionId } = await c.send<{ sessionId: string }>('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
      const { data } = await c.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId);
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId);
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
    } finally { c.close(); }
    return { ok: true, text: `screenshot of tab "${tab.title}": ${out}`, out };
  }
  mac.assertMac();
  const { spec, label } = mac.resolveCaptureSpec(target, await mac.listDisplays(), await mac.listWindows(), false);
  const r = await mac.screenshot(spec, out);
  return { ok: true, text: `screenshot of ${label}: ${r.out}`, ...r };
};
export default cmd;
```

```ts
// src/commands/list.ts
import * as mac from '../capture/mac.ts';
import { resolveEndpoint } from '../capture/cdp/endpoint.ts';
import { listTabs } from '../capture/cdp/tabs-list.ts';
import { describeWindow } from '../core/targets.ts';
import { ScreenrecError } from '../core/errors.ts';
import type { CommandFn } from './types.ts';

const cmd: CommandFn = async (a) => {
  const kind = a.positionals[0];
  if (kind === 'displays') {
    mac.assertMac(); const displays = await mac.listDisplays();
    return { ok: true, text: displays.map((d, i) => `${i + 1}: ${d.name} ${d.width}x${d.height} pt @${d.scale}x at ${d.x},${d.y}${d.main ? ' (main)' : ''}`).join('\n'), displays };
  }
  if (kind === 'windows') {
    mac.assertMac(); const windows = (await mac.listWindows()).sort((x, y) => x.z - y.z);
    return { ok: true, text: windows.map(describeWindow).join('\n'), windows };
  }
  if (kind === 'tabs') {
    const tabs = await listTabs((await resolveEndpoint({ cdp: a.values.cdp as string | undefined })).wsUrl);
    return { ok: true, text: tabs.map((t) => `${t.title} (${t.url})`).join('\n'), tabs };
  }
  throw new ScreenrecError('E_BAD_ARGS', `Unknown list "${kind ?? ''}"`, 'Use: screenrec list windows | displays | tabs');
};
export default cmd;
```

```ts
// src/commands/doctor.ts
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { requireFfmpeg } from '../edit/ffmpeg.ts';
import * as mac from '../capture/mac.ts';
import { resolveEndpoint } from '../capture/cdp/endpoint.ts';
import type { CommandFn } from './types.ts';

interface Check { name: string; ok: boolean; detail: string; fix?: string }

const cmd: CommandFn = async () => {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: major >= 22, detail: process.versions.node, fix: major >= 22 ? undefined : 'Install Node 22 or newer.' });
  try { checks.push({ name: 'ffmpeg', ok: true, detail: await requireFfmpeg() }); }
  catch (e) { checks.push({ name: 'ffmpeg', ok: false, detail: 'not found', fix: (e as { fix?: string }).fix }); }
  if (process.platform === 'darwin') {
    const ver = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
    checks.push({ name: 'macOS', ok: Number(ver.split('.')[0]) >= 13, detail: ver, fix: 'Window capture needs macOS 13 or newer.' });
    const helper = fs.existsSync(mac.helperPath());
    checks.push({ name: 'capture helper', ok: helper, detail: mac.helperPath(), fix: helper ? undefined : 'Run "npm run build:native" or reinstall screenrec.' });
    if (helper) {
      const granted = await mac.permission().catch(() => false);
      checks.push({ name: 'Screen Recording permission', ok: granted, detail: granted ? 'granted' : 'not granted', fix: granted ? undefined : mac.HELPER_FIXES.E_PERMISSION });
    }
    try {
      const v = execFileSync('defaults', ['read', '/Applications/Google Chrome.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim();
      const ok = Number(v.split('.')[0]) >= 144;
      checks.push({ name: 'Chrome version', ok, detail: v, fix: ok ? undefined : 'Hidden-tab recording in your normal Chrome needs Chrome 144 or newer; update Chrome.' });
    } catch { checks.push({ name: 'Chrome version', ok: true, detail: 'Google Chrome not installed in /Applications (optional)' }); }
    checks.push({ name: 'Chrome windows', ok: true, detail: 'Chrome pauses drawing covered windows',
      fix: 'For window capture of Chrome keep the window uncovered (a second display works), or record a --tab instead.' });
  } else {
    checks.push({ name: 'window capture', ok: false, detail: `not available on ${process.platform} in v1`, fix: 'Use --tab for Chrome tabs; window capture is macOS-only for now.' });
  }
  try { const e = await resolveEndpoint({}); checks.push({ name: 'Chrome tab capture', ok: true, detail: `${e.source}: ${e.wsUrl.replace(/\/devtools.*/, '')}` }); }
  catch (e) { checks.push({ name: 'Chrome tab capture', ok: false, detail: 'remote debugging not enabled', fix: (e as { fix?: string }).fix }); }
  const text = checks.map((c) => `${c.ok ? 'ok  ' : 'FIX '} ${c.name}: ${c.detail}${!c.ok && c.fix ? `\n      ${c.fix}` : ''}`).join('\n');
  return { ok: true, text, allPassed: checks.every((c) => c.ok), checks };
};
export default cmd;
```

- [ ] **Step 7: Run all automated tests** → `npm test && npm run test:video && npm run typecheck`. Expected: all pass.

- [ ] **Step 8: End-to-end smoke with the fake helper through the real CLI**

```bash
npm run build
export SCREENREC_HOME=$(mktemp -d) SCREENREC_MAC_HELPER=$PWD/test/fixtures/fake-screenrec-mac.mjs
./bin/screenrec start --window Finder --json && sleep 2 && ./bin/screenrec mark "step one" && ./bin/screenrec status && ./bin/screenrec stop --json
```

Expected: start JSON with `"worker":"mac"`, status `recording ...`, stop JSON with an `out` mp4 that `ffprobe` can read.

- [ ] **Step 9: Commit**

```bash
git add src/recorder.ts src/capture/chrome-applescript.ts src/capture/mac.ts src/commands test/fixtures/fake-screenrec-mac.mjs test/unit/chrome-applescript.test.ts test/video/recorder.test.ts
git commit -m "feat(core): recording orchestration, crash recovery and remaining commands"
```

---

### Task 20: MCP server (mcp-agents)

Before writing code, fetch the current `@modelcontextprotocol/sdk` server and client docs (Context7: resolve "modelcontextprotocol typescript sdk", query "McpServer registerTool StdioServerTransport InMemoryTransport"). If the API differs from the code below, follow the docs and keep the tool names, inputs and outputs exactly as specified here.

**Files:**
- Create: `src/mcp/server.ts`, `src/commands/mcp.ts`
- Test: `test/mcp/server.test.ts`

**Interfaces:**
- Consumes: every `src/commands/*.ts` default export (Tasks 6-19), `ParsedArgs` (6), `errorJson` (2), `frame` (8).
- Produces:
  - `TOOL_NAMES: readonly string[]` = `['doctor', 'list_targets', 'record_start', 'record_status', 'record_mark', 'record_stop', 'screenshot', 'video_squeeze', 'video_crop', 'video_blur', 'video_trim', 'video_gif', 'video_frame']`
  - `buildServer(): McpServer`
  - `screenrec mcp` runs it on stdio and never returns.
- Tool results: success is `{ content: [{ type: 'text', text: JSON.stringify(commandResult) }, ...images] }`; failure is `{ isError: true, content: [{ type: 'text', text: JSON.stringify(errorJson(e)) }] }`. `record_stop`, `screenshot` and `video_frame` add one PNG image (480 px wide).
- Tool inputs use snake_case (`display_of`, `follow_app`, `ignore_app`, `trim_edges`, `no_meta`) and map to the CLI's kebab-case flags.

- [ ] **Step 1: Install the SDK**

```bash
npm install @modelcontextprotocol/sdk zod
```

- [ ] **Step 2: Write the failing test**

`test/mcp/server.test.ts`:

```ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, TOOL_NAMES } from '../../src/mcp/server.ts';
import { makeVideo } from '../video/helpers.ts';

let client: Client; let video = '';
before(async () => {
  process.env.SCREENREC_MAC_HELPER = new URL('../fixtures/fake-screenrec-mac.mjs', import.meta.url).pathname;
  process.env.SCREENREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-home-'));
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cwd-')));
  video = path.join(process.cwd(), 'in.mp4'); await makeVideo(video, 'moving', { seconds: 2 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(a);
  client = new Client({ name: 'test', version: '0.0.0' }); await client.connect(b);
});
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { type: string; text?: string; data?: string }[] }>;
const json = (r: { content: { type: string; text?: string }[] }) => JSON.parse(r.content.find((c) => c.type === 'text')!.text!);

test('lists exactly the documented tools, each with a description', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  for (const t of tools) assert.ok((t.description ?? '').length > 20, t.name);
  const start = tools.find((t) => t.name === 'record_start')!;
  assert.match(start.description!, /tell the user/i);
});

test('doctor and list_targets work', async () => {
  assert.equal(json(await call('doctor')).ok, true);
  const r = await call('list_targets', { kind: 'displays' });
  if (process.platform === 'darwin') assert.equal(json(r).displays[0].name, 'Built-in');
  else assert.equal(json(r).code, 'E_UNSUPPORTED_PLATFORM');
});

test('video tools run on a real file; frame returns an image', async () => {
  assert.ok(json(await call('video_squeeze', { input: video })).out);
  assert.ok(json(await call('video_crop', { input: video, trim_edges: 8 })).out);
  assert.ok(json(await call('video_blur', { input: video, box: ['10,10,40,40'] })).out);
  assert.ok(json(await call('video_trim', { input: video, from: 0.5, to: 1.5 })).out);
  assert.ok(json(await call('video_gif', { input: video, width: 200 })).out);
  const f = await call('video_frame', { input: video, at: 1 });
  assert.ok(f.content.some((c) => c.type === 'image' && (c.data ?? '').length > 100));
});

test('errors come back as isError with a code and a fix', async () => {
  const r = await call('video_crop', { input: '/nope.mp4', trim_edges: 8 });
  assert.equal(r.isError, true); const j = json(r); assert.equal(j.code, 'E_BAD_ARGS'); assert.ok(j.fix);
});

test('record_start, record_mark, record_status, record_stop with a preview image (macOS)', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(json(await call('record_start', { window: 'Finder' })).worker, 'mac');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(json(await call('record_mark', { text: 'step' })).ok, true);
  assert.equal(json(await call('record_status')).recording, true);
  const stop = await call('record_stop');
  assert.ok(json(stop).out.endsWith('.mp4'));
  assert.ok(stop.content.some((c) => c.type === 'image'));
});
```

Add `"test:mcp"` to the CI list (already in `package.json` from Task 2).

- [ ] **Step 3: Run to verify failure** → `npm run test:mcp`.

- [ ] **Step 4: Implement `src/mcp/server.ts` and `src/commands/mcp.ts`**

`src/mcp/server.ts`:

```ts
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorJson } from '../core/errors.ts';
import type { ParsedArgs, CommandFn, CommandResult } from '../commands/types.ts';
import { frame } from '../edit/frame.ts';

export const TOOL_NAMES = ['doctor', 'list_targets', 'record_start', 'record_status', 'record_mark', 'record_stop', 'screenshot',
  'video_squeeze', 'video_crop', 'video_blur', 'video_trim', 'video_gif', 'video_frame'] as const;

const TELL = 'Tell the user in chat when you start and when you stop recording, and what is being recorded.';

const target = {
  window: z.string().optional().describe('"App", "App:title part" or a window id. Preferred target.'),
  app: z.string().optional().describe("App name: records that app's front window."),
  display: z.string().optional().describe('main, a 1-based number or part of a display name. Captures everything on it.'),
  display_of: z.string().optional().describe('Record the whole display that holds this window.'),
  region: z.string().optional().describe('x,y,w,h in points from the top-left of --display.'),
  tab: z.string().optional().describe('Chrome tab: newest, follow, url:<text> or title:<text>. Works on hidden tabs.'),
  cdp: z.string().optional().describe('Loopback CDP endpoint of a test browser, e.g. http://127.0.0.1:9222.'),
};

type Values = Record<string, unknown>;
const kebab = (k: string) => k.replace(/_/g, '-');

function toArgs(command: string, positionals: string[], values: Values): ParsedArgs {
  const v: ParsedArgs['values'] = {};
  for (const [k, val] of Object.entries(values)) {
    if (val === undefined) continue;
    v[kebab(k)] = typeof val === 'number' ? String(val) : (val as string | boolean | string[]);
  }
  return { command, positionals, values: v, json: true };
}

async function load(command: string): Promise<CommandFn> {
  const m = await import(`../commands/${command}.js`).catch(() => import(`../commands/${command}.ts`));
  return (m as { default: CommandFn }).default;
}

async function preview(file: string, at: number) {
  const { out } = await frame(file, { at, width: 480, out: `${file}.preview.png` });
  const data = fs.readFileSync(out).toString('base64'); fs.rmSync(out, { force: true });
  return { type: 'image' as const, data, mimeType: 'image/png' };
}

function tool(
  server: McpServer, name: (typeof TOOL_NAMES)[number], description: string, shape: Record<string, z.ZodTypeAny>,
  command: string, positional: (a: Values) => string[], withImage?: (r: CommandResult, a: Values) => Promise<{ type: 'image'; data: string; mimeType: string } | null>,
) {
  server.registerTool(name, { description, inputSchema: shape }, async (a: Values) => {
    try {
      const rest = { ...a }; for (const k of ['input', 'text', 'kind']) delete rest[k];
      const r = await (await load(command))(toArgs(command, positional(a), rest));
      const img = withImage ? await withImage(r, a).catch(() => null) : null;
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }, ...(img ? [img] : [])] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(errorJson(e)) }] };
    }
  });
}

export function buildServer(): McpServer {
  const s = new McpServer({ name: 'screenrec', version: '0.1.0' });
  const none = () => [];
  const input = (a: Values) => [String(a.input)];
  tool(s, 'doctor', 'Check that recording will work here: permission, ffmpeg, capture helper, Chrome remote debugging. Returns each check with a fix.', {}, 'doctor', none);
  tool(s, 'list_targets', 'List what can be recorded: windows (with ids), displays, or Chrome tabs.', { kind: z.enum(['windows', 'displays', 'tabs']), cdp: target.cdp }, 'list', (a) => [String(a.kind)]);
  tool(s, 'record_start', `Start recording one target, locally (nothing is uploaded). Prefer a window or tab target over a display. Use follow_app when the work will open other apps. Then do the task, add record_mark notes at each step, and call record_stop. ${TELL}`,
    { ...target, follow_app: z.boolean().optional(), ignore_app: z.array(z.string()).optional(), out: z.string().optional(), fps: z.number().optional(),
      cursor: z.boolean().optional(), max: z.string().optional().describe('Auto-stop after e.g. 10m (default).'), no_meta: z.boolean().optional() },
    'start', none);
  tool(s, 'record_status', 'Is a recording running? Shows target, elapsed time and output path.', {}, 'status', none);
  tool(s, 'record_mark', 'Add a timestamped step note to the running recording, e.g. "clicked Download".', { text: z.string() }, 'mark', (a) => [String(a.text)]);
  tool(s, 'record_stop', `Stop and save the recording as mp4 (plus a JSON sidecar with step notes). Returns a preview frame so you can check it recorded the right thing. ${TELL}`, {}, 'stop', none,
    async (r) => preview(String(r.out), Math.max(0, Number(r.durationSec) / 2)));
  tool(s, 'screenshot', 'Save one PNG of a window, display, region or Chrome tab (url:/title:), and return it.', { ...target, out: z.string().optional() }, 'screenshot', none,
    async (r) => ({ type: 'image', data: fs.readFileSync(String(r.out)).toString('base64'), mimeType: 'image/png' }));
  tool(s, 'video_squeeze', 'Remove frozen stretches (waiting for an answer, idle pauses). Re-times step notes.', { input: z.string(), out: z.string().optional(), fps: z.number().optional() }, 'squeeze', input);
  tool(s, 'video_crop', 'Crop by rect x,y,w,h in output pixels, or trim_edges N pixels (removes Claude in Chrome\'s edge glow).', { input: z.string(), rect: z.string().optional(), trim_edges: z.number().optional(), out: z.string().optional() }, 'crop', input);
  tool(s, 'video_blur', 'Pixelate then blur boxes. box: ["x,y,w,h" or "x,y,w,h@from-to"]; boxes: path to a JSON file with keyframed boxes for scrolling content.', { input: z.string(), box: z.array(z.string()).optional(), boxes: z.string().optional(), out: z.string().optional() }, 'blur', input);
  tool(s, 'video_trim', 'Cut the start and end, in seconds.', { input: z.string(), from: z.number().optional(), to: z.number(), out: z.string().optional() }, 'trim', input);
  tool(s, 'video_gif', 'Export a looping GIF (two-pass palette) for READMEs and chats.', { input: z.string(), width: z.number().optional(), fps: z.number().optional(), out: z.string().optional() }, 'gif', input);
  tool(s, 'video_frame', 'Save and return one still frame, for checking content or measuring blur boxes.', { input: z.string(), at: z.number(), width: z.number().optional(), out: z.string().optional() }, 'frame', input,
    async (r) => ({ type: 'image', data: fs.readFileSync(String(r.out)).toString('base64'), mimeType: 'image/png' }));
  return s;
}
```

`src/commands/mcp.ts`:

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../mcp/server.ts';
import type { CommandFn } from './types.ts';

const cmd: CommandFn = async () => {
  await buildServer().connect(new StdioServerTransport());
  return new Promise(() => {}); // serve until the client closes stdin; never print to stdout
};
export default cmd;
```

- [ ] **Step 5: Run tests** → `npm run test:mcp && npm test && npm run typecheck`. Expected: pass (the macOS record test runs on macOS only).

- [ ] **Step 6: Smoke over real stdio**

```bash
npm run build
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"s","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | timeout 5 ./bin/screenrec mcp | head -c 400
```

Expected: an initialize result, then a tools list starting with the documented names. (macOS has no `timeout` by default: use `gtimeout` from coreutils or end the pipe manually.)

- [ ] **Step 7: Commit**

```bash
git add src/mcp src/commands/mcp.ts test/mcp package.json package-lock.json
git commit -m "feat(mcp): stdio MCP server mirroring the CLI"
```

---

### Task 21: Claude Code plugin, skill and AGENTS snippet (mcp-agents)

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/skills/screen-record/SKILL.md`
- Create: `agents/AGENTS.snippet.md`
- Test: `test/unit/plugin.test.ts`

**Interfaces:**
- Consumes: `TOOL_NAMES` (20), the command table (6).
- Produces: an installable Claude Code plugin whose MCP server runs `screenrec mcp`, and a skill that teaches the record, mark, stop, squeeze workflow.

- [ ] **Step 1: Write the failing test**

`test/unit/plugin.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOOL_NAMES } from '../../src/mcp/server.ts';
import { COMMANDS } from '../../src/cli/args.ts';

const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('plugin manifest and MCP config are valid and point at screenrec mcp', () => {
  const manifest = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'screenrec'); assert.ok(manifest.description);
  const mcp = JSON.parse(read('plugin/.mcp.json'));
  assert.deepEqual(mcp.mcpServers.screenrec, { command: 'screenrec', args: ['mcp'] });
});

test('skill has frontmatter and only mentions tools that exist', () => {
  const skill = read('plugin/skills/screen-record/SKILL.md');
  assert.match(skill, /^---\nname: screen-record\ndescription: .{40,}\n---\n/);
  for (const m of skill.matchAll(/`((?:record|video|list|screenshot|doctor)[a-z_]*)`/g)) assert.ok((TOOL_NAMES as readonly string[]).includes(m[1]), `unknown tool ${m[1]}`);
  assert.doesNotMatch(skill, /\u2014/, 'no em dashes');
});

test('AGENTS snippet only uses real CLI commands', () => {
  const s = read('agents/AGENTS.snippet.md');
  for (const m of s.matchAll(/screenrec ([a-z]+)/g)) assert.ok(m[1] in COMMANDS, `unknown command ${m[1]}`);
  assert.doesNotMatch(s, /\u2014/);
});
```

- [ ] **Step 2: Run to verify failure** → `npm test`.

- [ ] **Step 3: Write the files**

`plugin/.claude-plugin/plugin.json`:

```json
{
  "name": "screenrec",
  "version": "0.1.0",
  "description": "Record what the agent does in any window, app, display or Chrome tab, then squeeze, crop, blur and export it. Local only.",
  "license": "MIT"
}
```

`plugin/.mcp.json`:

```json
{ "mcpServers": { "screenrec": { "command": "screenrec", "args": ["mcp"] } } }
```

`plugin/skills/screen-record/SKILL.md`:

```markdown
---
name: screen-record
description: Use when the user asks to record, screen-record, capture a video or GIF of, or show what you do on the computer, in an app, in Finder, or in a Chrome tab, including "visit this link and record it" and "open the file in my Downloads and record the whole navigation".
---

# Screen record

Recording is local; nothing is uploaded. Say in chat when you start and when you stop.

## Workflow

1. If unsure it will work, call `doctor` and relay any fix to the user.
2. Pick the narrowest target:
   - Work in one app window: `record_start` with `window` ("Finder", "Finder:Downloads") or `app`.
   - Work that opens other apps (Finder opening Preview): add `follow_app: true`.
   - Work in Chrome, including tabs you open in the background: `tab: "newest"`, or `tab: "follow"` if you will use several tabs. If `doctor` says remote debugging is off, ask the user to enable chrome://inspect/#remote-debugging.
   - Only use `display` when the task truly spans the whole screen; warn the user that notifications on that display will be captured.
3. Do the task. After each meaningful step call `record_mark` with a short note ("opened Downloads", "clicked the GIF").
4. Call `record_stop`. Look at the returned preview frame; if it shows the wrong thing, say so and offer to redo it.
5. Clean up: `video_squeeze` removes waiting time. Use `video_crop` with `trim_edges: 8` to remove Claude in Chrome's orange edge glow. Use `video_blur` for anything private (emails, tokens, names); measure boxes with `video_frame`.
6. If the user wants a GIF: `video_gif` (width 800 is a good default).
7. Tell the user the final file paths.

## Examples

- "Visit https://example.com and record it": `record_start` `{ "tab": "newest" }`, open the page in a new tab, look around with marks, `record_stop`, `video_squeeze`.
- "Record the tab I have open on GitHub": `record_start` `{ "tab": "url:github.com" }`.
- "Open the GIF in my Downloads and record the whole navigation": `record_start` `{ "app": "Finder", "follow_app": true }`, navigate to Downloads, open the file, wait until it is visible, `record_stop`, `video_squeeze`.
```

`agents/AGENTS.snippet.md`:

```markdown
## Screen recording (screenrec)

To record what you do, use the `screenrec` CLI. It records locally; nothing is uploaded. Tell the user when you start and stop.

1. `screenrec doctor` if unsure it will work; relay any fix to the user.
2. Start with the narrowest target:
   - `screenrec start --window "Finder:Downloads"` or `screenrec start --app Safari`
   - add `--follow-app` when the work opens other apps
   - `screenrec start --tab newest` (or `--tab follow`) for Chrome, including background tabs
   - `screenrec start --display main` only when the whole screen is needed
3. After each step: `screenrec mark "what you just did"`.
4. `screenrec stop --json` prints the saved mp4 path.
5. Clean up: `screenrec squeeze <file>`, `screenrec crop <file> --trim-edges 8`, `screenrec blur <file> --box x,y,w,h`, `screenrec gif <file>`.
6. Use `screenrec frame <file> --at <seconds>` to check content or measure blur boxes.
```

- [ ] **Step 4: Run tests** → `npm test`, pass. Then ask the coordinator to run the plugin-validator agent on `plugin/` and fix anything it reports.

- [ ] **Step 5: Commit**

```bash
git add plugin agents test/unit/plugin.test.ts
git commit -m "feat(agents): claude code plugin, skill and AGENTS snippet"
```

---

### Task 22: Security and privacy checks (security-review)

**Files:**
- Create: `test/security/no-network.test.ts`, `test/security/no-shell.test.ts`
- Create: `docs/REVIEW-CHECKLIST.md`

**Interfaces:**
- Consumes: the whole `src/` tree.
- Produces: tests that fail the build on any non-loopback network use or shell execution, and the checklist the reviewer applies to every merge.

- [ ] **Step 1: Write the tests**

`test/security/no-network.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';

const root = new URL('../../src/', import.meta.url).pathname;
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []);
const rel = (f: string) => path.relative(root, f);

const RULES: { name: string; re: RegExp; allowed: string[] }[] = [
  { name: 'fetch', re: /\bfetch\(/, allowed: ['capture/cdp/endpoint.ts'] },
  { name: 'WebSocket', re: /new\s+(WebSocket|Impl)\(/, allowed: ['capture/cdp/client.ts'] },
  { name: 'node network modules', re: /from\s+'node:(http|https|net|tls|dgram|dns)'/, allowed: [] },
  { name: 'non-loopback URL literal', re: /['"`](?:https?|wss?):\/\/(?!127\.0\.0\.1|localhost|\[::1\])/, allowed: [] },
];

test('no network access outside the loopback CDP client', () => {
  const problems: string[] = [];
  for (const f of files(root)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const r of RULES) if (r.re.test(src) && !r.allowed.includes(rel(f))) problems.push(`${rel(f)}: ${r.name}`);
  }
  assert.deepEqual(problems, []);
});

test('every fetch and socket is preceded by a loopback assertion', () => {
  const endpoint = fs.readFileSync(path.join(root, 'capture/cdp/endpoint.ts'), 'utf8');
  assert.match(endpoint, /assertLoopback\(url\);\s*\n\s*const r = await fetch\(url\)/);
  const client = fs.readFileSync(path.join(root, 'capture/cdp/client.ts'), 'utf8');
  assert.match(client, /assertLoopback\(wsUrl\);[\s\S]{0,120}new Impl\(wsUrl\)/);
});
```

`test/security/no-shell.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';

const root = new URL('../../src/', import.meta.url).pathname;
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []);

test('no shell execution anywhere in src', () => {
  const bad: string[] = [];
  for (const f of files(root)) {
    const s = fs.readFileSync(f, 'utf8');
    if (/shell:\s*true/.test(s) || /\bexecSync\(|\bexec\(\s*['"`]/.test(s) || /from 'node:child_process'.*\bexec\b[,}]/.test(s)) bad.push(path.relative(root, f));
  }
  assert.deepEqual(bad, []);
});
```

- [ ] **Step 2: Run** → `npm test`. Expected: pass. If a rule fires, fix the source, never widen the allowlist without the coordinator's approval and a spec note.

- [ ] **Step 3: Write `docs/REVIEW-CHECKLIST.md`**

```markdown
# Review checklist (applied to every merge)

- [ ] No network access except the loopback CDP endpoint (`npm test` security tests pass).
- [ ] Subprocesses use argument arrays; no `shell: true`, no string commands.
- [ ] User-supplied paths and window titles are never interpolated into a shell, AppleScript or filter graph without quoting. Filter-graph expressions are numeric only.
- [ ] Recordings, raw files, logs and sidecars stay under the chosen output directory; `./recordings/.gitignore` is created.
- [ ] Nothing hides or suppresses the macOS recording indicator.
- [ ] Display capture prints the notifications warning.
- [ ] Blur pixelates before blurring.
- [ ] Errors carry a code and a one-line fix; no stack traces unless `SCREENREC_DEBUG=1`.
- [ ] New dependencies: licence checked (MIT, Apache-2.0, BSD, ISC); runtime dependencies only with a spec update.
- [ ] No em dashes in code, comments or docs.
- [ ] Every claim of real-machine behaviour is in `docs/TESTED.md` with date and evidence.
```

- [ ] **Step 4: Commit**

```bash
git add test/security docs/REVIEW-CHECKLIST.md
git commit -m "test(security): enforce loopback-only network and no shell"
```

---

### Task 23: macOS real-machine matrix (qa)

Takes over the user's screen. The coordinator announces it, and nothing else that touches the screen runs at the same time. Evidence frames stay in `recordings/matrix-<date>/` (gitignored, they may show private content); only the summary goes into `docs/TESTED.md`.

**Files:**
- Create: `test/mac-matrix/run.mjs`, `test/mac-matrix/lib.mjs`
- Modify: `docs/TESTED.md`

**Interfaces:**
- Consumes: the built CLI (`bin/screenrec`), `test/fixtures/colour-page.html`, the Task 1 gate probe.
- Produces: `npm run test:mac` runs every automatic scenario, prompts for the manual ones, prints a table, and appends a `## Matrix <date>` section to `docs/TESTED.md` with `PASS`, `FAIL`, `KNOWN-LIMIT` or `MANUAL-PASS/FAIL` per scenario.

- [ ] **Step 1: Write the helpers**

`test/mac-matrix/lib.mjs`:

```js
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline/promises';
const exec = promisify(execFile);

export const bin = path.resolve('bin/screenrec');
export const evidenceDir = path.resolve('recordings', `matrix-${new Date().toISOString().slice(0, 10)}`);
fs.mkdirSync(evidenceDir, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const osa = (script) => execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
export function sr(...args) {
  const out = execFileSync(bin, [...args, '--json'], { encoding: 'utf8' }).trim().split('\n').at(-1);
  const j = JSON.parse(out); if (!j.ok) throw new Error(`${args.join(' ')}: ${j.code} ${j.message}`); return j;
}
export const pageUrl = (q = '') => `file://${path.resolve('test/fixtures/colour-page.html')}${q}`;

/** Coarse colour buckets of the centre pixel every 0.25 s. */
export async function centreColours(file, seconds, from = 0) {
  const seen = new Set();
  for (let t = from + 0.25; t < from + seconds; t += 0.25) {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1',
      '-vf', 'crop=4:4:(iw-4)/2:(ih-4)/2,scale=1:1,format=rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
    seen.add([stdout[0], stdout[1], stdout[2]].map((v) => Math.round(v / 64)).join(','));
  }
  return seen.size;
}

export async function grayDiff(file, t1, t2, crop) {
  const grab = async (t) => (await exec('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `${crop ? `crop=${crop},` : ''}scale=160:-2,format=gray`, '-f', 'rawvideo', '-'], { encoding: 'buffer' })).stdout;
  const a = await grab(t1), b = await grab(t2);
  let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.abs(a[i] - b[i]); return s / a.length;
}

export async function evidence(file, name, at) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', path.join(evidenceDir, `${name}-${at}s.png`)]);
}

export async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/n] `)).trim().toLowerCase(); rl.close(); return a.startsWith('y');
}

export function cover() { osa('tell application "TextEdit" to activate'); osa('tell application "TextEdit" to make new document'); osa('tell application "TextEdit" to set bounds of front window to {0, 30, 1440, 900}'); }
export function uncover() { try { osa('tell application "TextEdit" to close every document saving no'); } catch {} }
```

- [ ] **Step 2: Write the scenarios**

`test/mac-matrix/run.mjs`:

```js
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { sr, osa, sleep, pageUrl, centreColours, grayDiff, evidence, ask, cover, uncover, evidenceDir } from './lib.mjs';

const results = [];
async function scenario(name, fn) {
  process.stdout.write(`\n== ${name}\n`);
  try { const r = await fn(); results.push({ name, ...r }); console.log(r.result, r.note ?? ''); }
  catch (e) { results.push({ name, result: 'FAIL', note: e.message }); console.log('FAIL', e.message); try { sr('stop'); } catch {} uncover(); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-'));
const displays = sr('list', 'displays').displays;

await scenario('covered Finder window, folder changes while hidden', async () => {
  fs.mkdirSync(path.join(tmp, 'A/one'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'B/two'), { recursive: true });
  osa(`tell application "Finder" to set bounds of (make new Finder window to (POSIX file "${tmp}/A" as alias)) to {100, 120, 900, 620}`);
  cover(); await sleep(800);
  sr('start', '--window', 'Finder:A');
  await sleep(1500); osa(`tell application "Finder" to set target of (first Finder window whose name is "A") to (POSIX file "${tmp}/B" as alias)`); await sleep(1500);
  const r = sr('stop'); uncover(); osa('tell application "Finder" to close (first Finder window whose name is "B")');
  const d = await grayDiff(r.out, 0.5, r.durationSec - 0.3);
  await evidence(r.out, 'finder', 0.5); await evidence(r.out, 'finder', Math.max(0.6, r.durationSec - 0.3));
  return { result: d > 3 ? 'PASS' : 'FAIL', note: `frame diff ${d.toFixed(1)}; check evidence shows Finder only, no TextEdit` };
});

await scenario('covered Safari window stays live (throttled)', async () => {
  osa(`tell application "Safari" to make new document with properties {URL:"${pageUrl()}"}`); await sleep(2000);
  osa('tell application "Safari" to set bounds of front window to {100, 120, 900, 620}');
  cover(); await sleep(800);
  sr('start', '--window', 'Safari:SCREENREC COLOUR'); await sleep(6000); const r = sr('stop'); uncover();
  osa('tell application "Safari" to close (every window whose name contains "SCREENREC")');
  const n = await centreColours(r.out, 5.5);
  return { result: n >= 3 ? 'PASS' : 'FAIL', note: `${n} distinct colours in 5.5 s` };
});

await scenario('covered Chrome window without the flag (expected to freeze)', async () => {
  osa(`tell application "Google Chrome" to set URL of active tab of (make new window) to "${pageUrl()}"`); await sleep(2000);
  osa('tell application "Google Chrome" to set bounds of front window to {100, 120, 900, 620}');
  cover(); await sleep(1500);
  sr('start', '--window', 'Google Chrome:SCREENREC COLOUR'); await sleep(4000); const r = sr('stop'); uncover();
  osa('tell application "Google Chrome" to close (every window whose title contains "SCREENREC")');
  const n = await centreColours(r.out, 3.5);
  return { result: n <= 2 ? 'KNOWN-LIMIT' : 'PASS', note: `${n} colours; doctor's Chrome advice applies when frozen` };
});

await scenario('window moved to the other display mid-recording', async () => {
  if (displays.length < 2) return { result: 'MANUAL-SKIP', note: 'one display connected' };
  const other = displays.find((d) => !d.main);
  osa(`tell application "Safari" to make new document with properties {URL:"${pageUrl()}"}`); await sleep(2000);
  osa('tell application "Safari" to set bounds of front window to {100, 120, 900, 620}');
  sr('start', '--window', 'Safari:SCREENREC COLOUR'); await sleep(2000);
  osa(`tell application "Safari" to set bounds of front window to {${other.x + 50}, ${other.y + 80}, ${other.x + 850}, ${other.y + 580}}`);
  await sleep(3000); const r = sr('stop'); osa('tell application "Safari" to close (every window whose name contains "SCREENREC")');
  const n = await centreColours(r.out, 2.5, 2.5); await evidence(r.out, 'moved', r.durationSec - 0.5);
  return { result: n >= 3 ? 'PASS' : 'FAIL', note: `${n} colours after the move` };
});

await scenario('minimized then restored', async () => {
  osa(`tell application "Safari" to make new document with properties {URL:"${pageUrl()}"}`); await sleep(2000);
  sr('start', '--window', 'Safari:SCREENREC COLOUR'); await sleep(1500);
  osa('tell application "Safari" to set miniaturized of front window to true'); await sleep(2000);
  const st = sr('status');
  osa('tell application "Safari" to set miniaturized of (every window whose name contains "SCREENREC") to false'); await sleep(2500);
  const r = sr('stop'); osa('tell application "Safari" to close (every window whose name contains "SCREENREC")');
  const n = await centreColours(r.out, 2, r.durationSec - 2.2);
  return { result: st.recording && n >= 2 ? 'PASS' : 'FAIL', note: `still recording while minimized: ${st.recording}; ${n} colours after restore` };
});

await scenario('notification never appears in a window capture (and does in display capture)', async () => {
  osa('tell application "TextEdit" to activate'); osa('tell application "TextEdit" to make new document with properties {text:"static"}');
  osa('tell application "TextEdit" to set bounds of front window to {100, 120, 700, 520}'); await sleep(800);
  sr('start', '--window', 'TextEdit'); await sleep(1000);
  osa('display notification "SCREENREC TEST" with title "screenrec"'); await sleep(2500);
  const w = sr('stop');
  const dw = await grayDiff(w.out, 0.5, 2.5);
  sr('start', '--display', 'main'); await sleep(1000);
  osa('display notification "SCREENREC TEST 2" with title "screenrec"'); await sleep(2500);
  const d = sr('stop'); uncover();
  const main = displays.find((x) => x.main);
  const crop = `iw/4:ih/6:iw*3/4:0`; // top-right corner, where banners appear
  const dd = await grayDiff(d.out, 0.5, 2.0, crop);
  await evidence(d.out, 'notification-display', 2.0);
  return { result: dw < 2 && dd > 3 ? 'PASS' : 'FAIL', note: `window diff ${dw.toFixed(2)} (must stay ~0), display corner diff ${dd.toFixed(2)} (must rise), main ${main.name}` };
});

await scenario('follow-app: Finder opens an image in Preview', async () => {
  const img = path.join(tmp, 'screenrec-test.png');
  fs.copyFileSync(path.join(evidenceDir, fs.readdirSync(evidenceDir).find((f) => f.endsWith('.png'))), img);
  osa(`tell application "Finder" to set bounds of (make new Finder window to (POSIX file "${tmp}" as alias)) to {100, 120, 900, 620}`); await sleep(1000);
  const name = path.basename(tmp);
  sr('start', '--window', `Finder:${name}`, '--follow-app'); await sleep(1500);
  osa(`tell application "Finder" to open (POSIX file "${img}" as alias)`); await sleep(3000);
  const r = sr('stop');
  osa('tell application "Preview" to quit'); osa(`tell application "Finder" to close (first Finder window whose name is "${name}")`);
  const marks = JSON.parse(fs.readFileSync(r.sidecar, 'utf8')).marks.map((m) => m.text);
  return { result: marks.some((m) => m.startsWith('switched to Preview')) ? 'PASS' : 'FAIL', note: JSON.stringify(marks) };
});

await scenario('hidden Chrome tab in the normal profile (level B)', async () => {
  if (!(await ask('Is chrome://inspect/#remote-debugging enabled in your normal Chrome (Task 1)?'))) return { result: 'MANUAL-SKIP', note: 'not enabled' };
  sr('start', '--tab', 'newest'); await sleep(800);
  osa(`tell application "Google Chrome" to tell front window to make new tab with properties {URL:"${pageUrl()}"}`);
  osa('tell application "Google Chrome" to set active tab index of front window to 1'); // agent tab goes to the background
  await sleep(4000); const r = sr('stop');
  osa('tell application "Google Chrome" to close (every tab of every window whose title contains "SCREENREC")');
  const n = await centreColours(r.out, 3.5, r.durationSec - 3.8);
  return { result: n >= 4 ? 'PASS' : 'FAIL', note: `${n} colours from a background tab` };
});

for (const manual of [
  'Window on another Space: start --window on a window in another Space, switch Spaces twice, stop. Did the video show the window throughout?',
  'Full-screen app: start --app on an app in full-screen mode, interact, stop. Was the content recorded?',
  'Monitor unplugged: start --window on a window on the external display, unplug it, wait 3 s, stop. Was a playable file saved?',
  'Claude in Chrome alongside: run a Claude in Chrome task while "screenrec start --tab follow" records. Did both work?',
]) {
  console.log(`\nMANUAL: ${manual}`);
  results.push({ name: manual.split(':')[0], result: (await ask('Did it pass?')) ? 'MANUAL-PASS' : 'MANUAL-FAIL', note: manual });
}

const machine = `${osa('do shell script "sysctl -n hw.model"')}, macOS ${osa('do shell script "sw_vers -productVersion"')}, ${displays.length} display(s)`;
const table = ['', `## Matrix ${new Date().toISOString().slice(0, 10)}`, '', `Machine: ${machine}. Evidence: ${path.relative(process.cwd(), evidenceDir)} (local, not committed).`, '',
  '| Scenario | Result | Note |', '|---|---|---|', ...results.map((r) => `| ${r.name} | ${r.result} | ${String(r.note ?? '').replace(/\|/g, '/')} |`), ''].join('\n');
fs.appendFileSync('docs/TESTED.md', table);
console.log(table);
process.exit(results.some((r) => r.result === 'FAIL' || r.result === 'MANUAL-FAIL') ? 1 : 0);
```

- [ ] **Step 3: Run it (announced, real screen)**

Run: `npm run build && npm run build:native && npm run test:mac`
Expected: every automatic scenario `PASS` or `KNOWN-LIMIT`, manual ones answered. A `FAIL` goes back to the owning hire as a bug with the evidence frame path; QA reruns after the fix. Never edit a threshold to make a scenario pass without the coordinator's sign-off and a note in the table.

- [ ] **Step 4: Commit the summary only**

```bash
git add test/mac-matrix docs/TESTED.md
git commit -m "test(mac): real-machine matrix and recorded results"
```

---

### Task 24: Clean-room install test (qa)

**Files:**
- Create: `test/cleanroom/run.mjs`

**Interfaces:**
- Consumes: `README.md` fenced blocks tagged ` ```bash cleanroom ` (all platforms) and ` ```bash cleanroom-mac ` (macOS with permission). Task 25 writes those blocks; this task fails if there are none.
- Produces: `npm run test:cleanroom` packs the package, installs it into an empty directory, and runs every tagged README block exactly as written with that install's `bin` first on `PATH`.

- [ ] **Step 1: Write the runner**

`test/cleanroom/run.mjs`:

```js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const repo = process.cwd();
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('npm', ['run', 'build:native'], { stdio: 'inherit' });
const tgz = execFileSync('npm', ['pack', '--silent'], { encoding: 'utf8' }).trim().split('\n').at(-1);
const room = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-'));
execFileSync('npm', ['init', '-y'], { cwd: room, stdio: 'ignore' });
execFileSync('npm', ['install', path.join(repo, tgz)], { cwd: room, stdio: 'inherit' });
fs.rmSync(path.join(repo, tgz));

const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
const tags = process.platform === 'darwin' && process.env.CLEANROOM_MAC === '1' ? ['cleanroom', 'cleanroom-mac'] : ['cleanroom'];
const blocks = [...readme.matchAll(/```bash (cleanroom(?:-mac)?)\n([\s\S]*?)```/g)].filter((m) => tags.includes(m[1])).map((m) => m[2]);
if (blocks.length === 0) { console.error('README has no ```bash cleanroom blocks'); process.exit(1); }

const env = { ...process.env, PATH: `${path.join(room, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}`, SCREENREC_HOME: path.join(room, '.home') };
for (const [i, b] of blocks.entries()) {
  console.log(`\n--- block ${i + 1}\n${b}`);
  execFileSync('bash', ['-euo', 'pipefail', '-c', b], { cwd: room, env, stdio: 'inherit' });
}
console.log(`\nclean room passed: ${blocks.length} README block(s) in ${room}`);
```

- [ ] **Step 2: Run after Task 25 lands** → `npm run test:cleanroom` (and on macOS with permission, `CLEANROOM_MAC=1 npm run test:cleanroom`). Expected: every block exits 0. A failing block is a README bug or a packaging bug (for example `files` in `package.json` missing something); fix the cause, not the block.

- [ ] **Step 3: Commit**

```bash
git add test/cleanroom/run.mjs
git commit -m "test(release): clean-room install runs the README as written"
```

---

### Task 25: README, examples, licence and demo GIF (docs-dx)

**Files:**
- Create: `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `examples/record-finder.sh`, `examples/record-chrome-tab.sh`, `docs/demo.gif`

**Interfaces:**
- Consumes: the finished CLI and MCP server.
- Produces: user-facing docs whose ` ```bash cleanroom ` blocks Task 24 executes.

- [ ] **Step 1: Write `LICENSE`**

Standard MIT text, first line `MIT License`, then `Copyright (c) 2026 Saliu Jamiu Olamilekan`.

- [ ] **Step 2: Write `README.md`** with these sections, in this order, no em dashes:

1. Title, one-line pitch, the demo GIF (`docs/demo.gif`).
2. **What it does**: record a window, app, display, region or Chrome tab (including covered windows and hidden tabs), then squeeze, crop, blur, trim and export GIFs. Local only.
3. **Install**: Node 22+, ffmpeg (`brew install ffmpeg`), `npm install -g agent-screen-record` (the npm name `screenrec` belongs to an unrelated package; the bin is still `screenrec`. Not yet published; until then `npm install -g <path-to-repo>`), first-run Screen Recording permission on macOS.
4. **Use it from your agent**: Claude Code plugin (`/plugin install` from the repo path), Claude Desktop / Codex / Cursor MCP config (`{"command":"screenrec","args":["mcp"]}`), and the `agents/AGENTS.snippet.md` for shell-based agents.
5. **Quick start (CLI)** with this block, which the clean-room test runs on every platform:

   ````markdown
   ```bash cleanroom
   screenrec version
   screenrec doctor --json > /dev/null
   ffmpeg -v error -f lavfi -i "testsrc2=size=640x400:rate=30:duration=4,loop=loop=60:size=1:start=30,setpts=N/30/TB" -pix_fmt yuv420p demo.mp4
   screenrec squeeze demo.mp4 --json
   screenrec crop demo.squeeze.mp4 --trim-edges 8
   screenrec blur demo.squeeze.mp4 --box 40,40,200,60
   screenrec gif demo.squeeze.mp4 --width 480
   screenrec frame demo.squeeze.mp4 --at 1
   ```
   ````

   and this macOS block (run with `CLEANROOM_MAC=1`):

   ````markdown
   ```bash cleanroom-mac
   screenrec list displays
   screenrec screenshot --display main --out shot.png
   screenrec start --display main --max 5s
   sleep 2
   screenrec stop --json
   ```
   ````

6. **Targets** table (window, app, follow-app, display, display-of, region, tab modes) with one example each.
7. **Chrome**: hidden tabs need Chrome 144+ with `chrome://inspect/#remote-debugging` enabled (you approve a dialog; Chrome shows an automation bar while recording), or `--cdp` for test browsers; what happens without it (window fallback, with its limits).
8. **Multiple monitors**: windows follow across displays; `--display`, `--display-of`, display-relative regions.
9. **Privacy**: the section 7 defaults from the spec, in plain words.
10. **Troubleshooting**: a table of every error code with its fix (copy from the code, not from memory).
11. **Platforms**: macOS now; tab capture and clean-up on Windows and Linux; window capture there later.
12. **Licence**: MIT.

- [ ] **Step 3: Examples**

`examples/record-finder.sh`:

```bash
#!/usr/bin/env bash
# Records Finder opening a file from Downloads, following into the app that opens it.
set -euo pipefail
file="${1:?usage: record-finder.sh <file in ~/Downloads>}"
open ~/Downloads
sleep 1
screenrec start --app Finder --follow-app
screenrec mark "Downloads open"
open ~/Downloads/"$file"
sleep 3
screenrec mark "file opened"
screenrec stop --json
```

`examples/record-chrome-tab.sh`:

```bash
#!/usr/bin/env bash
# Records the newest Chrome tab, even while it stays in the background.
set -euo pipefail
url="${1:?usage: record-chrome-tab.sh <url>}"
screenrec start --tab newest
open -g -a "Google Chrome" "$url"
sleep "${2:-8}"
screenrec stop --json
```

- [ ] **Step 4: Record the demo GIF with the tool itself (real screen, announced)**

Run the Downloads success example from the spec (an agent opens a GIF from a test folder, not the user's real Downloads, and records the whole navigation with `--app Finder --follow-app`), then `squeeze`, `crop --trim-edges 8` if needed, and `gif --width 800`. Save as `docs/demo.gif` (keep it under 8 MB). **Show the GIF to the user through the coordinator and commit it only after they approve it**: it must not show private content.

- [ ] **Step 5: `CONTRIBUTING.md` and `SECURITY.md`**

`CONTRIBUTING.md`: how to build (`npm ci`, `npm run build`, `npm run build:native`), the test layers and their commands, conventional commits, the review checklist link, and "real-machine behaviour claims go in docs/TESTED.md with evidence".
`SECURITY.md`: report vulnerabilities privately through GitHub security advisories once the repository is public; the local-only and loopback-only guarantees and how they are tested.

- [ ] **Step 6: Run the clean room** → `npm run test:cleanroom` (and `CLEANROOM_MAC=1` on macOS). Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add README.md LICENSE CONTRIBUTING.md SECURITY.md examples docs/demo.gif
git commit -m "docs: readme, licence, examples and demo gif"
```

---

## Final verification (coordinator)

- [ ] All layers green on `main`: `npm test`, `npm run test:video`, `npm run test:chrome`, `npm run test:mcp`, `npm run typecheck`, `npm run test:cleanroom`.
- [ ] `docs/TESTED.md` has the Chrome gate and a matrix run with no `FAIL`.
- [ ] Security reviewer has signed off on every merge against `docs/REVIEW-CHECKLIST.md`.
- [ ] Spec clarification from Task 16 (follow switches among agent-created tabs only) written into the spec.
- [ ] Whole-branch review by a fresh reviewer agent; findings fixed or explicitly accepted by the user.
- [ ] Report to the user with real command output. Nothing pushed or published.

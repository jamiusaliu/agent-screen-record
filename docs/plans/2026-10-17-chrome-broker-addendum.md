# Addendum: Chrome broker and the Chrome DevTools MCP route

Adds Tasks 26 and 27 to `2026-10-17-agent-screen-record-v1.md` after the user's
decision on 2026-10-17. Spec: section 6.6 of
`docs/specs/2026-10-17-agent-screen-record-design.md`. The plan's Global
Constraints apply unchanged; the broker's WebSocket server listens on
`127.0.0.1` only.

Order: Task 26 after Task 19 is merged and before Task 20. Task 27's parts land
with the hires named below.

---

### Task 26: Chrome broker (chrome-cdp)

**Files:**
- Create: `src/capture/cdp/broker.ts` (the proxy and its process entry)
- Create: `src/capture/cdp/broker-client.ts` (find, start, stop the broker)
- Create: `src/commands/chrome-broker.ts` (`screenrec chrome-broker status|stop`)
- Modify: `src/capture/cdp/endpoint.ts` (endpoint 2 resolves through the broker)
- Modify: `src/cli/args.ts` (command table: `chrome-broker` with positional `status|stop`)
- Modify: `src/commands/doctor.ts` (report the broker)
- Test: `test/unit/broker.test.ts` (fake upstream WebSocket server), `test/chrome/broker.test.ts` (Chrome for Testing)

**Interfaces:**
- Consumes: `CdpClient`, `assertLoopback`, `readDevToolsActivePort`, `chromeUserDataDirs` (15); `stateDir` (5); `ScreenrecError` (2).
- Produces:
  - `interface BrokerInfo { pid: number; port: number; token: string; upstream: string; startedAt: number }` stored at `$SCREENREC_HOME/chrome-broker.json`, file mode 0600.
  - `runBroker(o: { upstream: string; idleMs: number; infoPath: string }): Promise<number>` (process entry `node dist/capture/cdp/broker.js '<json>'`; prints `ready` on stdout once listening AND connected upstream, or one JSON error line on stderr and exit 1, same contract as the worker).
  - `brokerUrl(info: BrokerInfo): string` = `ws://127.0.0.1:<port>/<token>`.
  - `ensureBroker(upstream: string, deps?): Promise<{ wsUrl: string; started: boolean }>`: reuse a live broker for the same upstream (liveness: pid alive AND command line contains `capture/cdp/broker.`, as `isRecorderAlive`), else spawn one detached, wait for `ready` (20 s, longer than the 15 s connect timeout), and return its URL.
  - `stopBroker(): Promise<boolean>`, `brokerStatus(): BrokerInfo | null`.
  - `resolveEndpoint` source `'chrome'` now returns the broker URL (`source: 'broker'`); `'flag'` and `'env'` are unchanged and never use the broker.

**Proxy rules (each one gets a unit test against a fake upstream):**
1. Only clients presenting the exact path token are accepted; any other path is closed with code 1008. The server binds `127.0.0.1` only.
2. Client request ids are remapped to unique upstream ids; the response goes back to that client with its original id.
3. A response or event carrying a `sessionId` goes only to the client that created that session (learned from the `Target.attachToTarget` / `Target.attachedToTarget` reply carrying `sessionId`).
4. Events without `sessionId` (browser-level, e.g. `Target.targetCreated`) go to every client that called `Target.setDiscoverTargets`.
5. When a client disconnects, the broker sends `Target.detachFromTarget` for each session that client owned, and stops forwarding its traffic.
6. When the upstream closes, every client is closed (code 1001) and the broker exits 0 after removing its info file.
7. Idle exit: no client for `idleMs` (default 30 min, `SCREENREC_BROKER_IDLE` in ms) exits 0 and removes the info file.
8. Two workers through one broker can record two different tabs at once without seeing each other's frames.

**Steps:**
- [ ] Unit tests for rules 1 to 8 with an in-process fake upstream (Node `WebSocketServer` is not built in: implement the fake and the broker server with the `node:http` upgrade event and a minimal RFC 6455 frame codec in `src/capture/cdp/ws-server.ts`, text frames only, masking handled, ping/pong and close handled; no new runtime dependency). Run, see them fail.
- [ ] Implement `ws-server.ts`, then `broker.ts`. Run, see them pass.
- [ ] `broker-client.ts` with `ensureBroker`, `stopBroker`, `brokerStatus`; unit tests with injected spawn and a fake info file (stale pid, foreign pid reuse, different upstream).
- [ ] `endpoint.ts`: endpoint 2 goes through `ensureBroker`. Update its unit tests.
- [ ] `chrome-broker` command and `doctor` line. CLI unit tests.
- [ ] Chrome for Testing test (headless): start a broker on CfT, run two workers through it sequentially and then concurrently on two background tabs; both produce playable files with live colours; kill CfT and assert the broker exits and removes its info file.
- [ ] Commit per step, `feat(chrome): ...`.

**Real-machine check (coordinator, with the user):** two `screenrec start --tab newest` / `stop` cycles against the user's Chrome produce exactly one Allow dialog.

---

### Task 27: Chrome DevTools MCP route (spread over three hires)

1. **video-edit:** a video test that feeds an AV1, variable-frame-rate `.mp4` (generate with `-c:v libaom-av1` or `libsvtav1` if this ffmpeg has one; skip with a reason if neither encoder exists) through squeeze, crop, trim, blur and gif and asserts H.264 output with a sane duration.
2. **api-core (doctor):** `doctor` looks for a `chrome-devtools-mcp` server entry in the MCP configuration files it can read (`~/.claude.json` `mcpServers`, `./.mcp.json`, `~/.codex/config.toml` `[mcp_servers.*]`), reports "Chrome DevTools MCP route: available (autoConnect on|off)" or "not configured", and warns when `--no-usage-statistics` is missing. Read-only; unit tests with fixture files.
3. **mcp-agents (Tasks 20-21):** the skill and `AGENTS.snippet.md` describe both routes as in spec 6.6, including the flags to add, the "sees every tab" warning, and the missing follow mode, step notes and auto-stop.

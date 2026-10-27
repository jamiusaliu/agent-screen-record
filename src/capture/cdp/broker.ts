// Chrome broker: holds the one upstream CDP connection to the user's Chrome (endpoint 2,
// which shows an Allow dialog per connection) and serves it to screenrec's workers.
// Workers connect to ws://127.0.0.1:<port>/<token> exactly as they would to Chrome.
// Message contents are never logged: pages contain private data.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWsServer, type WsConnection, type WsServer } from './ws-server.ts';
import { assertLoopback, redactUrl } from './endpoint.ts';
import { ScreenrecError, errorJson } from '../../core/errors.ts';
import { readJsonLine } from '../stdin-line.ts';

export interface BrokerInfo { pid: number; port: number; token: string; upstream: string; startedAt: number; idleMs?: number }
export interface BrokerOptions { upstream: string; idleMs: number; infoPath: string }
export interface BrokerIo {
  out: (s: string) => void; err: (s: string) => void;
  /** Test seam: runs after the upstream connects and before the server listens. */
  beforeListen?: () => Promise<void>;
}

export const DEFAULT_BROKER_IDLE_MS = 30 * 60 * 1000;
/** How long to wait for the user to click Allow in Chrome (measured clicks took 18.6 s, 20 s and 46.7 s). */
export function allowTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SCREENREC_ALLOW_TIMEOUT);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}
const HOST_RE = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/;
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1', 'http://localhost']);
// Events that name a session in params rather than at the top level.
const SESSION_EVENTS = new Set(['Target.attachedToTarget', 'Target.detachedFromTarget', 'Target.receivedMessageFromTarget']);
// The broker skips Chrome's per-connection Allow dialog, so a token holder (any process of this user,
// or an agent with a shell) must not get the whole browser. Forward only what screenrec itself sends
// (worker.ts, tabs-list.ts, screenshot.ts): no navigation, input, cookies, network or arbitrary JS.
const ALLOWED_METHODS = new Set([
  'Target.getTargets', 'Target.setDiscoverTargets', 'Target.attachToTarget', 'Target.detachFromTarget',
  'Page.enable', 'Page.getLayoutMetrics', 'Page.startScreencast', 'Page.screencastFrameAck', 'Page.stopScreencast', 'Page.captureScreenshot',
  'Emulation.setFocusEmulationEnabled', 'Runtime.evaluate',
]);
// The only two expressions the worker evaluates; anything else could read the page (document.cookie).
const ALLOWED_EXPRESSIONS = new Set(['devicePixelRatio', 'document.visibilityState']);

export function brokerAllows(method: string, params: unknown): boolean {
  if (!ALLOWED_METHODS.has(method)) return false;
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  // flat sessions only: a non-flat one is driven through Target.sendMessageToTarget, which is not allowed
  if (method === 'Target.attachToTarget') return p.flatten === true;
  if (method === 'Runtime.evaluate') {
    return typeof p.expression === 'string' && ALLOWED_EXPRESSIONS.has(p.expression) && Object.keys(p).every((k) => k === 'expression' || k === 'returnByValue');
  }
  return true;
}
const UNCLAIMED_TTL_MS = 10000;
const UNCLAIMED_MAX = 64;

export function brokerUrl(info: BrokerInfo): string { return `ws://127.0.0.1:${info.port}/${info.token}`; }

const defaultIo: BrokerIo = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

/** Constant-time comparison of the request path with "/<token>". */
function tokenMatches(reqPath: string | undefined, token: string): boolean {
  const a = crypto.createHash('sha256').update(reqPath ?? '').digest();
  const b = crypto.createHash('sha256').update(`/${token}`).digest();
  return crypto.timingSafeEqual(a, b);
}

function writeInfo(infoPath: string, info: BrokerInfo): void {
  const dir = path.dirname(infoPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${infoPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, infoPath);
}

/** Remove the info file only while it still describes this broker (a newer one may have replaced it). */
function removeInfo(infoPath: string, token: string): void {
  try {
    if ((JSON.parse(fs.readFileSync(infoPath, 'utf8')) as BrokerInfo).token === token) fs.rmSync(infoPath, { force: true });
  } catch { /* already gone or unreadable */ }
}

function connectUpstream(url: string, timeoutMs: number): Promise<WebSocket> {
  assertLoopback(url);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const fail = (e: ScreenrecError) => { clearTimeout(timer); ws.onopen = ws.onerror = ws.onclose = null; try { ws.close(); } catch { /* ignore */ } reject(e); };
    const timer = setTimeout(() => fail(new ScreenrecError('E_CDP_UNAVAILABLE', `Timed out connecting to ${redactUrl(url)}`,
      "Click Allow in Chrome's remote-debugging dialog (chrome://inspect/#remote-debugging), then retry.")), timeoutMs);
    ws.onopen = () => { clearTimeout(timer); ws.onopen = ws.onerror = ws.onclose = null; resolve(ws); };
    ws.onerror = ws.onclose = () => fail(new ScreenrecError('E_CDP_UNAVAILABLE', `Could not connect to ${redactUrl(url)}`,
      'Chrome may have closed, or you declined its permission dialog. Re-enable chrome://inspect/#remote-debugging and retry.'));
  });
}

type Msg = { id?: unknown; method?: unknown; params?: any; sessionId?: unknown; result?: any; error?: any };
interface Client { n: number; conn: WsConnection; sessions: Set<string>; discover: boolean }
interface Pending { client: Client | null; origId: unknown; method: string; onReply?: (m: Msg) => void }

export async function runBroker(o: BrokerOptions, io: BrokerIo = defaultIo): Promise<number> {
  const debug = process.env.SCREENREC_DEBUG === '1';
  const trace = (s: string) => { if (debug) io.err(`[broker ${new Date().toISOString()}] ${s}\n`); };

  const upstream = await connectUpstream(o.upstream, allowTimeoutMs());
  trace('upstream connected');
  const token = crypto.randomBytes(32).toString('hex');

  const clients = new Set<Client>();
  const owner = new Map<string, Client>();
  const pending = new Map<number, Pending>();
  // Session traffic that arrives before the reply that tells us who owns the session
  // (Chrome sends Target.attachedToTarget before the Target.attachToTarget reply).
  const unclaimed = new Map<string, { at: number; msgs: string[] }>();
  let nextId = 0; let nextClient = 0;
  let upstreamDiscover = false;
  let idle: NodeJS.Timeout | null = null;
  let ended = false;
  let server: WsServer | null = null;
  let finish!: (code: number) => void;
  const done = new Promise<number>((r) => { finish = r; });

  const sendUp = (m: object) => { if (upstream.readyState === 1) upstream.send(JSON.stringify(m)); };
  const internal = (method: string, params: object, onReply?: (m: Msg) => void) => {
    const id = ++nextId;
    pending.set(id, { client: null, origId: null, method, onReply });
    trace(`-> ${method} broker:${id}`);
    sendUp({ id, method, params });
  };
  const toClient = (c: Client, m: object | string) => c.conn.send(typeof m === 'string' ? m : JSON.stringify(m));

  function claim(c: Client, sessionId: string): void {
    owner.set(sessionId, c); c.sessions.add(sessionId);
    const buffered = unclaimed.get(sessionId);
    unclaimed.delete(sessionId);
    for (const raw of buffered?.msgs ?? []) toClient(c, raw);
  }
  function release(sessionId: string): void {
    const c = owner.get(sessionId);
    owner.delete(sessionId); c?.sessions.delete(sessionId); unclaimed.delete(sessionId);
  }
  function buffer(sessionId: string, raw: string): void {
    const now = Date.now();
    for (const [k, v] of unclaimed) if (now - v.at > UNCLAIMED_TTL_MS) unclaimed.delete(k);
    let e = unclaimed.get(sessionId);
    if (!e) { if (unclaimed.size >= UNCLAIMED_MAX) return; e = { at: now, msgs: [] }; unclaimed.set(sessionId, e); }
    if (e.msgs.length < UNCLAIMED_MAX) e.msgs.push(raw);
  }
  function maybeStopDiscover(): void {
    if (upstreamDiscover && ![...clients].some((c) => c.discover)) {
      upstreamDiscover = false;
      internal('Target.setDiscoverTargets', { discover: false });
    }
  }
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => void shutdown(0, 'idle'), o.idleMs);
  };

  upstream.onmessage = (e: MessageEvent) => {
    const raw = String(e.data);
    let m: Msg;
    try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.id === 'number') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      trace(`<- reply ${p.client ? `${p.client.n}:${String(p.origId)}` : 'broker'}:${m.id} ${p.method}${m.error ? ' error' : ''}`);
      p.onReply?.(m);
      if (!p.client) return;
      const sid = m.error ? undefined : m.result?.sessionId;
      if (!clients.has(p.client)) {
        // the client left while its attach was in flight: do not leak the session
        if (typeof sid === 'string') internal('Target.detachFromTarget', { sessionId: sid });
        return;
      }
      if (typeof sid === 'string') claim(p.client, sid);
      m.id = p.origId;
      toClient(p.client, m);
      return;
    }
    if (typeof m.method !== 'string') return;
    const paramSid = SESSION_EVENTS.has(m.method) && typeof m.params?.sessionId === 'string' ? m.params.sessionId as string : undefined;
    const sid = typeof m.sessionId === 'string' ? m.sessionId : paramSid;
    if (sid !== undefined) {
      const c = owner.get(sid);
      if (debug && m.method !== 'Page.screencastFrame') trace(`<- event ${m.method} ${c ? `client ${c.n}` : 'unclaimed'}`);
      if (c) toClient(c, raw); else if (m.method !== 'Target.detachedFromTarget') buffer(sid, raw);
      if (m.method === 'Target.detachedFromTarget' && paramSid) release(paramSid);
      return;
    }
    trace(`<- event ${m.method} broadcast`);
    for (const c of clients) if (c.discover) toClient(c, raw);
  };
  let listening = false; let lostEarly = false;
  upstream.onclose = () => {
    trace('upstream closed');
    if (!listening) { lostEarly = true; return; }  // still starting: fail the start instead of printing ready
    void shutdown(0, 'Chrome closed the connection');
  };
  upstream.onerror = () => {};

  function handleDiscover(c: Client, m: Msg): void {
    const reply = (result: object) => toClient(c, { id: m.id, result });
    if (!m.params?.discover) { c.discover = false; reply({}); maybeStopDiscover(); return; }
    if (c.discover) { reply({}); return; }
    if (!upstreamDiscover) {
      // first client: Chrome itself sends targetCreated for every existing target, then the reply
      upstreamDiscover = true; c.discover = true;
      const id = ++nextId;
      pending.set(id, { client: c, origId: m.id, method: 'Target.setDiscoverTargets', onReply: (r) => {
        if (r.error) { c.discover = false; upstreamDiscover = [...clients].some((x) => x.discover); }
      } });
      trace(`-> Target.setDiscoverTargets ${c.n}:${String(m.id)}->${id}`);
      sendUp({ ...m, id });
      return;
    }
    // discovery already on upstream: replay the existing targets to this client, as Chrome would
    internal('Target.getTargets', {}, (r) => {
      if (!clients.has(c)) return;
      if (r.error) { toClient(c, { id: m.id, error: r.error }); return; }
      for (const t of r.result?.targetInfos ?? []) toClient(c, { method: 'Target.targetCreated', params: { targetInfo: t } });
      c.discover = true;
      reply({});
    });
  }

  function onClientMessage(c: Client, raw: string): void {
    let m: Msg;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.id !== 'number' || typeof m.method !== 'string') {
      if (m && typeof m.id === 'number') toClient(c, { id: m.id, error: { code: -32600, message: 'Invalid request' } });
      return;
    }
    if (!brokerAllows(m.method, m.params)) {
      trace(`refused a ${/^[A-Za-z]+\.[A-Za-z]+$/.test(m.method) ? m.method : 'malformed'} call from client ${c.n}`);
      toClient(c, { id: m.id, error: { code: -32601, message: `${m.method.slice(0, 80)} is not allowed through the screenrec broker` },
        ...(m.sessionId !== undefined ? { sessionId: m.sessionId } : {}) });
      return;
    }
    const foreign = (s: unknown) => typeof s === 'string' && owner.get(s) !== c;
    // a client may only drive its own sessions
    if (m.sessionId !== undefined && foreign(m.sessionId)
      || m.method.startsWith('Target.') && typeof m.params?.sessionId === 'string' && foreign(m.params.sessionId)) {
      toClient(c, { id: m.id, error: { code: -32001, message: 'Session with given id not found.' }, ...(m.sessionId !== undefined ? { sessionId: m.sessionId } : {}) });
      return;
    }
    // by targetId these would reach a session the client does not own
    if ((m.method === 'Target.detachFromTarget' || m.method === 'Target.sendMessageToTarget') && typeof m.params?.sessionId !== 'string') {
      toClient(c, { id: m.id, error: { code: -32602, message: 'The broker needs a sessionId the client attached; targetId alone is not accepted.' } });
      return;
    }
    if (m.method === 'Target.setDiscoverTargets' && m.sessionId === undefined) { handleDiscover(c, m); return; }
    const id = ++nextId;
    pending.set(id, { client: c, origId: m.id, method: m.method });
    if (debug && m.method !== 'Page.screencastFrameAck') trace(`-> ${m.method} ${c.n}:${m.id}->${id}`);
    sendUp({ ...m, id });
  }

  function onClientClose(c: Client): void {
    if (!clients.delete(c)) return;
    trace(`client ${c.n} disconnected (${clients.size} left)`);
    for (const sid of c.sessions) { owner.delete(sid); internal('Target.detachFromTarget', { sessionId: sid }); }
    c.sessions.clear();
    maybeStopDiscover();
    if (clients.size === 0 && !ended) armIdle();
  }

  async function shutdown(code: number, why: string): Promise<void> {
    if (ended) return;
    ended = true;
    trace(`shutdown: ${why}`);
    if (idle) clearTimeout(idle);
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    for (const c of [...clients]) c.conn.close(1001, 'broker exiting');
    clients.clear();
    try { upstream.close(); } catch { /* ignore */ }
    removeInfo(o.infoPath, token);
    await server?.close(500).catch(() => {});
    finish(code);
  }
  const onSignal = () => void shutdown(0, 'signal');

  try {
    await io.beforeListen?.();
    server = await createWsServer({
      port: 0,  // createWsServer always binds 127.0.0.1
      verify: (req) => {
        // DNS rebinding: a page whose host name resolves to 127.0.0.1 still sends its own Host
        if (!HOST_RE.test(req.headers.host ?? '')) return 403;
        const origin = req.headers.origin;
        // a web page in the user's browser must not reach the broker
        return origin === undefined || ALLOWED_ORIGINS.has(origin) ? null : 403;
      },
      onConnection: (conn, req) => {
        if (ended || !tokenMatches(req.url, token)) { trace('refused a client with a wrong path'); conn.close(1008, 'forbidden'); return; }
        const c: Client = { n: ++nextClient, conn, sessions: new Set(), discover: false };
        clients.add(c);
        if (idle) { clearTimeout(idle); idle = null; }
        trace(`client ${c.n} connected (${clients.size})`);
        conn.onMessage((raw) => onClientMessage(c, raw));
        conn.onClose(() => onClientClose(c));
      },
    });
    if (lostEarly || upstream.readyState !== 1) {
      throw new ScreenrecError('E_CDP_UNAVAILABLE', 'Chrome closed the connection while the broker was starting',
        'Check that Chrome is still running with chrome://inspect/#remote-debugging enabled, then retry.');
    }
    writeInfo(o.infoPath, { pid: process.pid, port: server.port, token, upstream: o.upstream, startedAt: Date.now(), idleMs: o.idleMs });
    listening = true;
  } catch (e) {
    ended = true;
    try { upstream.close(); } catch { /* ignore */ }
    await server?.close().catch(() => {});
    throw e;
  }
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  armIdle();
  trace(`listening on 127.0.0.1:${server.port}`);
  io.out('ready\n');
  return done;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  // the parent closes our pipes once it has seen "ready"; later writes must not crash the broker
  process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
  // config on stdin, never argv: ps would show Chrome's browser id to every local user
  readJsonLine<BrokerOptions>(process.stdin).then((cfg) => runBroker(cfg)).then((code) => process.exit(code), (e) => {
    // one JSON line so the caller can show the fix text
    process.stderr.write(JSON.stringify(errorJson(e)) + '\n'); process.exit(1);
  });
}

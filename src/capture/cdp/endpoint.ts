import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { ScreenrecError } from '../../core/errors.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ENABLE_FIX = 'In Chrome 144+, open chrome://inspect/#remote-debugging and enable it, or start a test browser and pass --cdp http://127.0.0.1:<port>.';

/** scheme://host:port/<redacted>: the path of a broker URL is its secret token, and Chrome's holds the browser id. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== '/' ? '/<redacted>' : ''}`;
  } catch { return '<redacted url>'; }
}

export function assertLoopback(url: string): void {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* handled below */ }
  if (!LOOPBACK.has(host)) {
    throw new ScreenrecError('E_CDP_UNAVAILABLE', `Refusing CDP endpoint "${redactUrl(url)}": only loopback hosts are allowed`, 'Use 127.0.0.1 or localhost; screenrec never connects to other machines.');
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
  const r = await fetch(url, { redirect: 'error' }); // loopback only, asserted above; a redirect could leave loopback
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
    throw new ScreenrecError('E_CDP_UNAVAILABLE', `No browser answered at ${redactUrl(url)}`, ENABLE_FIX);
  }
}

type EnsureBroker = (upstream: string, o?: { onWaiting?: () => void }) => Promise<{ wsUrl: string; started: boolean }>;
// imported lazily: broker-client spawns broker.ts, which itself imports this module
const defaultEnsureBroker: EnsureBroker = async (upstream, o) => (await import('./broker-client.ts')).ensureBroker(upstream, { onWaiting: o?.onWaiting });

export async function resolveEndpoint(o: { cdp?: string; env?: NodeJS.ProcessEnv; dirs?: string[]; fetchJson?: (url: string) => Promise<any>; ensureBroker?: EnsureBroker;
  /** Discovery only: read DevToolsActivePort / the flag / the env and return, never connecting, fetching or
   *  starting the broker (doctor must never trigger Chrome's Allow dialog). */
  probeOnly?: boolean;
  /** Called once if starting the broker takes long, which usually means Chrome's Allow dialog is up. */
  onWaiting?: () => void }) {
  const fetchJson = o.fetchJson ?? defaultFetchJson;
  const env = o.env ?? process.env;
  // endpoint 1: a browser started for debugging; no permission dialog, so no broker
  if (o.cdp) { assertLoopback(o.cdp); return { wsUrl: o.probeOnly ? o.cdp : await toWs(o.cdp, fetchJson), source: 'flag' as const }; }
  if (env.SCREENREC_CDP) { assertLoopback(env.SCREENREC_CDP); return { wsUrl: o.probeOnly ? env.SCREENREC_CDP : await toWs(env.SCREENREC_CDP, fetchJson), source: 'env' as const }; }
  // endpoint 2: the user's Chrome asks Allow on every connection, so share one through the broker (spec 6.6)
  for (const dir of o.dirs ?? chromeUserDataDirs()) {
    const p = readDevToolsActivePort(dir);
    if (p) {
      const upstream = `ws://127.0.0.1:${p.port}${p.path}`;
      if (o.probeOnly) return { wsUrl: upstream, source: 'chrome' as const };
      return { wsUrl: (await (o.ensureBroker ?? defaultEnsureBroker)(upstream, { onWaiting: o.onWaiting })).wsUrl, source: 'broker' as const };
    }
  }
  throw new ScreenrecError('E_CDP_UNAVAILABLE', 'No Chrome with remote debugging was found', ENABLE_FIX);
}

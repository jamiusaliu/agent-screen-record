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
  const fix = 'Use --window "App", "App:title" or a window id.';
  if (s.trim() === '') throw bad('Empty window selector', fix);
  if (/^\d+$/.test(s.trim())) return { id: Number(s.trim()) };
  const i = s.indexOf(':');
  if (i === -1) return { app: s };
  const app = s.slice(0, i), title = s.slice(i + 1);
  if (app.trim() === '' || title.trim() === '') throw bad(`Bad window selector "${s}"`, fix);
  return { app, title };
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
  const parts = s.split(',').map((v) => v.trim());
  const n = parts.map(Number);
  if (parts.length !== 4 || parts.some((v) => v === '') || n.some((v) => !Number.isFinite(v)) || n[2] <= 0 || n[3] <= 0) {
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
  // A flag that does not apply would be dropped silently and an agent would believe it took effect.
  const windowish = o.window !== undefined || o.app !== undefined;
  if (followApp && !windowish) throw bad('--follow-app needs --window or --app', 'Drop --follow-app, or record a --window or --app.');
  if (ignoreApps.length > 0 && !followApp) throw bad('--ignore-app only works with --follow-app', 'Add --follow-app (with --window or --app), or drop --ignore-app.');
  if (o.cdp !== undefined && o.tab === undefined) throw bad('--cdp only works with --tab', 'Drop --cdp, or record a --tab.');
  if (o.window !== undefined) return { kind: 'window', ...parseWindowSelector(o.window), followApp, ignoreApps };
  if (o.app !== undefined) return { kind: 'app', app: o.app, followApp, ignoreApps };
  if (o['display-of'] !== undefined) return { kind: 'display-of', window: o['display-of'] };
  if (o.region !== undefined) return { kind: 'region', region: parseRegion(o.region), display: o.display ?? 'main' };
  if (o.tab !== undefined) return parseTab(o.tab, o.cdp);
  return { kind: 'display', display: o.display! };
}

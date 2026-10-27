import fs from 'node:fs';
import type { Target } from './targets.ts';

export interface Mark { t: number; text: string }
export interface Sidecar { version: 1; target: Target; startedAt: string; durationSec: number; marks: Mark[] }

export function appendMark(marksFile: string, mark: Mark): void {
  fs.appendFileSync(marksFile, JSON.stringify(mark) + '\n');
}

export function readMarks(marksFile: string): Mark[] {
  if (!fs.existsSync(marksFile)) return [];
  const marks: Mark[] = [];
  for (const line of fs.readFileSync(marksFile, 'utf8').split('\n')) {
    if (!line) continue;
    try { marks.push(JSON.parse(line) as Mark); } catch { /* torn line from a killed worker */ }
  }
  return marks;
}

export function writeSidecar(path: string, s: Sidecar): void { fs.writeFileSync(path, JSON.stringify(s, null, 2) + '\n'); }

/**
 * Reads a screenrec sidecar. Anything else with the same name (another tool's JSON, a broken file) is
 * treated as no sidecar. Only the sidecar's own fields and well-formed marks are returned, so a later
 * write never copies foreign fields.
 */
export function readSidecar(path: string): Sidecar | null {
  let v: unknown;
  try { v = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.marks)) return null;
  const marks = o.marks.filter((m): m is Mark => typeof m === 'object' && m !== null
    && typeof (m as Mark).t === 'number' && Number.isFinite((m as Mark).t) && typeof (m as Mark).text === 'string')
    .map((m) => ({ t: m.t, text: m.text }));
  return { version: 1, target: o.target as Target, startedAt: o.startedAt as string, durationSec: o.durationSec as number, marks };
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

import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { runFfmpeg, probe, filterFileFlag, ENCODE, MPDECIMATE } from './ffmpeg.ts';
import { derivedOut, stripExt } from '../core/paths.ts';
import { readSidecar, retimeMarks } from '../core/sidecar.ts';
import { assertNotInput, assertOutFolder, assertOutFree, assertForceHasOut, localPath, writeOut } from './output.ts';
import { ScreenrecError } from '../core/errors.ts';
import type { Mark } from '../core/sidecar.ts';

export function squeezeArgs(input: string, output: string, fps: number): string[] {
  return ['-v', 'error', '-y', '-i', input, '-vf', `${MPDECIMATE},setpts=N/${fps}/TB`, '-r', String(fps), '-an', ...ENCODE, output];
}

export function parseShowinfoPts(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
}

/** A stretch of the source that is cut out. `to` is Infinity for the tail of the recording. */
export interface Cut { from: number; to: number }

const r4 = (n: number) => Math.round(n * 10000) / 10000;
// Kept-frame times print with 6 digits; stop the cut a hair before the next change so rounding never eats it.
const EDGE = 0.0005;

/** Cuts that leave at most `hold` seconds of every still stretch (kept[i] .. kept[i+1]) and of the tail. */
export function holdCuts(kept: number[], hold: number, end: number): Cut[] {
  const k = [...kept].sort((a, b) => a - b);
  const cuts: Cut[] = [];
  k.forEach((t, i) => {
    const from = r4(t + hold);
    const to = i + 1 < k.length ? r4(k[i + 1] - EDGE) : Infinity;
    if (i + 1 < k.length ? to > from : end > from + EDGE) cuts.push({ from, to });
  });
  return cuts;
}

/** Map mark times through the cuts; a mark inside a cut lands at the end of the kept part before it. */
export function retimeWithCuts(marks: Mark[], cuts: Cut[]): Mark[] {
  return marks.map((m) => {
    let removed = 0;
    for (const c of cuts) removed += Math.min(Math.max(m.t - c.from, 0), c.to - c.from);
    return { ...m, t: Math.round((m.t - removed) * 1000) / 1000 };
  });
}

// ffmpeg's expression parser recurses once per nesting level and stops at about 100, so a flat a+b+c+... over
// hundreds of cuts fails. A balanced tree of parentheses is only about log2(n) deep.
function sumExpr(terms: string[], top = true): string {
  if (terms.length === 1) return terms[0];
  const mid = terms.length >> 1;
  const body = `${sumExpr(terms.slice(0, mid), false)}+${sumExpr(terms.slice(mid), false)}`;
  return top ? body : `(${body})`;
}

/** Filter chain: drop frames inside the cuts, then close the gaps so kept frames keep their own spacing. */
export function holdFilter(cuts: Cut[]): string {
  if (cuts.length === 0) return "setpts='PTS'";
  const sel = sumExpr(cuts.map((c) => (c.to === Infinity ? `gte(t,${c.from})` : `gte(t,${c.from})*lt(t,${c.to})`)));
  const shifts = cuts.filter((c) => c.to !== Infinity).map((c) => `gte(T,${c.to})*${r4(c.to - c.from)}`);
  return `select='not(${sel})',setpts='${shifts.length ? `PTS-(${sumExpr(shifts)})/TB` : 'PTS'}'`;
}

/** Graphs shorter than this go in one argv entry (no shell, so no quoting issue). Linux caps one argument at 128 KiB. */
export const INLINE_FILTER_LIMIT = 100_000;

export type FilterSource = { vf: string } | { file: string; flag: '-/filter:v' | '-filter_script:v' };

export function holdArgs(input: string, output: string, fps: number, filter: FilterSource): string[] {
  const f = 'vf' in filter ? ['-vf', filter.vf] : [filter.flag, filter.file];
  return ['-v', 'error', '-y', '-i', input, ...f, '-fps_mode', 'cfr', '-r', String(fps), '-an', ...ENCODE, output];
}

export async function squeeze(input: string, opts: { out?: string; force?: boolean; fps?: number; hold?: number; inlineLimit?: number } = {}) {
  const fps = opts.fps ?? 30;
  const hold = opts.hold ?? 0.5;
  if (!Number.isFinite(hold) || hold < 0) {
    throw new ScreenrecError('E_BAD_ARGS', `--hold must be a number of seconds >= 0, got "${String(opts.hold)}"`, 'Example: --hold 0.5 (0 keeps one frame per still stretch).');
  }
  assertForceHasOut(opts.force, opts.out);
  input = localPath(input);
  const out = localPath(opts.out ?? derivedOut(input, 'squeeze', 'mp4'));
  assertNotInput(input, out, { sidecar: true });
  assertOutFolder(out);
  const sc = readSidecar(`${stripExt(input)}.json`);
  if (opts.out) assertOutFree(out, { force: opts.force, sidecar: sc !== null });
  const beforeSec = (await probe(input)).duration;
  // Encode and check a temp file; the real out (and sidecar) only change once that has worked.
  const w = await writeOut<{ afterSec: number; marks: Mark[] | undefined }>(out, { force: opts.force, explicit: opts.out !== undefined,
    sidecar: (v) => (sc && v.marks ? { ...sc, durationSec: v.afterSec, marks: v.marks } : undefined) }, async (tmp) => {
    let marks: Mark[] | undefined;
    if (hold === 0) {
      await runFfmpeg(squeezeArgs(input, tmp, fps));
      if (sc) {
        const kept = parseShowinfoPts(await runFfmpeg(['-v', 'info', '-i', input, '-vf', `${MPDECIMATE},showinfo`, '-f', 'null', '-']));
        marks = retimeMarks(sc.marks, kept, fps);
      }
    } else {
      const kept = parseShowinfoPts(await runFfmpeg(['-v', 'info', '-i', input, '-vf', `${MPDECIMATE},showinfo`, '-f', 'null', '-']));
      const cuts = holdCuts(kept, hold, beforeSec);
      const filter = holdFilter(cuts);
      if (filter.length <= (opts.inlineLimit ?? INLINE_FILTER_LIMIT)) {
        await runFfmpeg(holdArgs(input, tmp, fps, { vf: filter }));
      } else {
        const flag = await filterFileFlag();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squeeze-'));
        try {
          const file = path.join(dir, 'filter.txt');
          fs.writeFileSync(file, filter);
          await runFfmpeg(holdArgs(input, tmp, fps, { file, flag }));
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
      if (sc) marks = retimeWithCuts(sc.marks, cuts);
    }
    return { afterSec: (await probe(tmp)).duration, marks };
  });
  return { out: w.out, beforeSec, afterSec: w.value.afterSec, sidecar: w.sidecar };
}

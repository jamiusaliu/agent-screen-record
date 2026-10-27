// Helpers for the real-machine matrix (Task 23). Takes over the real screen: run only when announced.
// Only windows this harness creates are moved, resized or closed: TextEdit documents opened from
// uniquely named RTF fixtures in a temp dir, one Finder window on that temp dir, and the Preview
// window that shows the generated fixture image.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import readline from 'node:readline/promises';
import { parseBounds } from './verdict.mjs';
const exec = promisify(execFile);

export const bin = path.resolve('bin/screenrec');
export const today = new Date().toISOString().slice(0, 10);
export const evidenceDir = path.resolve('recordings', `matrix-${today}`);
fs.mkdirSync(evidenceDir, { recursive: true });
export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-'));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const osa = (...lines) => execFileSync('osascript', lines.flatMap((l) => ['-e', l]), { encoding: 'utf8' }).trim();

/** Runs a screenrec command with --json and returns the parsed result; throws on ok:false. */
export function sr(...args) {
  const r = srRaw(...args);
  if (!r.ok) throw new Error(`${args.join(' ')}: ${r.code} ${r.message}`);
  return r;
}
/** Like sr, but returns ok:false results instead of throwing. */
export function srRaw(...args) {
  let out;
  try { out = execFileSync(bin, [...args, '--json'], { encoding: 'utf8' }); }
  catch (e) { out = String(e.stdout ?? ''); if (!out.trim()) throw e; }
  return JSON.parse(out.trim().split('\n').at(-1));
}
export const pageUrl = (q = '') => `file://${path.resolve('test/fixtures/colour-page.html')}${q}`;
export const out = (name) => path.join(evidenceDir, `${name}.mp4`);

export function probe(file) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim().split(',').map(Number);
  return { width: w, height: h };
}

/** Distinct coarse colour buckets of a 4x4 patch (the frame centre, or centred on cx,cy in pixels) every 0.25 s. */
export async function centreColours(file, seconds, from = 0, at) {
  const seen = new Set();
  const crop = at ? `crop=4:4:${Math.round(at.cx) - 2}:${Math.round(at.cy) - 2}` : 'crop=4:4:(iw-4)/2:(ih-4)/2';
  for (let t = from + 0.25; t < from + seconds; t += 0.25) {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1',
      '-vf', `${crop},scale=1:1,format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer' });
    if (stdout.length >= 3) seen.add([stdout[0], stdout[1], stdout[2]].map((v) => Math.round(v / 64)).join(','));
  }
  return seen.size;
}

export async function grayDiff(file, t1, t2, crop) {
  const grab = async (t) => (await exec('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `${crop ? `crop=${crop},` : ''}scale=160:-2,format=gray`, '-f', 'rawvideo', '-'], { encoding: 'buffer' })).stdout;
  const a = await grab(t1), b = await grab(t2);
  let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.abs(a[i] - b[i]); return s / a.length;
}

/** Saves one 640-wide frame next to the recordings. Returns the file name. */
export async function evidence(file, name, at) {
  const f = `${name}-${Number(at).toFixed(1)}s.png`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', path.join(evidenceDir, f)]);
  return f;
}

export async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/n] `)).trim().toLowerCase(); rl.close(); return a.startsWith('y');
}

// TextEdit fixtures: an RTF of big solid blocks whose colour the harness cycles, so a live capture
// sees the colour change and a frozen one does not. The window title is the unique file name.
const opened = new Set();
export function openDoc(name, bounds) {
  const file = path.join(tmp, `${name}.rtf`);
  const row = '\\u9608?'.repeat(6);
  fs.writeFileSync(file, `{\\rtf1\\ansi{\\fonttbl\\f0 Menlo;}{\\colortbl;\\red255\\green0\\blue0;}\\f0\\fs400\\cf1 ${`${row}\\par `.repeat(4)}}`);
  execFileSync('open', ['-a', 'TextEdit', file]);
  opened.add(`${name}.rtf`);
  let sized = false, last;
  for (let i = 0; i < 20 && !sized; i++) {
    try { osa(`tell application "TextEdit" to set bounds of window "${name}.rtf" to {${bounds.join(', ')}}`); sized = true; }
    catch (e) { last = e; execFileSync('sleep', ['0.25']); }
  }
  // Report a sizing failure instead of carrying on with a window of unknown size.
  if (!sized) throw new Error(`could not size TextEdit window "${name}.rtf" to {${bounds.join(', ')}}: ${String(last?.message ?? last).trim()}`);
  return `${name}.rtf`;
}
/** Reads back a window's bounds (x1, y1, x2, y2 in global points) from TextEdit or Finder. */
export const windowBounds = (app, title) => parseBounds(osa(`tell application "${app}" to get bounds of window "${title}"`));
export const moveDoc = (doc, bounds) => osa(`tell application "TextEdit" to set bounds of window "${doc}" to {${bounds.join(', ')}}`);
export const raiseDoc = (doc) => osa('tell application "TextEdit" to activate', `tell application "TextEdit" to set index of window "${doc}" to 1`);
export function closeDoc(doc) {
  try { osa(`tell application "TextEdit" to close document "${doc}" saving no`); } catch {}
  opened.delete(doc);
}
export function closeAllDocs() { for (const d of [...opened]) closeDoc(d); }

const COLOURS = [[65535, 0, 0], [0, 65535, 0], [0, 0, 65535], [65535, 65535, 0], [65535, 0, 65535], [0, 65535, 65535]];
/** Cycles the text colour of a TextEdit document until the returned stop() is awaited. */
export function cycleColour(doc, everyMs = 400) {
  let running = true, i = 0;
  const loop = (async () => {
    while (running) {
      const c = COLOURS[i++ % COLOURS.length];
      try { await exec('osascript', ['-e', `tell application "TextEdit" to set color of text of document "${doc}" to {${c.join(', ')}}`]); } catch {}
      await sleep(everyMs);
    }
  })();
  return async () => { running = false; await loop; };
}

/** Rect in points (TextEdit bounds are x1,y1,x2,y2) to its centre in a display capture's pixels. */
export const centreInDisplay = (b, d) => ({ cx: ((b[0] + b[2]) / 2 - d.x) * d.scale, cy: ((b[1] + b[3]) / 2 - d.y) * d.scale });

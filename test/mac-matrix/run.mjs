// Real-machine matrix (Task 23). Takes over the real screen; run only when announced.
// npm run test:mac                 every automatic scenario, then prompts for the manual ones
// npm run test:mac -- --auto-only  automatic scenarios only; manual ones are listed as PENDING
// npm run test:mac -- --only <text> --no-append   rerun matching scenarios without touching docs/TESTED.md
import fs from 'node:fs'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  sr, srRaw, osa, sleep, centreColours, grayDiff, evidence, ask, evidenceDir, tmp, today, out, probe,
  openDoc, moveDoc, raiseDoc, closeDoc, closeAllDocs, cycleColour, centreInDisplay, windowBounds,
} from './lib.mjs';
import { contains, coveredFinderVerdict } from './verdict.mjs';
import { parseFlags, summarise } from './flags.mjs';

let flags;
try { flags = parseFlags(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
const { autoOnly, noAppend, only } = flags;

const results = [];
async function scenario(name, fn) {
  if (only && !name.includes(only)) return;
  process.stdout.write(`\n== ${name}\n`);
  try { const r = await fn(); results.push({ name, ...r }); console.log(r.result, r.note ?? '', r.evidence ?? ''); }
  catch (e) { results.push({ name, result: 'FAIL', note: e.message }); console.log('FAIL', e.message); try { sr('stop'); } catch {} }
  finally { closeAllDocs(); await sleep(300); }
}
const ev = (...files) => files.filter(Boolean).join(', ');

if (sr('status').recording) throw new Error('A recording is already running; stop it first.');
const displays = sr('list', 'displays').displays;
const main = displays.find((d) => d.main);
const ext = displays.find((d) => !d.main);
// A 600x500 pt TextEdit window well inside each display (bounds are x1, y1, x2, y2 in global points).
const boundsOn = (d) => [d.x + 200, d.y + 150, d.x + 800, d.y + 650];
const sides = [['main', main, 'main'], ...(ext ? [['external', ext, String(displays.indexOf(ext) + 1)]] : [])];

// Records `target` for `ms` while the doc's colour cycles; returns the stop result.
async function recordCycling(doc, args, ms = 4000) {
  const stopCycle = cycleColour(doc);
  try { sr('start', ...args); await sleep(ms); return sr('stop'); } finally { await stopCycle(); }
}
const sizeNote = (got, want) => `${got.width}x${got.height}${want ? ` (want ${want.width}x${want.height})` : ''}`;
const sameSize = (got, want) => got.width === want.width && got.height === want.height;

for (const [side, d, sel] of sides) {
  const b = boundsOn(d);
  const px = { width: 600 * d.scale, height: 500 * d.scale };
  const dpx = { width: d.width * d.scale, height: d.height * d.scale };

  await scenario(`window on ${side} display (${d.name})`, async () => {
    const doc = openDoc(`SRM-WIN-${side}`, b); await sleep(800);
    const r = await recordCycling(doc, ['--window', `TextEdit:${doc}`, '--out', out(`window-${side}`), '--force']);
    const n = await centreColours(r.out, r.durationSec - 0.3); const size = probe(r.out);
    return { result: n >= 3 && sameSize(size, px) ? 'PASS' : 'FAIL', note: `${n} colours; ${sizeNote(size, px)}`, evidence: ev(path.basename(r.out), await evidence(r.out, `window-${side}`, 1.5)) };
  });

  await scenario(`app on ${side} display (${d.name})`, async () => {
    const doc = openDoc(`SRM-APP-${side}`, b); raiseDoc(doc); await sleep(800);
    const r = await recordCycling(doc, ['--app', 'TextEdit', '--out', out(`app-${side}`), '--force']);
    const n = await centreColours(r.out, r.durationSec - 0.3); const size = probe(r.out);
    return { result: n >= 3 && sameSize(size, px) ? 'PASS' : 'FAIL', note: `${n} colours; ${sizeNote(size, px)}`, evidence: ev(path.basename(r.out), await evidence(r.out, `app-${side}`, 1.5)) };
  });

  await scenario(`display ${sel} (${d.name})`, async () => {
    const doc = openDoc(`SRM-DISP-${side}`, b); raiseDoc(doc); await sleep(800);
    const r = await recordCycling(doc, ['--display', sel, '--out', out(`display-${side}`), '--force']);
    const n = await centreColours(r.out, r.durationSec - 0.3, 0, centreInDisplay(b, d)); const size = probe(r.out);
    return { result: n >= 3 && sameSize(size, dpx) ? 'PASS' : 'FAIL', note: `${n} colours at the window centre; ${sizeNote(size, dpx)}`, evidence: ev(path.basename(r.out), await evidence(r.out, `display-${side}`, 1.5)) };
  });

  await scenario(`region with odd point size on ${side} display (${d.name})`, async () => {
    const doc = openDoc(`SRM-REG-${side}`, b); raiseDoc(doc); await sleep(800);
    // 333x201 pt over the window; encoded sizes must be even.
    const want = { width: Math.floor((333 * d.scale) / 2) * 2, height: Math.floor((201 * d.scale) / 2) * 2 };
    const r = await recordCycling(doc, ['--region', '320,250,333,201', '--display', sel, '--out', out(`region-${side}`), '--force']);
    const n = await centreColours(r.out, r.durationSec - 0.3); const size = probe(r.out);
    return { result: n >= 3 && sameSize(size, want) ? 'PASS' : 'FAIL', note: `${n} colours; ${sizeNote(size, want)}`, evidence: ev(path.basename(r.out), await evidence(r.out, `region-${side}`, 1.5)) };
  });

  await scenario(`display-of a window on ${side} display (${d.name})`, async () => {
    const doc = openDoc(`SRM-DOF-${side}`, b); raiseDoc(doc); await sleep(800);
    const r = await recordCycling(doc, ['--display-of', `TextEdit:${doc}`, '--out', out(`display-of-${side}`), '--force'], 3000);
    const n = await centreColours(r.out, r.durationSec - 0.3, 0, centreInDisplay(b, d)); const size = probe(r.out);
    return { result: n >= 3 && sameSize(size, dpx) ? 'PASS' : 'FAIL', note: `${n} colours at the window centre; ${sizeNote(size, dpx)}`, evidence: ev(path.basename(r.out), await evidence(r.out, `display-of-${side}`, 1.5)) };
  });
}

await scenario('covered TextEdit window keeps updating', async () => {
  const doc = openDoc('SRM-COVERED', boundsOn(main));
  const cover = openDoc('SRM-COVER', [main.x, main.y + 30, main.x + main.width, main.y + main.height]); raiseDoc(cover); await sleep(800);
  const r = await recordCycling(doc, ['--window', `TextEdit:${doc}`, '--out', out('covered'), '--force']);
  const n = await centreColours(r.out, r.durationSec - 0.3);
  return { result: n >= 3 ? 'PASS' : 'FAIL', note: `${n} colours while covered; evidence must show the coloured window only`, evidence: ev(path.basename(r.out), await evidence(r.out, 'covered', 1.5)) };
});

if (ext) {
  for (const [from, to, label] of [[main, ext, 'main to external'], [ext, main, 'external to main']]) {
    await scenario(`window moved ${label} mid-recording`, async () => {
      const doc = openDoc(`SRM-MOVE-${from.main ? 'm2e' : 'e2m'}`, boundsOn(from)); raiseDoc(doc); await sleep(800);
      const stopCycle = cycleColour(doc); let r;
      try {
        sr('start', '--window', `TextEdit:${doc}`, '--out', out(`moved-${from.main ? 'm2e' : 'e2m'}`), '--force'); await sleep(2500);
        moveDoc(doc, boundsOn(to)); await sleep(3500); r = sr('stop');
      } finally { await stopCycle(); }
      const n = await centreColours(r.out, 2.5, r.durationSec - 2.8);
      // screenrec picks the encoded size at start from the window and its starting display; a move must not change it.
      const size = probe(r.out); const want = { width: 600 * from.scale, height: 500 * from.scale };
      const before = await evidence(r.out, `moved-${from.main ? 'm2e' : 'e2m'}`, 1.0);
      const after = await evidence(r.out, `moved-${from.main ? 'm2e' : 'e2m'}`, Math.max(1.5, r.durationSec - 0.5));
      return { result: n >= 3 && sameSize(size, want) ? 'PASS' : 'FAIL', note: `${n} colours in the last 2.5 s (after the move); ${sizeNote(size, want)}`, evidence: ev(path.basename(r.out), before, after) };
    });
  }
}

await scenario('minimized then restored', async () => {
  const doc = openDoc('SRM-MINI', boundsOn(main)); raiseDoc(doc); await sleep(800);
  const stopCycle = cycleColour(doc); let r, st;
  try {
    sr('start', '--window', `TextEdit:${doc}`, '--out', out('minimized'), '--force'); await sleep(1500);
    osa(`tell application "TextEdit" to set miniaturized of window "${doc}" to true`); await sleep(2500);
    st = sr('status');
    osa(`tell application "TextEdit" to set miniaturized of window "${doc}" to false`); await sleep(3000);
    r = sr('stop');
  } finally { await stopCycle(); }
  const n = await centreColours(r.out, 2, r.durationSec - 2.2);
  return { result: st.recording && n >= 2 ? 'PASS' : 'FAIL', note: `still recording while minimized: ${st.recording}; ${n} colours after restore`, evidence: ev(path.basename(r.out), await evidence(r.out, 'minimized', Math.max(1, r.durationSec - 0.5))) };
});

await scenario('target window closed before stop', async () => {
  const doc = openDoc('SRM-CLOSED', boundsOn(main)); raiseDoc(doc); await sleep(800);
  sr('start', '--window', `TextEdit:${doc}`, '--out', out('closed'), '--force'); await sleep(2000);
  closeDoc(doc); await sleep(1500);
  const r = sr('stop');
  return { result: r.durationSec > 1 ? 'PASS' : 'FAIL', note: `stop finalised ${r.durationSec.toFixed(2)} s, reason ${r.reason}`, evidence: path.basename(r.out) };
});

await scenario('multi-display: region crossing the display edge is refused', async () => {
  const r = srRaw('start', '--region', `${main.width - 100},0,400,200`, '--display', 'main', '--out', out('spans'), '--force');
  if (r.ok) { try { sr('stop'); } catch {} }
  return { result: !r.ok && r.code === 'E_REGION_SPANS_DISPLAYS' ? 'PASS' : 'FAIL', note: r.ok ? 'started a recording' : `${r.code}: ${r.fix}` };
});

if (ext) {
  await scenario('multi-display: display chosen by name records that display only', async () => {
    const name = ext.name.split(' ')[0];
    const doc = openDoc('SRM-NAME', boundsOn(ext)); raiseDoc(doc); await sleep(800);
    const r = await recordCycling(doc, ['--display', name, '--out', out('display-by-name'), '--force'], 3000);
    const size = probe(r.out); const want = { width: ext.width * ext.scale, height: ext.height * ext.scale };
    const n = await centreColours(r.out, r.durationSec - 0.3, 0, centreInDisplay(boundsOn(ext), ext));
    return { result: sameSize(size, want) && n >= 3 ? 'PASS' : 'FAIL', note: `--display ${name}: ${sizeNote(size, want)}, ${n} colours`, evidence: path.basename(r.out) };
  });
}

await scenario('notification: window capture vs display capture', async () => {
  const doc = openDoc('SRM-NOTIFY', boundsOn(main)); raiseDoc(doc); await sleep(800);
  sr('start', '--window', `TextEdit:${doc}`, '--out', out('notify-window'), '--force'); await sleep(1000);
  osa('display notification "SCREENREC TEST" with title "screenrec"'); await sleep(3000);
  const w = sr('stop');
  const dw = await grayDiff(w.out, 0.5, 2.5);
  await sleep(6000); // let the first banner go away
  sr('start', '--display', 'main', '--out', out('notify-display'), '--force'); await sleep(1500);
  osa('display notification "SCREENREC TEST 2" with title "screenrec"'); await sleep(3500);
  const d = sr('stop');
  const crop = 'iw/4:ih/6-ih/30:iw*3/4:ih/30'; // top-right corner where banners appear, below the menu bar (its clock ticks)
  const dd = await grayDiff(d.out, 0.7, Math.min(4.0, d.durationSec - 0.3), crop);
  const frames = [await evidence(d.out, 'notify-display', 0.7), await evidence(d.out, 'notify-display', 2.5), await evidence(d.out, 'notify-display', Math.min(4.0, d.durationSec - 0.3)), await evidence(w.out, 'notify-window', 2.5)];
  // A display capture that shows no banner usually means the banner was never drawn (Focus or notification
  // settings), which proves nothing about exclusion: report it as INCONCLUSIVE, not PASS.
  const result = dw >= 2 ? 'FAIL' : dd > 3 ? 'PASS' : 'INCONCLUSIVE';
  return { result, note: `window diff ${dw.toFixed(2)} (must stay ~0); display top-right diff ${dd.toFixed(2)} (rises if the banner was captured); check the frames by eye`, evidence: ev(path.basename(w.out), path.basename(d.out), ...frames) };
});

// Brief Step 2, first scenario, in a safe form: the harness makes the folder and the Finder window, covers it
// with its own TextEdit fixture, changes the folder with fs (no Finder scripting), and closes both by name.
await scenario('covered Finder window, folder changes while hidden', async () => {
  // under recordings/ (gitignored), like follow-app: Finder may not be allowed to show the system temp folder
  const dir = path.join(process.cwd(), 'recordings', 'SRM-HIDDEN');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a-first.txt'), 'screenrec matrix fixture\n');
  const b = boundsOn(main);
  let r, finderRect, coverRect;
  try {
    // Made inside the try, so the finally closes it even if setting its bounds fails.
    osa(`tell application "Finder" to set bounds of (make new Finder window to (POSIX file "${dir}" as alias)) to {${b.join(', ')}}`); await sleep(1500);
    const cover = openDoc('SRM-FINDER-COVER', [main.x, main.y + 30, main.x + main.width, main.y + main.height]); raiseDoc(cover); await sleep(800);
    // Read both rects back: a window capture never shows other windows, so the frames cannot prove the cover.
    finderRect = windowBounds('Finder', 'SRM-HIDDEN'); coverRect = windowBounds('TextEdit', cover);
    sr('start', '--window', 'Finder:SRM-HIDDEN', '--out', out('finder-covered'), '--force'); await sleep(2500);
    for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(dir, `b-added-${String(i).padStart(2, '0')}.txt`), `file ${i}\n`);
    fs.mkdirSync(path.join(dir, 'c-added-folder'));
    await sleep(3000);
    r = sr('stop');
  } finally {
    try { osa('tell application "Finder" to close window "SRM-HIDDEN"'); } catch {}
  }
  // Frames at 0.5 s and 1.8 s are both before the change (files are written about 2.5 s after start returns).
  const baseline = await grayDiff(r.out, 0.5, 1.8);
  const change = await grayDiff(r.out, 1.8, r.durationSec - 0.3);
  const covered = contains(coverRect, finderRect);
  const v = coveredFinderVerdict({ baseline, change, covered });
  const first = await evidence(r.out, 'finder-covered', 0.5), mid = await evidence(r.out, 'finder-covered', 1.8), last = await evidence(r.out, 'finder-covered', Math.max(1.9, r.durationSec - 0.3));
  return { result: v.result, note: `${v.why}. Baseline diff ${baseline.toFixed(2)} (0.5 s vs 1.8 s, before the change; must be < 1), change diff ${change.toFixed(2)} (1.8 s vs end; must be > 3 and > 3x baseline), covered ${covered} (cover {${coverRect.join(', ')}} vs Finder {${finderRect.join(', ')}})`, evidence: ev(path.basename(r.out), first, mid, last) };
});

await scenario('follow-app: Finder to Preview', async () => {
  // under recordings/ (gitignored), not the system temp folder: Preview may not open files from there
  const dir = path.join(process.cwd(), 'recordings', 'SRM-FOLLOW'); fs.mkdirSync(dir, { recursive: true });
  const img = path.join(dir, 'screenrec-test.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x400', '-frames:v', '1', img]);
  let r;
  try {
    osa(`tell application "Finder" to set bounds of (make new Finder window to (POSIX file "${dir}" as alias)) to {200, 150, 1000, 650}`); await sleep(1500);
    sr('start', '--window', 'Finder:SRM-FOLLOW', '--follow-app', '--out', out('follow-app'), '--force'); await sleep(1500);
    // `open -a`, not Finder scripting: macOS refused Finder's AppleEvent open with "(null) does not have permission"
    execFileSync('open', ['-a', 'Preview', img]);
    // Wait for Preview's window (up to 8 s), then give the follower time to switch.
    for (let i = 0; i < 16 && !sr('list', 'windows').windows.some((w) => w.app === 'Preview' && w.title.includes('screenrec-test')); i++) await sleep(500);
    await sleep(2000);
    r = sr('stop');
  } finally {
    // Closing the Preview window needs the Automation permission for Preview; a first run shows a macOS prompt.
    try { osa('with timeout of 10 seconds', 'tell application "Preview" to close (every window whose name contains "screenrec-test")', 'end timeout'); } catch {}
    try { osa('tell application "Finder" to close window "SRM-FOLLOW"'); } catch {}
  }
  const marks = JSON.parse(fs.readFileSync(r.sidecar, 'utf8')).marks.map((m) => m.text);
  return { result: marks.some((m) => m.startsWith('switched to Preview')) ? 'PASS' : 'FAIL', note: JSON.stringify(marks), evidence: ev(path.basename(r.out), await evidence(r.out, 'follow-app', Math.max(1, r.durationSec - 0.5))) };
});

// Manual scenarios. The Chrome ones touch the user's own Chrome and run only with the user present.
// Done with the user on 2026-10-22 and recorded in docs/TESTED.md ("Chrome checks with the user"), so not
// listed here: covered Chrome without the occlusion flag, gate check 4 with the flag, hidden tab, broker Allow.
const MANUAL = [
  ['Headed Chrome checks', 'Run the headed checks from the Chrome tasks (npm run test:chrome with a visible Chrome). Did they pass?'],
  ['Claude in Chrome alongside', 'Run a Claude in Chrome task while "screenrec start --tab follow" records. Did both work?'],
  ['Covered Safari window stays live', 'Open the colour page in Safari, cover it, run "screenrec start --window \'Safari:SCREENREC COLOUR\'", wait 6 s, stop. Did the colour keep changing (throttled is fine)?'],
  ['Window on another Space', 'Start --window on a window in another Space, switch Spaces twice, stop. Did the video show the window throughout?'],
  ['Full-screen app', 'Start --app on an app in full-screen mode, interact, stop. Was the content recorded?'],
  ['Monitor unplugged', 'Start --window on a window on the external display, unplug it, wait 3 s, stop. Was a playable file saved?'],
];
if (!only) {
  for (const [name, steps] of MANUAL) {
    if (autoOnly) { results.push({ name, result: 'PENDING', note: `manual: ${steps}` }); continue; }
    console.log(`\nMANUAL: ${name}\n  ${steps}`);
    results.push({ name, result: (await ask('Did it pass?')) ? 'MANUAL-PASS' : 'MANUAL-FAIL', note: steps });
  }
}

fs.writeFileSync(path.join(evidenceDir, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));
const sh = (c, ...a) => execFileSync(c, a, { encoding: 'utf8' }).trim();
const machine = `${sh('sysctl', '-n', 'hw.model')} (${sh('uname', '-m')}), macOS ${sh('sw_vers', '-productVersion')}, ${displays.map((d) => `${d.name} ${d.width}x${d.height} pt @${d.scale}x`).join(' + ')}`;
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
const table = ['', `## Matrix ${today}`, '', `Machine: ${machine}. Evidence: ${path.relative(process.cwd(), evidenceDir)}/ (local, not committed; the date in headings and folder names is UTC).`, '',
  '| Scenario | Result | Note | Evidence |', '|---|---|---|---|', ...results.map((r) => `| ${cell(r.name)} | ${r.result} | ${cell(r.note)} | ${cell(r.evidence)} |`), ''].join('\n');
if (!noAppend && results.length > 0) fs.appendFileSync('docs/TESTED.md', table);
console.log(table);
const summary = summarise(results);
console.log(`\n${summary.line}`);
process.exit(summary.code);

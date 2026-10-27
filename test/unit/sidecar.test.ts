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

test('readMarks skips a torn last line left by a killed worker', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-')), 'torn.marks.jsonl');
  fs.writeFileSync(f, '{"t":0.5,"text":"a"}\n{"t":1,"text":"b"}\n{"t":1.2,"te');
  assert.deepEqual(readMarks(f), [{ t: 0.5, text: 'a' }, { t: 1, text: 'b' }]);
});

test('readSidecar ignores a same-named JSON that is not a screenrec sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  const cases: unknown[] = [{ title: 'x' }, { version: 2, marks: [] }, { version: 1 }, { version: 1, marks: 'no' }, [1, 2], 'str', null, 3];
  cases.forEach((c, i) => {
    const f = path.join(dir, `f${i}.json`);
    fs.writeFileSync(f, JSON.stringify(c));
    assert.equal(readSidecar(f), null, JSON.stringify(c));
  });
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(readSidecar(bad), null);
});

test('readSidecar keeps only the sidecar fields and well-formed marks', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')), 'a.json');
  fs.writeFileSync(f, JSON.stringify({ version: 1, target: { kind: 'display', display: 'main' }, startedAt: 's', durationSec: 2, marks: [{ t: 1, text: 'a', extra: 1 }, { t: 'x', text: 'b' }, null], secret: 'leak' }));
  const sc = readSidecar(f) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(sc).sort(), ['durationSec', 'marks', 'startedAt', 'target', 'version']);
  assert.deepEqual(sc.marks, [{ t: 1, text: 'a' }]);
});

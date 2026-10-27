import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readJsonLine } from '../../src/capture/stdin-line.ts';

test('readJsonLine parses the first line and keeps later bytes for the next reader (a "stop" sent with the config)', async () => {
  const s = new PassThrough();
  s.write('{"a":1}\nstop\n');
  assert.deepEqual(await readJsonLine(s), { a: 1 });
  const later = await new Promise<string>((r) => { s.on('data', (d) => r(String(d))); s.resume(); });
  assert.equal(later, 'stop\n');
});

test('readJsonLine rejects on end without a line or on bad JSON', async () => {
  const a = new PassThrough(); const pa = readJsonLine(a); a.end('{"a":');
  await assert.rejects(pa);
  const b = new PassThrough(); const pb = readJsonLine(b); b.end('nope\n');
  await assert.rejects(pb);
});

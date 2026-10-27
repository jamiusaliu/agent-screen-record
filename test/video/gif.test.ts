import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeVideo } from './helpers.ts';
import { probe } from '../../src/edit/ffmpeg.ts';
import { gif } from '../../src/edit/gif.ts';

test('gif is created, starts with the GIF signature and stays small', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await makeVideo(input, 'moving', { seconds: 2 });
    const r = await gif(input, { width: 1000 });
    assert.equal(fs.readFileSync(r.out).subarray(0, 6).toString('ascii'), 'GIF89a');
    assert.equal((await probe(input)).width, 320);
    assert.equal(await gifWidth(r.out), 320, 'width capped at the source width');
    assert.ok(r.bytes > 10_000 && r.bytes < 3_000_000, `bytes ${r.bytes}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function gifWidth(file: string): Promise<number> {
  return (await probe(file)).width;
}

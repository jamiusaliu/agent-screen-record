import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { probe } from '../../src/edit/ffmpeg.ts';
import { squeeze } from '../../src/edit/squeeze.ts';
import { crop } from '../../src/edit/crop.ts';
import { trim } from '../../src/edit/trim.ts';
import { blur } from '../../src/edit/blur.ts';
import { gif } from '../../src/edit/gif.ts';
import { frame } from '../../src/edit/frame.ts';

const exec = promisify(execFile);

function av1Encoder(): string | undefined {
  try {
    const list = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return ['libsvtav1', 'libaom-av1'].find((e) => new RegExp(`\\s${e}\\s`).test(list));
  } catch { return undefined; }
}
const encoder = av1Encoder();

async function streamInfo(file: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file]);
  return (JSON.parse(stdout) as { streams: { codec_name: string; width: number; height: number }[] }).streams[0];
}

async function assertH264(file: string, label: string) {
  const s = await streamInfo(file);
  assert.equal(s.codec_name, 'h264', `${label} codec`);
  assert.equal(s.width % 2, 0, `${label} width ${s.width} even`);
  assert.equal(s.height % 2, 0, `${label} height ${s.height} even`);
}

test('every edit command accepts AV1 variable-frame-rate input (like Chrome DevTools MCP screencasts)', { skip: encoder ? false : 'no AV1 encoder (libsvtav1 or libaom-av1) in this ffmpeg' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av1-'));
  try {
    const input = path.join(dir, 'screencast.mp4');
    // 6 s of 30 fps source, keep an irregular subset of frames so timestamps are variable (no retiming)
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x322:rate=30:duration=6,noise=alls=40:allf=t+u',
      '-vf', "select='lt(mod(n*n,11),3)'", '-fps_mode', 'vfr', '-c:v', encoder!, '-pix_fmt', 'yuv420p',
      ...(encoder === 'libaom-av1' ? ['-crf', '35', '-cpu-used', '8'] : ['-crf', '35']), input]);
    const src = await streamInfo(input);
    assert.equal(src.codec_name, 'av1', 'fixture is AV1');
    const p = await probe(input);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,avg_frame_rate', '-of', 'csv=p=0', input]);
    const [r, avg] = stdout.trim().split(',').map((v) => { const [n, d] = v.split('/').map(Number); return n / d; });
    assert.ok(Math.abs(r - avg) > 1, `fixture is variable frame rate (r ${r}, avg ${avg})`);
    assert.ok(p.duration > 5 && p.duration < 7, `fixture duration ${p.duration}`);

    const sq = await squeeze(input);
    await assertH264(sq.out, 'squeeze');
    assert.ok(sq.afterSec > 0.5 && sq.afterSec <= sq.beforeSec + 0.5, `squeeze ${sq.beforeSec} -> ${sq.afterSec}`);

    const cr = await crop(input, { rect: { x: 11, y: 10, width: 301, height: 101 } });
    await assertH264(cr.out, 'crop');
    const pc = await probe(cr.out);
    assert.deepEqual([pc.width, pc.height], [300, 100]);
    assert.ok(Math.abs(pc.duration - p.duration) < 0.7, `crop duration ${pc.duration}`);

    const tr = await trim(input, { from: 1, to: 4 });
    await assertH264(tr.out, 'trim');
    assert.ok(tr.durationSec > 2.4 && tr.durationSec < 3.6, `trim ${tr.durationSec}`);

    const bl = await blur(input, { boxes: [{ x: 100, y: 80, w: 80, h: 60 }, { w: 60, h: 40, keyframes: [{ t: 0.5, x: 20, y: 200 }, { t: 3, x: 220, y: 200 }] }] });
    await assertH264(bl.out, 'blur');
    const pb = await probe(bl.out);
    assert.ok(Math.abs(pb.duration - p.duration) < 0.7, `blur duration ${pb.duration}`);

    const g = await gif(input, { width: 320 });
    assert.equal(fs.readFileSync(g.out).subarray(0, 6).toString('ascii'), 'GIF89a');
    assert.ok(g.bytes > 1000, `gif bytes ${g.bytes}`);
    const pg = await probe(g.out);
    assert.equal(pg.width, 320);
    assert.ok(pg.duration > 3 && pg.duration < 8, `gif duration ${pg.duration}`);

    const fr = await frame(input, { at: 2, width: 320 });
    assert.equal((await probe(fr.out)).width, 320);
    assert.equal(fs.readFileSync(fr.out).subarray(1, 4).toString('ascii'), 'PNG');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

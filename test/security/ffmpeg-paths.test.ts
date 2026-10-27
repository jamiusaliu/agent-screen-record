// ffmpeg reads a "proto:" prefix in any input or output path as a protocol (tcp:, rtmp:, http:, pipe:,
// concat:, subfile:), and a leading dash as an option. A clean-up --out of tcp://host:port/x.gif made
// ffmpeg send the whole GIF over the network (verified 2026-10-21 against a loopback listener).
// Paths therefore reach ffmpeg only as absolute file paths, and runFfmpeg/probe refuse URL-like args.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import { localPath } from '../../src/edit/output.ts';
import { runFfmpeg, probe } from '../../src/edit/ffmpeg.ts';
import { gif } from '../../src/edit/gif.ts';
import { crop } from '../../src/edit/crop.ts';
import { trim } from '../../src/edit/trim.ts';
import { frame } from '../../src/edit/frame.ts';
import { blur } from '../../src/edit/blur.ts';
import { squeeze } from '../../src/edit/squeeze.ts';
import type { ScreenrecError } from '../../src/core/errors.ts';

const badArgs = (e: ScreenrecError) => e.code === 'E_BAD_ARGS';

test('localPath refuses URLs and makes every other path absolute', () => {
  for (const u of ['tcp://127.0.0.1:9/x.gif', 'rtmp://example.invalid/live/x.mp4', 'HTTP://example.invalid/a.png', 'udp://127.0.0.1:9', 'file:///tmp/x.mp4']) {
    assert.throws(() => localPath(u), badArgs, u);
  }
  assert.throws(() => localPath(''), badArgs);
  for (const p of ['-y.gif', 'concat:a.mp4|b.mp4', 'pipe:1', 'subfile:,,start,0,end,0,:in.mp4', 'notes:v2.mp4', 'My Videos/é.mp4']) {
    const r = localPath(p);
    assert.ok(path.isAbsolute(r) && r.startsWith(path.sep), `${p} -> ${r}`);
    assert.equal(r, path.resolve(p));
  }
  assert.equal(localPath('/abs/x.mp4'), '/abs/x.mp4');
});

test('runFfmpeg and probe refuse URL-like arguments before starting ffmpeg', async () => {
  const prev = { f: process.env.SCREENREC_FFMPEG, p: process.env.SCREENREC_FFPROBE };
  // a missing binary would give E_NO_FFMPEG: E_BAD_ARGS proves the guard ran first
  process.env.SCREENREC_FFMPEG = process.env.SCREENREC_FFPROBE = '/nonexistent/ffmpeg-for-test';
  try {
    for (const a of ['tcp://127.0.0.1:9/x.gif', 'concat:/etc/hosts', 'subfile:,,start,0,end,0,:/etc/hosts', 'http://example.invalid/x', 'pipe:1']) {
      await assert.rejects(runFfmpeg(['-v', 'error', '-y', '-i', '/tmp/in.mp4', a]), badArgs, a);
      await assert.rejects(probe(a), badArgs, a);
    }
    // ordinary arguments still pass the guard (and then fail only because the binary is missing)
    await assert.rejects(runFfmpeg(['-v', 'error', '-select_streams', 'v:0', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1', '-filter_complex', '[0:v]crop=w=8:h=8[b]', '-f', 'null', '-']),
      (e: ScreenrecError) => e.code === 'E_NO_FFMPEG');
  } finally {
    if (prev.f === undefined) delete process.env.SCREENREC_FFMPEG; else process.env.SCREENREC_FFMPEG = prev.f;
    if (prev.p === undefined) delete process.env.SCREENREC_FFPROBE; else process.env.SCREENREC_FFPROBE = prev.p;
  }
});

test('no clean-up command sends a byte to a URL given as --out', async () => {
  let bytes = 0; let conns = 0;
  const srv = net.createServer((s) => { conns++; s.on('data', (d) => { bytes += d.length; }); s.on('error', () => {}); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = (ext: string) => `tcp://127.0.0.1:${(srv.address() as net.AddressInfo).port}/x.${ext}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffurl-'));
  const input = path.join(dir, 'in.mp4'); fs.writeFileSync(input, 'not a video');
  try {
    await assert.rejects(gif(input, { out: url('gif') }), badArgs, 'gif');
    await assert.rejects(crop(input, { trimEdges: 8, out: url('mp4') }), badArgs, 'crop');
    await assert.rejects(trim(input, { from: 0, to: 1, out: url('mp4') }), badArgs, 'trim');
    await assert.rejects(frame(input, { at: 0, out: url('png') }), badArgs, 'frame');
    await assert.rejects(blur(input, { boxes: [{ x: 0, y: 0, w: 8, h: 8 }], out: url('mp4') }), badArgs, 'blur');
    await assert.rejects(squeeze(input, { out: url('mp4') }), badArgs, 'squeeze');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(conns, 0, 'nothing connected'); assert.equal(bytes, 0);
  } finally {
    srv.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

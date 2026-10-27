import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frame } from '../../src/edit/frame.ts';
import { ScreenrecError } from '../../src/core/errors.ts';

test('frame rejects a non-finite or negative --at before touching ffmpeg', async () => {
  for (const at of [NaN, -1, Infinity]) {
    await assert.rejects(frame('/nonexistent/in.mp4', { at }), (e: ScreenrecError) => e.code === 'E_BAD_ARGS');
  }
});

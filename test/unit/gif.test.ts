import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifArgs } from '../../src/edit/gif.ts';

test('gifArgs uses a two-pass palette in one filter graph', () => {
  const a = gifArgs('in.mp4', 'out.gif', 640, 12);
  const vf = a[a.indexOf('-vf') + 1];
  assert.equal(vf, 'fps=12,scale=640:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5');
  assert.equal(a.at(-1), 'out.gif');
});

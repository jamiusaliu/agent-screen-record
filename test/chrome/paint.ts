// Load-robust helpers for the Chrome tests. A loaded machine starves the page's timer, so a fixed
// sleep can end before the page has painted anything new. Wait on the page's own progress instead,
// then keep the same colour requirements.
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import type { CdpClient } from '../../src/capture/cdp/client.ts';
const exec = promisify(execFile);

/** Wait until the colour page has changed colour at least n times (window.__changes), up to maxMs. */
export async function waitForPaints(c: CdpClient, targetId: string, n: number, maxMs = 90_000): Promise<number> {
  const { sessionId } = await c.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const until = Date.now() + maxMs;
  let seen = 0;
  try {
    for (;;) {
      seen = (await c.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'window.__changes || 0', returnByValue: true }, sessionId)).result.value;
      if (seen >= n) return seen;
      if (Date.now() > until) throw new Error(`page changed colour only ${seen} times in ${maxMs} ms (wanted ${n})`);
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally { await c.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
}

/** Coarse RGB buckets of the frame centre, four samples per second over the whole recording, one ffmpeg pass. */
export async function centreColours(file: string): Promise<Set<string>> {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file,
    '-vf', 'fps=4,crop=4:4:(iw-4)/2:(ih-4)/2,scale=1:1,format=rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
  const b = stdout as unknown as Buffer;
  const seen = new Set<string>();
  for (let i = 0; i + 2 < b.length; i += 3) seen.add([b[i], b[i + 1], b[i + 2]].map((v) => Math.round(v / 64)).join(','));  // coarse buckets survive compression
  return seen;
}

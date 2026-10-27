import { stopRecording } from '../recorder.ts';
import type { CommandFn } from './types.ts';
const cmd: CommandFn = async () => {
  const r = await stopRecording();
  const lines = [`saved ${r.out} (${r.durationSec.toFixed(1)} s, ${r.reason})`, ...(r.warnings ?? []).map((w) => `warning: ${w}`)];
  return { ok: true, text: lines.join('\n'), ...r };
};
export default cmd;

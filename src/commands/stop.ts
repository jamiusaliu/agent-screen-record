import { stopRecording } from '../recorder.ts';
import type { CommandFn } from './types.ts';
const cmd: CommandFn = async () => {
  const r = await stopRecording();
  return { ok: true, text: `saved ${r.out} (${r.durationSec.toFixed(1)} s, ${r.reason})`, ...r };
};
export default cmd;

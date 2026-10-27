import { addMark } from '../recorder.ts';
import { ScreenrecError } from '../core/errors.ts';
import type { CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const text = a.positionals.join(' ').trim();
  if (!text) throw new ScreenrecError('E_BAD_ARGS', 'mark needs some text', 'Example: screenrec mark "clicked Download"');
  const r = addMark(text);
  return { ok: true, text: `noted at ${r.t} s: ${text}`, ...r };
};
export default cmd;

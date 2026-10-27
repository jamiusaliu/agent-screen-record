import { gif } from '../edit/gif.ts';
import { requireInput, numFlag, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const r = await gif(requireInput(a), { width: numFlag(a, 'width', 800), fps: numFlag(a, 'fps', 12), out: a.values.out as string | undefined, force: a.values.force === true });
  return { ok: true, text: `gif ${(r.bytes / 1024 / 1024).toFixed(2)} MB: ${r.out}`, ...r };
};
export default cmd;

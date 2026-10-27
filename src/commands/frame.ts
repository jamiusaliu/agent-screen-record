import { frame } from '../edit/frame.ts';
import { requireInput, numFlag, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const at = Number(a.values.at ?? 0);
  const r = await frame(requireInput(a), { at, width: a.values.width ? numFlag(a, 'width', 800) : undefined, out: a.values.out as string | undefined, force: a.values.force === true });
  return { ok: true, text: `frame at ${at} s: ${r.out}`, ...r };
};
export default cmd;

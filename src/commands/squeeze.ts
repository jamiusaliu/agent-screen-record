import { squeeze } from '../edit/squeeze.ts';
import { requireInput, numFlag, type CommandFn } from './types.ts';

// squeeze() validates hold (finite, >= 0) and throws E_BAD_ARGS, so the command only converts the flag.
const cmd: CommandFn = async (a) => {
  const hold = a.values.hold === undefined ? undefined : Number(String(a.values.hold).trim() === '' ? NaN : a.values.hold);
  const r = await squeeze(requireInput(a), { out: a.values.out as string | undefined, force: a.values.force === true, fps: numFlag(a, 'fps', 30), hold });
  return { ok: true, text: `squeezed ${r.beforeSec.toFixed(1)} s to ${r.afterSec.toFixed(1)} s: ${r.out}`, ...r };
};
export default cmd;

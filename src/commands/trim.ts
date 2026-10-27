import { trim } from '../edit/trim.ts';
import { requireInput, type CommandFn } from './types.ts';
import { ScreenrecError } from '../core/errors.ts';
const cmd: CommandFn = async (a) => {
  const from = Number(a.values.from ?? 0); const to = Number(a.values.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ScreenrecError('E_BAD_ARGS', 'trim needs --to (and optional --from) in seconds', 'Example: screenrec trim in.mp4 --from 3 --to 40');
  const r = await trim(requireInput(a), { from, to, out: a.values.out as string | undefined, force: a.values.force === true });
  return { ok: true, text: `trimmed to ${r.durationSec.toFixed(1)} s: ${r.out}`, ...r };
};
export default cmd;

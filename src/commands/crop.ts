import { crop, parseRect } from '../edit/crop.ts';
import { requireInput, numFlag, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const r = await crop(requireInput(a), {
    rect: a.values.rect ? parseRect(a.values.rect as string) : undefined,
    trimEdges: a.values['trim-edges'] !== undefined ? numFlag(a, 'trim-edges', 8) : undefined,
    out: a.values.out as string | undefined, force: a.values.force === true,
  });
  return { ok: true, text: `cropped to ${r.rect.width}x${r.rect.height}: ${r.out}`, ...r };
};
export default cmd;

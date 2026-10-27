import { blur, parseBoxFlag, loadBoxes, type BlurBox } from '../edit/blur.ts';
import { requireInput, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const boxes: BlurBox[] = [
    ...((a.values.box as string[] | undefined) ?? []).map(parseBoxFlag),
    ...(a.values.boxes ? loadBoxes(a.values.boxes as string) : []),
  ];
  const r = await blur(requireInput(a), { boxes, out: a.values.out as string | undefined, force: a.values.force === true });
  return { ok: true, text: `blurred ${r.boxes} box(es): ${r.out}`, ...r };
};
export default cmd;

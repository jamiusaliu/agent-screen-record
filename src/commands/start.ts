import { startRecording } from '../recorder.ts';
import { parseTarget, type TargetFlags } from '../core/targets.ts';
import { parseDuration } from '../cli/args.ts';
import { numFlag, allowWaitReporter, type CommandFn } from './types.ts';
const cmd: CommandFn = async (a) => {
  const waits: string[] = [];
  const r = await startRecording({
    onAllowWait: allowWaitReporter(a, waits),
    target: parseTarget(a.values as TargetFlags), out: a.values.out as string | undefined, force: a.values.force === true, fps: numFlag(a, 'fps', 30),
    cursor: a.values.cursor === true, maxMs: parseDuration((a.values.max as string | undefined) ?? '10m'), meta: a.values['no-meta'] !== true,
  });
  r.warnings.push(...waits);
  const lines = [`recording ${r.target} -> ${r.out}`, 'stop with: screenrec stop', ...r.warnings.map((w) => `warning: ${w}`)];
  if (r.recovered) lines.unshift(`recovered an earlier recording: ${r.recovered.out}`);
  return { ok: true, text: lines.join('\n'), ...r };
};
export default cmd;

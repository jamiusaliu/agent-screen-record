import { parseArgs } from 'node:util';
import { ScreenrecError } from '../core/errors.ts';
import type { ParsedArgs } from '../commands/types.ts';

type Opt = { type: 'string' | 'boolean'; multiple?: boolean };
const S: Opt = { type: 'string' }; const B: Opt = { type: 'boolean' };
const target = { window: S, app: S, display: S, 'display-of': S, region: S, tab: S, cdp: S };

export const COMMANDS: Record<string, Record<string, Opt>> = {
  version: {}, doctor: {}, status: {}, stop: {}, mcp: {},
  'chrome-broker': {},
  list: { cdp: S },
  start: { ...target, 'follow-app': B, 'ignore-app': { type: 'string', multiple: true }, out: S, force: B, fps: S, cursor: B, max: S, 'no-meta': B },
  mark: {},
  screenshot: { ...target, out: S, force: B },
  squeeze: { out: S, force: B, fps: S, hold: S },
  crop: { rect: S, 'trim-edges': S, out: S, force: B },
  blur: { box: { type: 'string', multiple: true }, boxes: S, out: S, force: B },
  trim: { from: S, to: S, out: S, force: B },
  gif: { width: S, fps: S, out: S, force: B },
  frame: { at: S, width: S, out: S, force: B },
};

export function parseCli(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !(command in COMMANDS)) {
    throw new ScreenrecError('E_BAD_ARGS', command ? `Unknown command "${command}"` : 'No command given',
      `Commands: ${Object.keys(COMMANDS).join(', ')}`);
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, strict: true,
      options: { ...COMMANDS[command], json: B, help: B },
    });
    const json = values.json === true;
    delete (values as Record<string, unknown>).json;
    return { command, positionals, values: values as ParsedArgs['values'], json };
  } catch (e) {
    const dash = command === 'mark' ? ' Text that starts with a dash must follow --, e.g. screenrec mark -- "-x".' : '';
    throw new ScreenrecError('E_BAD_ARGS', (e as Error).message, `Run "screenrec ${command} --help" for the flags it accepts.${dash}`);
  }
}

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new ScreenrecError('E_BAD_ARGS', `Bad duration "${s}"`, 'Use e.g. 90s, 10m, 1h or plain seconds.');
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  return Math.round(n * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit]!);
}

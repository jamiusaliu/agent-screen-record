import { parseCli, COMMANDS } from './args.ts';
import { errorJson, ScreenrecError } from '../core/errors.ts';
import type { CommandFn } from '../commands/types.ts';

export interface Io { out: (s: string) => void; err: (s: string) => void }
const defaultIo: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };
type Importer = (spec: string) => Promise<unknown>;
const defaultImporter: Importer = (spec) => import(spec);

// TypeScript rewrites .ts specifiers to .js in built output, so accept either extension in the message.
const isMissing = (e: unknown, name: string): boolean =>
  (e as { code?: string })?.code === 'ERR_MODULE_NOT_FOUND' && new RegExp(`/commands/${name}\\.(js|ts)\\b`).test(String((e as Error).message));

async function loadCommand(name: string, importer: Importer): Promise<CommandFn> {
  const js = `../commands/${name}.js`, ts = `../commands/${name}.ts`;
  for (const spec of [js, ts]) {
    try { return ((await importer(spec)) as { default: CommandFn }).default; }
    catch (e) { if (!isMissing(e, name)) throw e; }
  }
  throw new ScreenrecError('E_BAD_ARGS', `Command "${name}" is not available in this build`,
    'Run screenrec --help for the commands this build supports.');
}

function flagList(command: string): string[] { return Object.keys(COMMANDS[command]).concat('json'); }

function helpFor(argv: string[]): { text: string; data: Record<string, unknown> } | null {
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  const [first] = argv;
  if (first === 'help' || (wantsHelp && (!first || first.startsWith('-')))) {
    const names = Object.keys(COMMANDS);
    return { text: `Usage: screenrec <command> [flags]\nCommands: ${names.join(', ')}\nRun screenrec <command> --help for a command's flags.`, data: { commands: names } };
  }
  if (wantsHelp && first && first in COMMANDS) {
    const flags = flagList(first);
    return { text: `Usage: screenrec ${first} [args] [flags]\nFlags: ${flags.map((f) => `--${f}`).join(' ')}`, data: { command: first, flags } };
  }
  return null;
}

export async function main(argv: string[], io: Io = defaultIo, importer: Importer = defaultImporter): Promise<number> {
  const json = argv.includes('--json');
  try {
    const help = helpFor(argv);
    if (help) { io.out(json ? JSON.stringify({ ok: true, ...help.data }) + '\n' : help.text + '\n'); return 0; }
    const a = parseCli(argv);
    const result = await (await loadCommand(a.command, importer))(a);
    io.out(a.json ? JSON.stringify(result) + '\n' : result.text + '\n');
    return 0;
  } catch (e) {
    const j = errorJson(e);
    if (process.env.SCREENREC_DEBUG === '1' && e instanceof Error) io.err(String(e.stack) + '\n');
    if (json) io.out(JSON.stringify(j) + '\n');
    else io.err(`error ${j.code}: ${j.message}\nfix: ${j.fix}\n${j.candidates ? j.candidates.map((c) => `  ${c}`).join('\n') + '\n' : ''}`);
    return 1;
  }
}

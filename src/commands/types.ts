import fs from 'node:fs';
import { ScreenrecError } from '../core/errors.ts';

export interface ParsedArgs {
  command: string; positionals: string[];
  values: Record<string, string | boolean | string[] | undefined>; json: boolean;
}
export interface CommandResult { ok: true; text: string; [key: string]: unknown }
export type CommandFn = (a: ParsedArgs) => Promise<CommandResult>;

export function requireInput(a: ParsedArgs): string {
  const input = a.positionals[0];
  if (!input) throw new ScreenrecError('E_BAD_ARGS', `"${a.command}" needs an input file`, `Usage: screenrec ${a.command} <file> [flags]`);
  if (!fs.existsSync(input)) throw new ScreenrecError('E_BAD_ARGS', `Input not found: ${input}`, 'Check the path; quote it if it contains spaces.');
  return input;
}

export function numFlag(a: ParsedArgs, name: string, fallback: number): number {
  const v = a.values[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ScreenrecError('E_BAD_ARGS', `--${name} must be a positive number, got "${String(v)}"`, `Example: --${name} ${fallback}`);
  return n;
}

export const ALLOW_WAIT_TEXT = 'Waiting for you to click Allow in Chrome...';

/** Tells the user we are waiting on Chrome's Allow dialog: one stderr line, or a warning in --json mode. */
export function allowWaitReporter(a: ParsedArgs, warnings: string[], err: (s: string) => void = (s) => { process.stderr.write(s); }): () => void {
  return () => { if (a.json) warnings.push(ALLOW_WAIT_TEXT); else err(`${ALLOW_WAIT_TEXT}\n`); };
}

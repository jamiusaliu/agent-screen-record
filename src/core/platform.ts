import { ScreenrecError } from './errors.ts';

/** The fix text for Windows, where v1 supports the clean-up commands only. */
export const WINDOWS_FIX = 'On Windows, v1 supports the clean-up commands only (squeeze, crop, trim, blur, gif, frame). Record on a Mac.';

/**
 * Recording, and the Chrome broker behind tab recording, need POSIX process groups and `ps` for
 * liveness checks. Neither exists on Windows, so v1 refuses there instead of misreporting.
 */
export function assertNotWindows(what: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') throw new ScreenrecError('E_UNSUPPORTED_PLATFORM', `${what} is not supported on Windows in v1`, WINDOWS_FIX);
}

/** Whether a pid exists at all (EPERM means it exists but belongs to another user). */
export function pidExists(pid: number): boolean {
  if (!signalable(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Only a real child pid: never 0 (our group), 1 (kill(-1) signals every process we own) or below. */
export function signalable(pid: number): boolean { return Number.isInteger(pid) && pid > 1; }

/** process.kill for a pid we were given (state or info file), refusing anything signalable() rejects. */
export function safeKill(pid: number, sig: NodeJS.Signals): void {
  if (signalable(pid)) process.kill(pid, sig);
}

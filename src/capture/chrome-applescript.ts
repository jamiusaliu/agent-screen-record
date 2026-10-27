import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export interface ChromeActiveTab { windowIndex: number; title: string; url: string }

export function parseActiveTabs(out: string): ChromeActiveTab[] {
  return out.split('\n').filter(Boolean).map((line) => {
    const [i, ...restParts] = line.split('\t');
    const url = restParts.pop() ?? '';
    return { windowIndex: Number(i), title: restParts.join('\t'), url };
  });
}

const SCRIPT = `
if application "Google Chrome" is not running then return ""
set out to ""
tell application "Google Chrome"
  repeat with i from 1 to (count of windows)
    set t to active tab of window i
    set out to out & i & tab & (title of t) & tab & (URL of t) & linefeed
  end repeat
end tell
return out`;

/** Active tab of each Chrome window, via AppleScript. Never launches Chrome. macOS asks once for Automation permission. */
export async function chromeActiveTabs(): Promise<ChromeActiveTab[]> {
  if (process.platform !== 'darwin') return [];
  try { return parseActiveTabs((await exec('osascript', ['-e', SCRIPT])).stdout); } catch { return []; }
}

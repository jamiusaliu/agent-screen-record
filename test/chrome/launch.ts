import { install, Browser, detectBrowserPlatform, resolveBuildId, computeExecutablePath } from '@puppeteer/browsers';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { readDevToolsActivePort } from '../../src/capture/cdp/endpoint.ts';

const cacheDir = path.resolve('.cache/chrome');

/**
 * Headless only, and never the user's keychain: without --use-mock-keychain an unsigned or new
 * Chrome for Testing build asks macOS for "Chromium Safe Storage", which shows a password dialog.
 */
export function chromeTestArgs(userDataDir: string): string[] {
  return ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--use-mock-keychain', '--password-store=basic',
    '--no-first-run', '--no-default-browser-check', '--window-size=800,500', 'about:blank'];
}

export async function launchChrome(): Promise<{ wsUrl: string; proc: ChildProcess; userDataDir: string; buildId: string }> {
  const platform = detectBrowserPlatform()!;
  // SCREENREC_TEST_CHROME_BUILD pins a Chrome for Testing build (e.g. 155.0.8059.84); default: current stable
  const buildId = process.env.SCREENREC_TEST_CHROME_BUILD || await resolveBuildId(Browser.CHROME, platform, 'stable');
  await install({ browser: Browser.CHROME, buildId, cacheDir });
  const exe = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srchrome-'));
  const proc = spawn(exe, chromeTestArgs(userDataDir), { stdio: 'ignore' });
  // up to 30 s: on a heavily loaded machine Chrome alone can take 10 s to start
  for (let i = 0; i < 300; i++) {
    const p = readDevToolsActivePort(userDataDir);
    if (p) return { wsUrl: `ws://127.0.0.1:${p.port}${p.path}`, proc, userDataDir, buildId };
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('Chrome for Testing did not start');
}

import fs from 'node:fs'; import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { requireFfmpeg, requireFfprobe, ffmpegTooOld, MIN_FFMPEG } from '../edit/ffmpeg.ts';
import * as mac from '../capture/mac.ts';
import { resolveEndpoint, redactUrl } from '../capture/cdp/endpoint.ts';
import { brokerStatus } from '../capture/cdp/broker-client.ts';
import { brokerDoctorCheck } from './chrome-broker.ts';
import { devtoolsMcpCheck } from '../core/mcp-config.ts';
import type { CommandFn } from './types.ts';
import { WINDOWS_FIX } from '../core/platform.ts';

export interface DoctorDeps { dirs?: string[]; ensureBroker?: Parameters<typeof resolveEndpoint>[0]['ensureBroker'] }

/** warn: optional (or advice only). It prints its fix but never makes allPassed false. */
export interface Check { name: string; ok: boolean; detail: string; fix?: string; warn?: boolean }

export function summarize(checks: Check[]): { text: string; allPassed: boolean } {
  const text = checks.map((c) => {
    const tag = c.warn ? 'WARN' : c.ok ? 'ok  ' : 'FIX ';
    return `${tag} ${c.name}: ${c.detail}${(!c.ok || c.warn) && c.fix ? `\n      ${c.fix}` : ''}`;
  }).join('\n');
  return { text, allPassed: checks.every((c) => c.ok || c.warn === true) };
}

export const doctorCommand = (deps: DoctorDeps = {}): CommandFn => async () => {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: major >= 22, detail: process.versions.node, fix: major >= 22 ? undefined : 'Install Node 22 or newer.' });
  try {
    const line = await requireFfmpeg();
    const old = ffmpegTooOld(line);
    checks.push({ name: 'ffmpeg', ok: !old, detail: line, fix: old ? `Upgrade ffmpeg to ${MIN_FFMPEG.join('.')} or newer (squeeze needs -fps_mode).` : undefined });
  }
  catch (e) { checks.push({ name: 'ffmpeg', ok: false, detail: 'not found', fix: (e as { fix?: string }).fix }); }
  try { checks.push({ name: 'ffprobe', ok: true, detail: await requireFfprobe() }); }
  catch (e) { checks.push({ name: 'ffprobe', ok: false, detail: 'not found', fix: (e as { fix?: string }).fix }); }
  if (process.platform === 'darwin') {
    const ver = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
    checks.push({ name: 'macOS', ok: Number(ver.split('.')[0]) >= 13, detail: ver, fix: 'Window capture needs macOS 13 or newer.' });
    const helper = fs.existsSync(mac.helperPath());
    checks.push({ name: 'capture helper', ok: helper, detail: mac.helperPath(), fix: helper ? undefined : mac.HELPER_MISSING_FIX });
    if (helper) {
      const granted = await mac.permission().catch(() => false);
      checks.push({ name: 'Screen Recording permission', ok: granted, detail: granted ? 'granted' : 'not granted', fix: granted ? undefined : mac.HELPER_FIXES.E_PERMISSION });
    }
    try {
      const v = execFileSync('defaults', ['read', '/Applications/Google Chrome.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const ok = Number(v.split('.')[0]) >= 144;
      checks.push({ name: 'Chrome version', ok, detail: v, fix: ok ? undefined : 'Hidden-tab recording in your normal Chrome needs Chrome 144 or newer; update Chrome.' });
    } catch { checks.push({ name: 'Chrome version', ok: true, detail: 'Google Chrome not installed in /Applications (optional)' }); }
    checks.push({ name: 'Chrome windows', ok: true, warn: true, detail: 'Chrome pauses drawing covered windows',
      fix: 'For window capture of Chrome keep the window uncovered (a second display works), or start Chrome with ' +
        '--disable-backgrounding-occluded-windows, or record a --tab instead.' });
  } else {
    checks.push({ name: 'window capture', ok: false, detail: `not available on ${process.platform} in v1`,
      fix: process.platform === 'win32' ? WINDOWS_FIX : 'Use --tab for Chrome tabs (unverified here); window capture is macOS-only for now.' });
  }
  // discovery only: doctor never connects or starts the broker, either would pop Chrome's Allow dialog
  const broker = brokerStatus();
  try {
    const e = await resolveEndpoint({ probeOnly: true, dirs: deps.dirs, ensureBroker: deps.ensureBroker });
    const detail = e.source === 'chrome'
      ? `endpoint found (port ${new URL(e.wsUrl).port}), broker ${broker ? 'running' : 'not running'}`
      : `${e.source === 'flag' ? '--cdp' : 'SCREENREC_CDP'}: ${redactUrl(e.wsUrl)}`;
    checks.push({ name: 'Chrome tab capture', ok: true, detail });
  }
  catch (e) { checks.push({ name: 'Chrome tab capture', ok: false, warn: true, detail: 'remote debugging not enabled (optional)', fix: (e as { fix?: string }).fix }); }
  checks.push(brokerDoctorCheck(broker));
  // the DevTools MCP route is optional: its telemetry advice is a warning
  checks.push(...chromeDevtoolsMcpChecks().map((c) => (c.ok ? c : { ...c, warn: true })));
  return { ok: true, ...summarize(checks), checks };
};
// Chrome DevTools MCP route (spec 6.6): read-only look at the agent MCP configs; names files and servers, never their env or headers.
function chromeDevtoolsMcpChecks(): Check[] {
  try { return [devtoolsMcpCheck({ home: os.homedir(), cwd: process.cwd() })]; }
  catch { return [{ name: 'Chrome DevTools MCP route', ok: true, detail: 'could not read the MCP configuration files' }]; }
}

export default doctorCommand();

import fs from 'node:fs'; import path from 'node:path';
import * as mac from '../capture/mac.ts';
import { parseTarget, type TargetFlags } from '../core/targets.ts';
import { recordingsDir, defaultRecordingBase } from '../core/paths.ts';
import { resolveEndpoint } from '../capture/cdp/endpoint.ts';
import { CdpClient } from '../capture/cdp/client.ts';
import { listTabs } from '../capture/cdp/tabs-list.ts';
import { ScreenrecError } from '../core/errors.ts';
import { allowWaitReporter, type CommandFn } from './types.ts';
import { assertOutFolder, assertOutFree, assertForceHasOut, writeOut } from '../edit/output.ts';

export interface ScreenshotDeps { resolveEndpoint?: typeof resolveEndpoint; err?: (s: string) => void; cwd?: string; home?: string }

export const screenshotCommand = (deps: ScreenshotDeps = {}): CommandFn => async (a) => {
  assertForceHasOut(a.values.force === true, a.values.out as string | undefined);
  const target = parseTarget(a.values as TargetFlags);
  const out = path.resolve((a.values.out as string | undefined) ?? path.join(recordingsDir(deps.cwd, deps.home), `${defaultRecordingBase()}.png`));
  const explicit = a.values.out !== undefined;
  const force = explicit && a.values.force === true;
  if (explicit) { assertOutFolder(out); assertOutFree(out, { force }); }
  if (target.kind === 'tab') {
    if (target.mode !== 'url' && target.mode !== 'title') {
      throw new ScreenrecError('E_BAD_ARGS', 'Tab screenshots need a specific tab', 'Use --tab url:<text> or --tab title:<text>.');
    }
    const warnings: string[] = [];
    const { wsUrl } = await (deps.resolveEndpoint ?? resolveEndpoint)({ cdp: target.cdp, onWaiting: allowWaitReporter(a, warnings, deps.err) });
    const p = target.pattern!.toLowerCase();
    const tab = (await listTabs(wsUrl)).find((t) => (target.mode === 'url' ? t.url : t.title).toLowerCase().includes(p));
    if (!tab) throw new ScreenrecError('E_TARGET_NOT_FOUND', `No tab matches "${target.pattern}"`, 'Run "screenrec list tabs".');
    let shot = out;
    const c = await CdpClient.connect(wsUrl);
    try {
      const { sessionId } = await c.send<{ sessionId: string }>('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
      let data: string;
      try { ({ data } = await c.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId)); }
      finally { await c.send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId, 3000).catch(() => {}); }
      shot = (await writeOut(out, { force, explicit }, async (tmp) => fs.writeFileSync(tmp, Buffer.from(data, 'base64')))).out;
    } finally { c.close(); }
    return { ok: true, text: `screenshot of tab "${tab.title}": ${shot}`, out: shot, ...(warnings.length ? { warnings } : {}) };
  }
  mac.assertMac();
  // A locked or sleeping screen draws nothing and ScreenCaptureKit can stall meanwhile: say so before asking it.
  const note = mac.screenNote(await mac.screenState());
  if (note) throw new ScreenrecError('E_NO_FRAMES', `screenshot not taken: ${note.what}`, note.fix);
  const { spec, label } = mac.resolveCaptureSpec(target, await mac.listDisplays(), await mac.listWindows(), false);
  const w = await writeOut(out, { force, explicit }, (tmp) => mac.screenshot(spec, tmp));
  return { ok: true, text: `screenshot of ${label}: ${w.out}`, ...w.value, out: w.out };
};
export default screenshotCommand();

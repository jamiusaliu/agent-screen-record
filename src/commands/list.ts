import * as mac from '../capture/mac.ts';
import { resolveEndpoint } from '../capture/cdp/endpoint.ts';
import { listTabs } from '../capture/cdp/tabs-list.ts';
import { describeWindow } from '../core/targets.ts';
import { ScreenrecError } from '../core/errors.ts';
import { allowWaitReporter, type CommandFn } from './types.ts';

const cmd: CommandFn = async (a) => {
  const kind = a.positionals[0];
  if (kind === 'displays') {
    mac.assertMac(); const displays = await mac.listDisplays();
    return { ok: true, text: displays.map((d, i) => `${i + 1}: ${d.name} ${d.width}x${d.height} pt @${d.scale}x at ${d.x},${d.y}${d.main ? ' (main)' : ''}`).join('\n'), displays };
  }
  if (kind === 'windows') {
    mac.assertMac(); const windows = (await mac.listWindows()).sort((x, y) => x.z - y.z);
    return { ok: true, text: windows.map(describeWindow).join('\n'), windows };
  }
  if (kind === 'tabs') {
    const warnings: string[] = [];
    const tabs = await listTabs((await resolveEndpoint({ cdp: a.values.cdp as string | undefined, onWaiting: allowWaitReporter(a, warnings) })).wsUrl);
    return { ok: true, text: tabs.map((t) => `${t.title} (${t.url})`).join('\n'), tabs, ...(warnings.length ? { warnings } : {}) };
  }
  throw new ScreenrecError('E_BAD_ARGS', `Unknown list "${kind ?? ''}"`, 'Use: screenrec list windows | displays | tabs');
};
export default cmd;

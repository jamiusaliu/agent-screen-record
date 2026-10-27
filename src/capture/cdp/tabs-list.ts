import { CdpClient } from './client.ts';

export async function listTabs(wsUrl: string) {
  const c = await CdpClient.connect(wsUrl);
  try {
    const { targetInfos } = await c.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page').map(({ targetId, url, title }) => ({ targetId, url, title }));
  } finally { c.close(); }
}

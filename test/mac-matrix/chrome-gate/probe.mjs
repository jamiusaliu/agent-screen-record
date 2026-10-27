// Usage: node probe.mjs <ws-browser-url> <seconds>
// Opens the colour page in a new background tab, screencasts it, counts distinct colours.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [wsUrl, secs = '4'] = process.argv.slice(2);
const page = new URL('../../fixtures/colour-page.html', import.meta.url).href;
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const msg = { id: ++id, method, params }; if (sessionId) msg.sessionId = sessionId;
  pending.set(msg.id, { res, rej }); ws.send(JSON.stringify(msg));
});
const colours = new Set(); let frames = 0; let done = false;
const lastFrame = path.join(os.tmpdir(), 'screenrec-gate-last.jpg');
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === 'Page.screencastFrame' && !done) {
    frames++;
    send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, m.sessionId).catch(() => {});
    const buf = Buffer.from(m.params.data, 'base64');
    // Reading pixels from the JPEG is unreliable; ask the page for its background on each frame
    // (cheap and exact). Value format is the computed-style shorthand, e.g. "rgb(255, 0, 0)".
    try {
      const r = await send('Runtime.evaluate', { expression: 'document.body.style.background' }, m.sessionId);
      if (!done) { colours.add(r.result.value); fs.writeFileSync(lastFrame, buf); }
    } catch { /* target closing; ignore */ }
  }
};
ws.onopen = async () => {
  const { targetId } = await send('Target.createTarget', { url: page, background: true });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  await send('Page.startScreencast', { format: 'jpeg', quality: 80 }, sessionId);
  setTimeout(async () => {
    done = true;
    await send('Page.stopScreencast', {}, sessionId);
    await send('Target.closeTarget', { targetId });
    console.log(JSON.stringify({ frames, distinctColours: colours.size }));
    process.exit(colours.size >= 4 ? 0 : 2);
  }, Number(secs) * 1000);
};
ws.onerror = (e) => { console.error('ws error', e.message ?? e); process.exit(1); };

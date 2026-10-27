import fs from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CdpClient } from './client.ts';
import { TabTracker, type TabMode, type TabInfo } from './tabs.ts';
import { framesDue, FrameHolder, outputSize, encoderArgs, NO_FRAMES_EXIT, ENCODER_FAILED_EXIT } from './pacer.ts';
import { appendMark } from '../../core/sidecar.ts';
import { errorJson, ScreenrecError } from '../../core/errors.ts';
import { readJsonLine } from '../stdin-line.ts';

const DEBUG_FIX = 'Run "screenrec doctor", then retry with SCREENREC_DEBUG=1.';
import { ffmpegBin } from '../../edit/ffmpeg.ts';

export interface WorkerConfig { wsUrl: string; mode: TabMode; pattern?: string; out: string; fps: number; maxSeconds: number; marksFile: string; t0Ms: number }

type TargetInfo = { targetId: string; type: string; url: string; title: string };
const isPage = (t: TargetInfo) => t.type === 'page';
const info = (t: TargetInfo): TabInfo => ({ targetId: t.targetId, url: t.url, title: t.title });

const DEBUG = process.env.SCREENREC_DEBUG === '1';
const trace = (msg: string) => { if (DEBUG) process.stderr.write(`[worker ${new Date().toISOString()}] ${msg}\n`); };

export async function runWorker(cfg: WorkerConfig): Promise<number> {
  const cdp = await CdpClient.connect(cfg.wsUrl);
  const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
  const tracker = new TabTracker(cfg.mode, cfg.pattern, targetInfos.filter(isPage).map(info));
  const holder = new FrameHolder();
  let session: { targetId: string; sessionId: string } | null = null;
  let size: { width: number; height: number } | null = null;
  let ffmpeg: ChildProcessWithoutNullStreams | null = null;
  let exited: Promise<number> = new Promise(() => {});
  let encStderr: string[] = [];
  let skipped = 0;
  let written = 0;
  let stopping = false;
  const mark = (text: string) => appendMark(cfg.marksFile, { t: Math.round(Date.now() - cfg.t0Ms) / 1000, text });

  cdp.on('Page.screencastFrame', (p, sessionId) => {
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId).catch(() => {});
    if (sessionId === session?.sessionId) holder.set(Buffer.from(p.data, 'base64'));
  });

  async function detach() {
    if (!session) return;
    const s = session; session = null;
    trace(`detach begin ${s.targetId}`);
    // short timeouts: the tab may be closing, and a closing tab can leave calls unanswered
    await cdp.send('Page.stopScreencast', {}, s.sessionId, 3000).catch(() => {});
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, s.sessionId, 3000).catch(() => {});
    await cdp.send('Target.detachFromTarget', { sessionId: s.sessionId }, undefined, 3000).catch(() => {});
    trace(`detach end ${s.targetId}`);
  }

  async function attach(targetId: string) {
    trace(`attach begin ${targetId}`);
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }, undefined, 5000);
    await cdp.send('Page.enable', {}, sessionId, 5000);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId, 5000);
    if (!size) {
      const m = await cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, sessionId, 5000);
      const dpr = (await cdp.send<{ result: { value: number } }>('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }, sessionId, 5000)).result.value || 1;
      size = outputSize(m.cssVisualViewport.clientWidth, m.cssVisualViewport.clientHeight, dpr);
    }
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 }, sessionId, 5000);
    session = { targetId, sessionId };
    trace(`attach end ${targetId}`);
    mark(`switched to tab: ${tracker.label(targetId)}`);
  }

  let switching = Promise.resolve();
  function reconcile() {
    switching = switching.then(async () => {
      if (stopping) return;
      const want = tracker.current();
      trace(`reconcile want=${want} have=${session?.targetId ?? null}`);
      if (want === (session?.targetId ?? null)) return;
      await detach();
      if (want) await attach(want).catch(() => { /* tab vanished while attaching; next event reconciles */ });
    });
  }

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  cdp.on('Target.targetCreated', (p) => { trace(`targetCreated ${p.targetInfo.targetId} ${p.targetInfo.type}`); if (isPage(p.targetInfo)) { tracker.created(info(p.targetInfo)); reconcile(); } });
  cdp.on('Target.targetInfoChanged', (p) => { if (isPage(p.targetInfo)) { tracker.changed(info(p.targetInfo)); reconcile(); } });
  cdp.on('Target.targetDestroyed', (p) => { trace(`targetDestroyed ${p.targetId}`); tracker.destroyed(p.targetId); reconcile(); });
  reconcile();
  trace('ready');
  process.stdout.write('ready\n');

  // follow mode: notice when the agent brings one of its own older tabs to the front.
  // Re-arming timeout (never overlapping polls); never moves away from a tab that is still visible.
  async function isVisible(id: string): Promise<boolean> {
    let sessionId: string | null = null;
    try {
      sessionId = (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: id, flatten: true }, undefined, 5000)).sessionId;
      const r = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sessionId, 5000);
      return r.result.value === 'visible';
    } catch { return false; /* tab closed meanwhile */ }
    finally { if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }, undefined, 3000).catch(() => {}); }
  }
  let pollTimer: NodeJS.Timeout | null = null;
  const pollVisibility = async () => {
    try {
      const cur = session?.targetId;
      if (!stopping && !(cur && await isVisible(cur))) {
        for (const id of tracker.agentTabs()) {
          if (stopping) break;
          if (id === cur) continue;
          if (await isVisible(id)) { tracker.activated(id); reconcile(); break; }
        }
      }
    } finally { if (!stopping) pollTimer = setTimeout(pollVisibility, 1000); }
  };
  if (cfg.mode === 'follow') pollTimer = setTimeout(pollVisibility, 1000);

  const tick = setInterval(() => {
    const frame = holder.get();
    if (!frame || !size) return;
    if (!ffmpeg) {
      const enc = spawn(ffmpegBin(), encoderArgs(cfg.out, cfg.fps, size));
      ffmpeg = enc;
      enc.stdin.on('error', () => {});
      enc.stderr.on('data', (d) => { encStderr = [...encStderr, ...String(d).split('\n').filter(Boolean)].slice(-15); });
      exited = new Promise<number>((r) => { enc.on('error', () => r(-1)); enc.on('exit', (c) => r(c ?? -1)); });
    }
    // backpressure: skip this tick; framesDue catches the timeline up once ffmpeg drains
    if (ffmpeg.stdin.writableNeedDrain) { skipped++; return; }
    const n = framesDue(cfg.t0Ms, Date.now(), cfg.fps, written);
    for (let i = 0; i < n; i++) ffmpeg.stdin.write(frame);
    written += n;
  }, Math.round(1000 / cfg.fps));

  let signalled = false;
  const reason = await new Promise<string>((resolve) => {
    const onSignal = () => { if (signalled) return; signalled = true; resolve('signal'); };
    process.on('SIGINT', onSignal);   // stay registered so a second signal during finalise is swallowed
    process.on('SIGTERM', onSignal);
    process.stdin.on('data', (d) => { if (String(d).includes('stop')) resolve('stdin'); });
    process.stdin.resume();  // readJsonLine left it paused, holding any bytes sent with the config
    setTimeout(() => resolve('max'), cfg.maxSeconds * 1000).unref();
    cdp.onClose(() => resolve('browser-closed'));
    void (async () => { while (!ffmpeg && !stopping) await new Promise((r) => setTimeout(r, 50)); if (ffmpeg) { await exited; resolve('encoder-exited'); } })();
  });
  trace(`stop requested: ${reason}`);
  stopping = true;
  clearInterval(tick);
  if (pollTimer) clearTimeout(pollTimer);
  await switching.catch(() => {});
  trace('teardown: switching settled');
  await detach().catch(() => {});
  trace('teardown: detached');
  cdp.close();
  mark(`stopped: ${reason}${skipped ? ` (${skipped} ticks skipped for backpressure)` : ''}`);
  if (!ffmpeg) { fs.rmSync(cfg.out, { force: true }); return NO_FRAMES_EXIT; }
  const enc: ChildProcessWithoutNullStreams = ffmpeg;
  enc.stdin.end();
  const code = await exited;
  trace(`ffmpeg exit ${code}`);
  // Ctrl-C to the whole process group also interrupts ffmpeg, which finalises the file and exits 255
  const interrupted = signalled && code === 255 && fs.existsSync(cfg.out) && fs.statSync(cfg.out).size > 0;
  if (code !== 0 && !interrupted) {
    process.stderr.write(encStderr.join('\n') + '\n');
    return ENCODER_FAILED_EXIT;
  }
  return 0;
}

/** The first stdin line is the WorkerConfig (never argv: its wsUrl may hold the broker token); later lines may say "stop". */
export async function readConfigLine(input: NodeJS.ReadableStream = process.stdin): Promise<WorkerConfig> {
  try { return await readJsonLine<WorkerConfig>(input); }
  catch (e) { throw new ScreenrecError('E_BAD_ARGS', `The tab recorder could not read its config: ${(e as Error).message}`, DEBUG_FIX); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  readConfigLine().then(runWorker).then((code) => process.exit(code), (e) => {
    // one JSON line so the caller can show the fix text
    process.stderr.write(JSON.stringify(errorJson(e)) + '\n'); process.exit(1);
  });
}

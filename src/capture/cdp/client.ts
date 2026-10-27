import { ScreenrecError } from '../../core/errors.ts';
import { assertLoopback, redactUrl } from './endpoint.ts';

type Handler = (params: any, sessionId?: string) => void;

export class CdpClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string; sessionId?: string }>();
  private handlers = new Map<string, Set<Handler>>();
  private closeHandlers: (() => void)[] = [];
  private closed = false;

  private constructor(private ws: WebSocket) {
    // A destroyed session never answers its in-flight calls; fail them instead of hanging.
    this.on('Target.detachedFromTarget', (p) => this.rejectSession(p?.sessionId, 'session detached'));
    this.on('Inspector.detached', (_p, sessionId) => this.rejectSession(sessionId, 'session detached'));
  }

  private rejectSession(sessionId: string | undefined, why: string): void {
    if (!sessionId) return;
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) { this.pending.delete(id); p.reject(new Error(`${p.method}: ${why}`)); }
    }
  }

  static async connect(wsUrl: string, Impl: typeof WebSocket = WebSocket, timeoutMs = 15000): Promise<CdpClient> {
    assertLoopback(wsUrl);
    return new Promise((resolve, reject) => {
      const ws = new Impl(wsUrl);
      const client = new CdpClient(ws);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new ScreenrecError('E_CDP_UNAVAILABLE', `Timed out connecting to ${redactUrl(wsUrl)}`,
          "Click Allow in Chrome's remote-debugging dialog (chrome://inspect/#remote-debugging), then retry."));
      }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(client); };
      ws.onerror = () => { clearTimeout(timer); reject(new ScreenrecError('E_CDP_UNAVAILABLE', `Could not connect to ${redactUrl(wsUrl)}`,
        'Chrome may have closed, or you declined its permission dialog. Re-enable chrome://inspect/#remote-debugging and retry.')); };
      ws.onmessage = (e: MessageEvent) => client.dispatch(String(e.data));
      ws.onclose = () => client.handleClose();
    });
  }

  private dispatch(raw: string): void {
    let m: { id?: number; result?: any; error?: { message: string }; method?: string; params?: any; sessionId?: string };
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
      return;
    }
    if (m.method) for (const h of this.handlers.get(m.method) ?? []) h(m.params, m.sessionId);
  }

  private handleClose(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
    this.pending.clear();
    for (const h of this.closeHandlers) h();
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs?: number): Promise<T> {
    if (this.closed || (this.ws.readyState !== undefined && this.ws.readyState !== 1)) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this.nextId;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = { resolve: (v: any) => { clearTimeout(timer); resolve(v); }, reject: (e: Error) => { clearTimeout(timer); reject(e); } };
      this.pending.set(id, { ...done, method, sessionId });
      if (timeoutMs) timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: timed out after ${timeoutMs} ms`)); }, timeoutMs);
      try { this.ws.send(JSON.stringify(msg)); } catch (e) { this.pending.delete(id); reject(e as Error); }
    });
  }

  on(method: string, fn: Handler): () => void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(fn);
    return () => this.handlers.get(method)!.delete(fn);
  }

  onClose(fn: () => void): void { this.closeHandlers.push(fn); }
  close(): void { this.ws.close(); }
}

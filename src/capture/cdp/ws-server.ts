// Minimal RFC 6455 WebSocket server: text messages, client masking, fragmentation,
// ping/pong and the close handshake. Enough for CDP; no extensions, no subprotocols.
import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';

export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa } as const;
export const DEFAULT_MAX_PAYLOAD = 256 * 1024 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const EMPTY = Buffer.alloc(0);

export class WsError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

export function encodeFrame(opcode: number, payload: Buffer, o: { fin?: boolean; mask?: Buffer } = {}): Buffer {
  const len = payload.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const maskLen = o.mask ? 4 : 0;
  const out = Buffer.allocUnsafe(2 + ext + maskLen + len);
  out[0] = ((o.fin ?? true) ? 0x80 : 0) | (opcode & 0x0f);
  out[1] = (o.mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  if (ext === 2) out.writeUInt16BE(len, 2);
  if (ext === 8) out.writeBigUInt64BE(BigInt(len), 2);
  const at = 2 + ext + maskLen;
  if (o.mask) {
    o.mask.copy(out, 2 + ext, 0, 4);
    for (let i = 0; i < len; i++) out[at + i] = payload[i] ^ o.mask[i & 3];
  } else payload.copy(out, at);
  return out;
}

type Header = { fin: boolean; rsv: number; opcode: number; mask: Buffer | null; len: number; headerLen: number };

function parseHeader(b: Buffer, maxPayload: number): Header | null {
  if (b.length < 2) return null;
  const masked = (b[1] & 0x80) !== 0;
  const l7 = b[1] & 0x7f;
  const ext = l7 === 126 ? 2 : l7 === 127 ? 8 : 0;
  const headerLen = 2 + ext + (masked ? 4 : 0);
  // the declared length is checked as soon as it is readable, before any payload is buffered
  if (b.length < 2 + ext) return null;
  let len = l7;
  if (ext === 2) len = b.readUInt16BE(2);
  if (ext === 8) {
    const big = b.readBigUInt64BE(2);
    if (big > BigInt(maxPayload)) throw new WsError(1009, 'message too big');
    len = Number(big);
  }
  if (len > maxPayload) throw new WsError(1009, 'message too big');
  if (b.length < headerLen) return null;
  return { fin: (b[0] & 0x80) !== 0, rsv: b[0] & 0x70, opcode: b[0] & 0x0f, mask: masked ? Buffer.from(b.subarray(2 + ext, 2 + ext + 4)) : null, len, headerLen };
}

export type FrameKind = 'message' | 'ping' | 'pong' | 'close';

/** Incremental frame decoder. Throws WsError (with a close code) on protocol violations. */
export class FrameReader {
  private head: Buffer = EMPTY;
  private hdr: Header | null = null;
  private payload: Buffer = EMPTY;
  private got = 0;
  private fragments: Buffer[] | null = null;
  private fragmentBytes = 0;
  private halted = false;

  constructor(private o: { requireMask: boolean; maxPayload: number }, private emit: (kind: FrameKind, data: Buffer) => void) {}

  /** Stop decoding for good: nothing more is dispatched, even from a chunk already being fed. */
  halt(): void { this.halted = true; }

  feed(chunk: Buffer): void {
    let data = chunk;
    while (data.length > 0 && !this.halted) {
      if (!this.hdr) {
        const h = this.head.length ? Buffer.concat([this.head, data]) : data;
        const hdr = parseHeader(h, this.o.maxPayload);
        if (!hdr) { this.head = Buffer.from(h); return; }
        this.head = EMPTY;
        this.check(hdr);
        this.hdr = hdr; this.payload = Buffer.allocUnsafe(hdr.len); this.got = 0;
        data = h.subarray(hdr.headerLen);
        if (hdr.len === 0) { this.finish(); continue; }
      }
      const take = Math.min(data.length, this.payload.length - this.got);
      data.copy(this.payload, this.got, 0, take);
      this.got += take; data = data.subarray(take);
      if (this.got === this.payload.length) this.finish();
    }
  }

  private check(h: Header): void {
    if (h.rsv) throw new WsError(1002, 'reserved bits set (no extensions are negotiated)');
    if (h.opcode >= 0x8) {
      if (!h.fin) throw new WsError(1002, 'fragmented control frame');
      if (h.len > 125) throw new WsError(1002, 'control frame too long');
      if (h.opcode > OP.PONG) throw new WsError(1002, 'unknown opcode');
    } else if (h.opcode > OP.BINARY) throw new WsError(1002, 'unknown opcode');
    if (this.o.requireMask && !h.mask) throw new WsError(1002, 'client frames must be masked');
    // a fragmented message's total is checked as each header arrives, before its payload is buffered
    if (h.opcode === OP.CONT && this.fragments && this.fragmentBytes + h.len > this.o.maxPayload) throw new WsError(1009, 'message too big');
  }

  private finish(): void {
    const h = this.hdr!;
    const p = this.payload;
    this.hdr = null; this.payload = EMPTY;
    if (this.halted) return;
    if (h.mask) for (let i = 0; i < p.length; i++) p[i] ^= h.mask[i & 3];
    if (h.opcode === OP.CLOSE) return this.emit('close', p);
    if (h.opcode === OP.PING) return this.emit('ping', p);
    if (h.opcode === OP.PONG) return this.emit('pong', p);
    if (h.opcode === OP.CONT) {
      if (!this.fragments) throw new WsError(1002, 'continuation without a start frame');
    } else {
      if (this.fragments) throw new WsError(1002, 'new message inside a fragmented one');
      if (h.opcode === OP.BINARY) throw new WsError(1003, 'binary messages are not supported');
      if (h.fin) return this.emit('message', p);
      this.fragments = []; this.fragmentBytes = 0;
    }
    this.fragmentBytes += p.length;
    if (this.fragmentBytes > this.o.maxPayload) throw new WsError(1009, 'message too big');
    this.fragments.push(p);
    if (h.fin) { const m = Buffer.concat(this.fragments, this.fragmentBytes); this.fragments = null; this.emit('message', m); }
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** One accepted server-side connection. Sends unmasked frames, requires masked client frames. */
export class WsConnection {
  private messageHandlers: ((text: string) => void)[] = [];
  private closeHandlers: ((code: number) => void)[] = [];
  private closeSent = false;
  private done = false;
  private reader: FrameReader;

  constructor(private socket: Duplex, maxPayload: number) {
    this.reader = new FrameReader({ requireMask: true, maxPayload }, (kind, data) => this.onFrame(kind, data));
    socket.on('data', (d: Buffer) => {
      if (this.done) return;
      try { this.reader.feed(d); } catch (e) { this.fail(e instanceof WsError ? e.code : 1002); }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.finished(1006));
  }

  private onFrame(kind: FrameKind, data: Buffer): void {
    if (this.done || this.closeSent && kind === 'message') return;
    if (kind === 'message') {
      let text: string;
      try { text = utf8.decode(data); } catch { this.fail(1007); return; }
      for (const h of this.messageHandlers) h(text);
    } else if (kind === 'ping') this.write(OP.PONG, data);
    else if (kind === 'close') {
      const code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
      if (!this.closeSent) { this.closeSent = true; this.write(OP.CLOSE, data.length >= 2 ? data.subarray(0, 2) : EMPTY); }
      this.socket.end();
      this.finished(code);
    }
  }

  private write(op: number, payload: Buffer): void {
    if (this.socket.writable) this.socket.write(encodeFrame(op, payload));
  }

  private fail(code: number): void { this.reader.halt(); this.close(code); }

  private finished(code: number): void {
    if (this.done) return;
    this.done = true;
    for (const h of this.closeHandlers) h(code);
  }

  get isOpen(): boolean { return !this.done && !this.closeSent; }
  /** Bytes queued in the socket and not yet written to the kernel. */
  get bufferedAmount(): number { return (this.socket as unknown as { writableLength?: number }).writableLength ?? 0; }

  onMessage(fn: (text: string) => void): void { this.messageHandlers.push(fn); }
  onClose(fn: (code: number) => void): void { this.closeHandlers.push(fn); }

  send(text: string): void {
    if (!this.isOpen) return;
    this.write(OP.TEXT, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = ''): void {
    if (this.done) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const p = Buffer.alloc(2 + Buffer.byteLength(reason));
      p.writeUInt16BE(code, 0); p.write(reason, 2);
      this.write(OP.CLOSE, p);
    }
    // wait briefly for the peer's close reply, then drop the socket
    const t = setTimeout(() => this.socket.destroy(), 1000); t.unref();
    this.socket.end();
    this.finished(code);
  }
}

export interface WsServer {
  port: number;
  /** Stop listening; give open sockets up to graceMs to finish their close handshake, then drop them. */
  close(graceMs?: number): Promise<void>;
}

/** Always binds 127.0.0.1: there is deliberately no host option (test/security/no-network.test.ts). */
export async function createWsServer(o: {
  port?: number; maxPayload?: number;
  /** Return an HTTP status to refuse the upgrade, or null to accept. */
  verify?: (req: http.IncomingMessage) => number | null;
  onConnection: (conn: WsConnection, req: http.IncomingMessage) => void;
}): Promise<WsServer> {
  const sockets = new Set<Duplex>();
  const server = http.createServer((_req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('WebSocket only\n'); });
  const refuse = (socket: Duplex, status: number) => {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {});
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13'
      || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) { refuse(socket, 400); return; }
    const status = o.verify?.(req) ?? null;
    if (status !== null) { refuse(socket, status); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    (socket as unknown as { setNoDelay?: (b: boolean) => void }).setNoDelay?.(true);
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const conn = new WsConnection(socket, o.maxPayload ?? DEFAULT_MAX_PAYLOAD);
    o.onConnection(conn, req);
    if (head.length) socket.unshift(head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', () => resolve());
  });
  return {
    port: (server.address() as { port: number }).port,
    close: async (graceMs = 0) => {
      const stopped = new Promise<void>((r) => server.close(() => r()));
      if (graceMs > 0 && sockets.size) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, graceMs);
          const check = () => { if (sockets.size === 0) { clearTimeout(t); r(); } };
          for (const s of sockets) s.once('close', check);
          check();
        });
      }
      for (const s of sockets) s.destroy();
      await stopped;
    },
  };
}

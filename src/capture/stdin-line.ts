// Child processes get their config as one JSON line on stdin, never in argv: `ps` shows every
// user's argv on macOS, and the config can hold the broker token or Chrome's browser id.

/**
 * Reads the first line of `input` as JSON. Bytes after that line are pushed back and the stream is
 * left paused, so a later reader (for example a "stop" listener) still gets them after resume().
 */
export function readJsonLine<T = unknown>(input: NodeJS.ReadableStream): Promise<T> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => { input.off('data', onData); input.off('end', onEnd); };
    const onData = (d: Buffer | string) => {
      buf = Buffer.concat([buf, typeof d === 'string' ? Buffer.from(d) : d]);
      const nl = buf.indexOf(10);
      if (nl === -1) return;
      cleanup();
      input.pause();
      const rest = buf.subarray(nl + 1);
      if (rest.length) input.unshift(rest);
      try { resolve(JSON.parse(buf.subarray(0, nl).toString('utf8')) as T); }
      catch { reject(new Error('the config line on stdin is not valid JSON')); }
    };
    const onEnd = () => { cleanup(); reject(new Error('stdin ended before the config line')); };
    input.on('data', onData); input.on('end', onEnd);
  });
}

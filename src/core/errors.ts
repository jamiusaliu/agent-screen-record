export type ErrorCode =
  | 'E_BAD_ARGS' | 'E_PERMISSION' | 'E_NO_FFMPEG' | 'E_FFMPEG_FAILED'
  | 'E_TARGET_NOT_FOUND' | 'E_TARGET_AMBIGUOUS' | 'E_ALREADY_RECORDING'
  | 'E_NOT_RECORDING' | 'E_CDP_UNAVAILABLE' | 'E_REGION_SPANS_DISPLAYS'
  | 'E_HELPER_CRASHED' | 'E_NO_FRAMES' | 'E_UNSUPPORTED_PLATFORM';

export class ScreenrecError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly fix: string,
    public readonly candidates?: string[],
  ) {
    super(message);
    this.name = 'ScreenrecError';
  }
}

export interface ErrorJson {
  ok: false; code: ErrorCode; message: string; fix: string; candidates?: string[];
}

export function errorJson(err: unknown): ErrorJson {
  if (err instanceof ScreenrecError) {
    const j: ErrorJson = { ok: false, code: err.code, message: err.message, fix: err.fix };
    if (err.candidates) j.candidates = err.candidates;
    return j;
  }
  // Not a helper crash: an unexpected exception. The code stays for compatibility; the text says what it is.
  const message = `internal error: ${err instanceof Error ? err.message : String(err)}`;
  return { ok: false, code: 'E_HELPER_CRASHED', message, fix: 'This is a screenrec bug. Re-run with SCREENREC_DEBUG=1 and report the output.' };
}

// Command-line flags for the matrix runner. Pure, so it can be checked without touching the screen.
const KNOWN = new Set(['--auto-only', '--no-append', '--only']);

/** Returns { autoOnly, noAppend, only } or throws with a usage message. */
export function parseFlags(argv) {
  const f = { autoOnly: false, noAppend: false, only: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!KNOWN.has(a)) throw new Error(`Unknown flag "${a}". Use --auto-only, --no-append and --only <text>.`);
    if (a === '--auto-only') f.autoOnly = true;
    else if (a === '--no-append') f.noAppend = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--') || v.trim() === '') throw new Error('--only needs a scenario name fragment, e.g. --only "window moved".');
      if (f.only !== undefined) throw new Error('--only may be given once.');
      f.only = v; i++;
    }
  }
  return f;
}

/** One line counting each result kind, and whether the exit code treats it as a failure. */
export function summarise(results) {
  const count = {};
  for (const r of results) count[r.result] = (count[r.result] ?? 0) + 1;
  const failed = results.some((r) => r.result === 'FAIL' || r.result === 'MANUAL-FAIL');
  const open = (count.PENDING ?? 0) + (count.INCONCLUSIVE ?? 0);
  const parts = Object.entries(count).map(([k, v]) => `${v} ${k}`).join(', ') || 'no scenarios ran';
  const tail = failed ? 'Exit 1: at least one FAIL.'
    : open ? `Exit 0, but ${open} row(s) are PENDING or INCONCLUSIVE and are not evidence of a pass.` : 'Exit 0.';
  return { line: `Summary: ${parts}. ${tail}`, code: failed ? 1 : 0 };
}

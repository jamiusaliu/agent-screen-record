// Pure verdict helpers for the matrix runner, kept apart so unit tests can check them without a screen.

/** Parses AppleScript bounds output ("x1, y1, x2, y2") into four numbers. */
export function parseBounds(s) {
  const n = String(s).split(',').map((v) => Number(v.trim()));
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) throw new Error(`Bad bounds "${s}"`);
  return n;
}

/** True when bounds `outer` (x1, y1, x2, y2) fully contains bounds `inner`. */
export const contains = (outer, inner) =>
  outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];

/**
 * Covered Finder verdict. baseline: gray diff between two frames before the folder changes (must be near 0).
 * change: gray diff from the last pre-change frame to the end (must clearly exceed the baseline).
 * covered: whether the TextEdit cover contained the Finder window.
 */
export function coveredFinderVerdict({ baseline, change, covered }) {
  if (!covered) return { result: 'INCONCLUSIVE', why: 'the cover did not contain the Finder window' };
  if (!(baseline < 1)) return { result: 'INCONCLUSIVE', why: 'the window changed before the folder did' };
  if (change > 3 && change > 3 * baseline) return { result: 'PASS', why: 'the folder change shows while covered' };
  return { result: 'FAIL', why: 'no visible change after the folder changed' };
}

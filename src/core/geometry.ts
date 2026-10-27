import { ScreenrecError } from './errors.ts';

export interface Rect { x: number; y: number; width: number; height: number }
export interface Display { id: number; name: string; x: number; y: number; width: number; height: number; scale: number; main: boolean }

export function even(n: number): number {
  const f = Math.floor(n);
  return Math.max(2, f - (f % 2));
}

function describe(d: Display, i: number): string {
  return `${i + 1}: ${d.name} ${d.width}x${d.height}@${d.scale}x${d.main ? ' (main)' : ''}`;
}

export function resolveDisplay(displays: Display[], sel: string): Display {
  const s = sel.trim().toLowerCase();
  let found: Display | undefined;
  if (s === '') found = undefined;
  else if (s === 'main') found = displays.find((d) => d.main);
  else if (/^\d+$/.test(s)) found = displays[Number(s) - 1];
  else found = displays.find((d) => d.name.toLowerCase().includes(s));
  if (!found) {
    throw new ScreenrecError('E_TARGET_NOT_FOUND', `No display matches "${sel}"`,
      'Run "screenrec list displays" and pass main, a number or part of a name.', displays.map(describe));
  }
  return found;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function displayOfRect(displays: Display[], r: Rect): Display {
  let best = displays.find((d) => d.main) ?? displays[0];
  let bestArea = overlap(best, r);
  for (const d of displays) {
    const a = overlap(d, r);
    if (a > bestArea) { best = d; bestArea = a; }
  }
  return best;
}

export function regionToPixels(d: Display, region: Rect): Rect {
  const inside = region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
    region.x + region.width <= d.width && region.y + region.height <= d.height;
  if (!inside) {
    throw new ScreenrecError('E_REGION_SPANS_DISPLAYS',
      `Region ${region.x},${region.y},${region.width},${region.height} does not fit display "${d.name}" (${d.width}x${d.height} points)`,
      'Regions are measured in points from the top-left of the chosen display and must stay inside it.');
  }
  return {
    x: Math.round(region.x * d.scale), y: Math.round(region.y * d.scale),
    width: even(region.width * d.scale), height: even(region.height * d.scale),
  };
}

export function pixelSize(widthPt: number, heightPt: number, scale: number): { width: number; height: number } {
  return { width: even(widthPt * scale), height: even(heightPt * scale) };
}

import { clipBelow, shapeOutline, UZ, windowLines } from '../../core/floorplan/windows';
import { HouseWindow, ProjectSettings } from '../../core/model/types';
import { WindowPiece } from './building-model';

/** How far window glass stands proud of each face of its wall (ft). */
export const GLASS_PROUD = 1.5 / 12;

/**
 * Windows as glass slabs through their walls, cut off at `cut` (Floorplan mode cuts
 * the walls flat; everything above that goes too).
 */
export function buildWindows(windows: readonly HouseWindow[], settings: ProjectSettings, cut = Infinity): WindowPiece[] {
  const t = settings.wallThickness;
  const out: WindowPiece[] = [];
  for (const w of windows) {
    const outline = clipBelow(shapeOutline(w.shape), cut);
    if (outline.length < 3) continue;
    const { side, coord } = w.host;
    const inward = side === 'N' || side === 'W' ? 1 : -1;
    const bars = windowLines(w).bars.flatMap(([a, b]) => clipSegmentBelow(a, b, cut));
    out.push({
      kind: 'window',
      axis: side === 'N' || side === 'S' ? 'x' : 'y',
      across: coord + (inward * t) / 2,
      depth: t + 2 * GLASS_PROUD,
      outline,
      bars,
    });
  }
  return out;
}

function clipSegmentBelow(a: UZ, b: UZ, top: number): [UZ, UZ][] {
  if (a[1] > top && b[1] > top) return [];
  if (a[1] <= top && b[1] <= top) return [[a, b]];
  const t = (top - a[1]) / (b[1] - a[1]);
  const m: UZ = [a[0] + (b[0] - a[0]) * t, top];
  return [a[1] <= top ? [a, m] : [m, b]];
}

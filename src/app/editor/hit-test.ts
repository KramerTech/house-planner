import { SideSegment } from '../core/geometry/edges';
import { outwardSign, sideAxis, sideCoord, sideSpan } from '../core/geometry/rect';
import { SideRef } from '../core/geometry/side-resize';
import { Section, SIDES } from '../core/model/types';
import { Point, screenToWorld, Viewport, worldToScreen } from './viewport';

/** A draggable side of a section. */
export type SideHandle = SideRef;

/** Floor for the grab tolerance so lines stay grabbable when zoomed far out. */
const MIN_HIT_TOLERANCE_PX = 2;

/**
 * Pixel tolerance for grabbing lines: 1px less than half a 1 ft grid square, so a
 * grab always lands on the side of the nearest grid line and never reaches the next.
 */
export function hitTolerance(v: Viewport): number {
  return Math.max(MIN_HIT_TOLERANCE_PX, v.scale / 2 - 1);
}

/**
 * Distance (px) from a screen point to the screen-space line segment lying on
 * `coord` along an axis, spanning [from, to].
 */
function distanceToLine(
  v: Viewport,
  p: Point,
  vertical: boolean,
  coord: number,
  from: number,
  to: number,
): number {
  const a = worldToScreen(v, vertical ? { x: coord, y: from } : { x: from, y: coord });
  const b = worldToScreen(v, vertical ? { x: coord, y: to } : { x: to, y: coord });
  const along = vertical ? p.y : p.x;
  const lo = vertical ? a.y : a.x;
  const hi = vertical ? b.y : b.x;
  const across = vertical ? Math.abs(p.x - a.x) : Math.abs(p.y - a.y);
  const outside = along < lo ? lo - along : along > hi ? along - hi : 0;
  return Math.hypot(across, outside);
}

/**
 * Every section side within tolerance of the pointer, best first: nearest, then — for
 * coincident sides where two sections meet — the side of the section the pointer is
 * on. Corners yield one handle per axis; the editor picks by drag direction.
 */
export function sidesNear(sections: readonly Section[], v: Viewport, p: Point): SideHandle[] {
  const w = screenToWorld(v, p);
  const tolerance = hitTolerance(v);
  const hits: { handle: SideHandle; dist: number; inside: boolean }[] = [];
  for (const s of sections) {
    for (const side of SIDES) {
      const span = sideSpan(s.rect, side);
      const coord = sideCoord(s.rect, side);
      const vertical = side === 'E' || side === 'W';
      const dist = distanceToLine(v, p, vertical, coord, span.lo, span.hi);
      if (dist > tolerance) continue;
      const pointerAxis = sideAxis(side) === 'x' ? w.x : w.y;
      const inside = (pointerAxis - coord) * outwardSign(side) <= 0;
      hits.push({ handle: { sectionId: s.id, side }, dist, inside });
    }
  }
  return hits
    .sort((a, b) => a.dist - b.dist || Number(b.inside) - Number(a.inside))
    .map((h) => h.handle);
}

/** The closest free segment within tolerance of the pointer, if any. */
export function freeSegmentNear(segments: readonly SideSegment[], v: Viewport, p: Point): SideSegment | null {
  let best: SideSegment | null = null;
  let bestDist = hitTolerance(v);
  for (const seg of segments) {
    const vertical = seg.side === 'E' || seg.side === 'W';
    const dist = distanceToLine(v, p, vertical, seg.coord, seg.from, seg.to);
    if (dist <= bestDist) {
      best = seg;
      bestDist = dist;
    }
  }
  return best;
}

import { Rect, Side } from '../model/types';

/** Closed numeric interval [lo, hi]. */
export interface Interval {
  lo: number;
  hi: number;
}

export const x0 = (r: Rect) => r.x;
export const x1 = (r: Rect) => r.x + r.w;
export const y0 = (r: Rect) => r.y;
export const y1 = (r: Rect) => r.y + r.d;

/** Axis a side moves along when dragged: E/W sides move in x, N/S sides move in y. */
export function sideAxis(side: Side): 'x' | 'y' {
  return side === 'E' || side === 'W' ? 'x' : 'y';
}

/** +1 if moving the side outward increases its coordinate, else -1. */
export function outwardSign(side: Side): 1 | -1 {
  return side === 'E' || side === 'S' ? 1 : -1;
}

export function oppositeSide(side: Side): Side {
  return ({ N: 'S', S: 'N', E: 'W', W: 'E' } as const)[side];
}

/** The fixed coordinate of the line a side lies on. */
export function sideCoord(r: Rect, side: Side): number {
  switch (side) {
    case 'N':
      return y0(r);
    case 'S':
      return y1(r);
    case 'W':
      return x0(r);
    case 'E':
      return x1(r);
  }
}

/** Extent of the side along its own line (x-range for N/S, y-range for E/W). */
export function sideSpan(r: Rect, side: Side): Interval {
  return sideAxis(side) === 'y' ? { lo: x0(r), hi: x1(r) } : { lo: y0(r), hi: y1(r) };
}

/** Span of a rect along the axis perpendicular to `axis`. */
export function spanAcross(r: Rect, axis: 'x' | 'y'): Interval {
  return axis === 'x' ? { lo: y0(r), hi: y1(r) } : { lo: x0(r), hi: x1(r) };
}

/** Returns a copy of `r` with the given side moved to coordinate `v` (opposite side fixed). */
export function withSideAt(r: Rect, side: Side, v: number): Rect {
  switch (side) {
    case 'N':
      return { ...r, y: v, d: y1(r) - v };
    case 'S':
      return { ...r, d: v - r.y };
    case 'W':
      return { ...r, x: v, w: x1(r) - v };
    case 'E':
      return { ...r, w: v - r.x };
  }
}

/** Length of the overlap of two intervals (0 if disjoint or touching). */
export function overlapLength(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo));
}

/** True if open intervals intersect (touching at an endpoint does not count). */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.lo < b.hi && b.lo < a.hi;
}

/** True if the rect interiors intersect with positive area. */
export function interiorsOverlap(a: Rect, b: Rect): boolean {
  return x0(a) < x1(b) && x0(b) < x1(a) && y0(a) < y1(b) && y0(b) < y1(a);
}

/** Length of edge shared between two rects (0 if they are not edge-adjacent). */
export function sharedEdgeLength(a: Rect, b: Rect): number {
  if (x1(a) === x0(b) || x1(b) === x0(a)) {
    return overlapLength({ lo: y0(a), hi: y1(a) }, { lo: y0(b), hi: y1(b) });
  }
  if (y1(a) === y0(b) || y1(b) === y0(a)) {
    return overlapLength({ lo: x0(a), hi: x1(a) }, { lo: x0(b), hi: x1(b) });
  }
  return 0;
}

export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.d / 2 };
}

export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, x0(r));
    minY = Math.min(minY, y0(r));
    maxX = Math.max(maxX, x1(r));
    maxY = Math.max(maxY, y1(r));
  }
  return { x: minX, y: minY, w: maxX - minX, d: maxY - minY };
}

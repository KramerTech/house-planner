import { Side } from '../model/types';

/**
 * Axis-aligned rectangle-union utilities for floor plans. Regions are unions of
 * boxes; operations work on the compressed grid of the boxes' coordinates, so they
 * are exact for the axis-aligned shapes the planner deals in.
 */

/** Axis-aligned box in plan space (x east, y south). Structurally a PlanRect. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A straight piece of a region's outline. `side` is the direction the face looks
 * out of the region (N = the region lies to the south of it).
 */
export interface BoundarySeg {
  side: Side;
  /** The line's fixed coordinate: y for N/S faces, x for E/W faces. */
  coord: number;
  /** Extent along the line. */
  from: number;
  to: number;
}

export const EPS = 1e-6;

export function uniqueSorted(values: number[], eps = EPS): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((v, i) => i === 0 || v - sorted[i - 1] > eps);
}

export const boxArea = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

export const pointInBox = (b: Box, x: number, y: number, eps = 0) =>
  x > b.x0 - eps && x < b.x1 + eps && y > b.y0 - eps && y < b.y1 + eps;

export const pointIn = (boxes: readonly Box[], x: number, y: number, eps = 0) =>
  boxes.some((b) => pointInBox(b, x, y, eps));

/** True if `r` (positive area) lies within the union of the disjoint `boxes`. */
export function covers(boxes: readonly Box[], r: Box): boolean {
  const area = boxArea(r);
  if (area <= 0) return false;
  let sum = 0;
  for (const b of boxes) sum += overlapArea(b, r);
  return sum >= area - 1e-6 * Math.max(1, area);
}

/**
 * Cells of the compressed grid of `lineBoxes` (plus any extra grid lines) whose
 * centers satisfy `keep`, merged into horizontal runs. The result is disjoint.
 */
export function cellsWhere(
  lineBoxes: readonly Box[],
  keep: (x: number, y: number) => boolean,
  extraXs: number[] = [],
  extraYs: number[] = [],
): Box[] {
  const xs = uniqueSorted([...lineBoxes.flatMap((b) => [b.x0, b.x1]), ...extraXs]);
  const ys = uniqueSorted([...lineBoxes.flatMap((b) => [b.y0, b.y1]), ...extraYs]);
  const out: Box[] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    const cy = (ys[j] + ys[j + 1]) / 2;
    let start = -1;
    for (let i = 0; i + 1 <= xs.length; i++) {
      const inside = i + 1 < xs.length && keep((xs[i] + xs[i + 1]) / 2, cy);
      if (inside && start < 0) start = i;
      if (!inside && start >= 0) {
        out.push({ x0: xs[start], x1: xs[i], y0: ys[j], y1: ys[j + 1] });
        start = -1;
      }
    }
  }
  return mergeRows(out);
}

/** Merges vertically adjacent runs with identical x-extent. */
function mergeRows(runs: Box[]): Box[] {
  const out: Box[] = [];
  for (const r of runs) {
    const above = out.find((o) => Math.abs(o.x0 - r.x0) < EPS && Math.abs(o.x1 - r.x1) < EPS && Math.abs(o.y1 - r.y0) < EPS);
    if (above) above.y1 = r.y1;
    else out.push({ ...r });
  }
  return out;
}

/** The union of possibly-overlapping boxes as disjoint boxes. */
export function union(boxes: readonly Box[]): Box[] {
  return cellsWhere(boxes, (x, y) => pointIn(boxes, x, y));
}

export function unionArea(boxes: readonly Box[]): number {
  return union(boxes).reduce((a, b) => a + boxArea(b), 0);
}

/** The union grown by `r` on every side (Minkowski sum with a 2r square). */
export function dilate(boxes: readonly Box[], r: number): Box[] {
  return union(boxes.map((b) => ({ x0: b.x0 - r, x1: b.x1 + r, y0: b.y0 - r, y1: b.y1 + r })));
}

/**
 * The union shrunk by `t` on every side (Minkowski erosion by a 2t square): what's
 * left inside walls of thickness `t` built along the whole outline. Inside corners
 * lose their t×t corner square too, exactly as the walls meeting there leave it.
 */
export function erode(boxes: readonly Box[], t: number): Box[] {
  const u = union(boxes);
  if (t <= 0) return u;
  const xs = uniqueSorted(u.flatMap((b) => [b.x0, b.x1]));
  const ys = uniqueSorted(u.flatMap((b) => [b.y0, b.y1]));
  const shiftedXs = xs.flatMap((x) => [x - t, x + t]);
  const shiftedYs = ys.flatMap((y) => [y - t, y + t]);
  return cellsWhere(
    u,
    (x, y) => covers(u, { x0: x - t, x1: x + t, y0: y - t, y1: y + t }),
    shiftedXs,
    shiftedYs,
  );
}

/** The outline of a union of boxes, as maximal straight faces. */
export function boundary(boxes: readonly Box[]): BoundarySeg[] {
  const u = union(boxes);
  const xs = uniqueSorted(u.flatMap((b) => [b.x0, b.x1]));
  const ys = uniqueSorted(u.flatMap((b) => [b.y0, b.y1]));
  const filled = (i: number, j: number) =>
    i >= 0 && j >= 0 && i + 1 < xs.length && j + 1 < ys.length && pointIn(u, (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2);

  const raw: BoundarySeg[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      if (!filled(i, j)) continue;
      if (!filled(i, j - 1)) raw.push({ side: 'N', coord: ys[j], from: xs[i], to: xs[i + 1] });
      if (!filled(i, j + 1)) raw.push({ side: 'S', coord: ys[j + 1], from: xs[i], to: xs[i + 1] });
      if (!filled(i - 1, j)) raw.push({ side: 'W', coord: xs[i], from: ys[j], to: ys[j + 1] });
      if (!filled(i + 1, j)) raw.push({ side: 'E', coord: xs[i + 1], from: ys[j], to: ys[j + 1] });
    }
  }
  raw.sort((a, b) => a.side.localeCompare(b.side) || a.coord - b.coord || a.from - b.from);
  const out: BoundarySeg[] = [];
  for (const s of raw) {
    const prev = out.at(-1);
    if (prev && prev.side === s.side && Math.abs(prev.coord - s.coord) < EPS && Math.abs(prev.to - s.from) < EPS) {
      prev.to = s.to;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** True if (x, y) lies on the given face (within `eps`). */
export function onSeg(s: BoundarySeg, x: number, y: number, eps = 1e-4): boolean {
  const horizontal = s.side === 'N' || s.side === 'S';
  const [c, a] = horizontal ? [y, x] : [x, y];
  return Math.abs(c - s.coord) < eps && a > s.from - eps && a < s.to + eps;
}

/** The faces (from `segs`) a point lies on. */
export const segsAt = (segs: readonly BoundarySeg[], x: number, y: number, eps = 1e-4) =>
  segs.filter((s) => onSeg(s, x, y, eps));

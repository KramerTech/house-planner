import { PlanPoint, PlanRect, PrismPiece } from './building-model';

/**
 * Cutting operations on rectangular prism pieces: trimming them to a height range
 * (Floorplan mode's flat cut) and punching openings (doors) through them. Pieces
 * come out as more rectangular prisms; merged-prisms.ts later fuses coplanar faces
 * back together, so the splits leave no seams.
 */

const EPS = 1e-6;

/** A box-shaped hole through walls: a plan rectangle from `bottom` to `top`. */
export interface Opening {
  box: PlanRect;
  bottom: number;
  top: number;
}

interface Plane {
  c: number;
  gx: number;
  gy: number;
}

const at = (pl: Plane, x: number, y: number) => pl.c + pl.gx * x + pl.gy * y;

export function footprintRect(piece: PrismPiece): PlanRect {
  const xs = piece.footprint.map((p) => p.x);
  const ys = piece.footprint.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** The plane through a footprint's corner heights (they're always coplanar here). */
function planeOf(f: PrismPiece['footprint'], h: readonly number[]): Plane {
  const d1x = f[1].x - f[0].x;
  const d1y = f[1].y - f[0].y;
  const d2x = f[2].x - f[0].x;
  const d2y = f[2].y - f[0].y;
  const det = d1x * d2y - d1y * d2x;
  if (Math.abs(det) < EPS) return { c: h[0], gx: 0, gy: 0 };
  const gx = ((h[1] - h[0]) * d2y - d1y * (h[2] - h[0])) / det;
  const gy = (d1x * (h[2] - h[0]) - (h[1] - h[0]) * d2x) / det;
  return { c: h[0] - gx * f[0].x - gy * f[0].y, gx, gy };
}

/** A prism over a plan rectangle with heights from two height functions. */
export function rectPrism(
  base: Pick<PrismPiece, 'kind' | 'sectionId' | 'color' | 'turn'>,
  r: PlanRect,
  bottomAt: (p: PlanPoint) => number,
  topAt: (p: PlanPoint) => number,
): PrismPiece {
  const footprint: PrismPiece['footprint'] = [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
  const piece: PrismPiece = {
    kind: base.kind,
    sectionId: base.sectionId,
    footprint,
    bottom: footprint.map(bottomAt) as PrismPiece['bottom'],
    top: footprint.map(topAt) as PrismPiece['top'],
  };
  if (base.color) piece.color = base.color;
  if (base.turn) piece.turn = base.turn;
  return piece;
}

/** Where a plane reaches height h inside [lo, hi] along each axis it varies in. */
function crossings(pl: Plane, h: number, r: PlanRect): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  if (!Number.isFinite(h)) return { xs, ys };
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  if (Math.abs(pl.gx) > EPS) {
    const x = (h - pl.c - pl.gy * cy) / pl.gx;
    if (x > r.x0 + EPS && x < r.x1 - EPS) xs.push(x);
  }
  if (Math.abs(pl.gy) > EPS) {
    const y = (h - pl.c - pl.gx * cx) / pl.gy;
    if (y > r.y0 + EPS && y < r.y1 - EPS) ys.push(y);
  }
  return { xs, ys };
}

const sortedUnique = (v: number[]) =>
  [...v].sort((a, b) => a - b).filter((x, i, arr) => i === 0 || x - arr[i - 1] > EPS);

/**
 * The part of a prism between heights `lo` and `hi`. The footprint is split where
 * the top or bottom crosses those heights, so every resulting piece stays planar.
 */
export function clampVertical(piece: PrismPiece, lo: number, hi: number): PrismPiece[] {
  if (Math.min(...piece.bottom) >= lo - EPS && Math.max(...piece.top) <= hi + EPS) return [piece];
  if (Math.max(...piece.top) <= lo + EPS || Math.min(...piece.bottom) >= hi - EPS) return [];
  const r = footprintRect(piece);
  const top = planeOf(piece.footprint, piece.top);
  const bottom = planeOf(piece.footprint, piece.bottom);
  const cuts = [top, bottom].flatMap((pl) => [lo, hi].map((h) => crossings(pl, h, r)));
  const xs = sortedUnique([r.x0, r.x1, ...cuts.flatMap((c) => c.xs)]);
  const ys = sortedUnique([r.y0, r.y1, ...cuts.flatMap((c) => c.ys)]);

  const out: PrismPiece[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cell = { x0: xs[i], x1: xs[i + 1], y0: ys[j], y1: ys[j + 1] };
      const b = (p: PlanPoint) => Math.max(at(bottom, p.x, p.y), lo);
      const t = (p: PlanPoint) => Math.min(at(top, p.x, p.y), hi);
      const mid = { x: (cell.x0 + cell.x1) / 2, y: (cell.y0 + cell.y1) / 2 };
      if (t(mid) - b(mid) <= EPS) continue;
      out.push(rectPrism(piece, cell, b, (p) => Math.max(t(p), b(p))));
    }
  }
  return out;
}

/** Punches each opening through every piece it overlaps. */
export function cutOpenings(pieces: readonly PrismPiece[], openings: readonly Opening[]): PrismPiece[] {
  let current = [...pieces];
  for (const o of openings) {
    const next: PrismPiece[] = [];
    for (const piece of current) next.push(...cutOne(piece, o));
    current = next;
  }
  return current;
}

function cutOne(piece: PrismPiece, o: Opening): PrismPiece[] {
  const r = footprintRect(piece);
  const ox0 = Math.max(r.x0, o.box.x0);
  const ox1 = Math.min(r.x1, o.box.x1);
  const oy0 = Math.max(r.y0, o.box.y0);
  const oy1 = Math.min(r.y1, o.box.y1);
  if (ox1 - ox0 <= EPS || oy1 - oy0 <= EPS) return [piece];
  if (o.top <= Math.min(...piece.bottom) + EPS || o.bottom >= Math.max(...piece.top) - EPS) return [piece];

  const top = planeOf(piece.footprint, piece.top);
  const bottom = planeOf(piece.footprint, piece.bottom);
  const xs = sortedUnique([r.x0, ox0, ox1, r.x1]);
  const ys = sortedUnique([r.y0, oy0, oy1, r.y1]);
  const out: PrismPiece[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cell = { x0: xs[i], x1: xs[i + 1], y0: ys[j], y1: ys[j + 1] };
      const sub = rectPrism(piece, cell, (p) => at(bottom, p.x, p.y), (p) => at(top, p.x, p.y));
      const inside = cell.x0 >= ox0 - EPS && cell.x1 <= ox1 + EPS && cell.y0 >= oy0 - EPS && cell.y1 <= oy1 + EPS;
      if (!inside) out.push(sub);
      else out.push(...clampVertical(sub, -Infinity, o.bottom), ...clampVertical(sub, o.top, Infinity));
    }
  }
  return out;
}

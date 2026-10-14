import { Vector3 } from 'three';
import { PlanPoint, PrismPiece, RoofPiece } from '../build/building-model';
import { roofHeightOnPlane } from '../build/building-builder';
import { GeometryAccumulator } from './geometry-accumulator';

/** Plan point + height → world position (plan y maps to world Z, height to world Y). */
export function toWorld(p: PlanPoint, height: number): Vector3 {
  return new Vector3(p.x, height, p.y);
}

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);

/** Appends a convex quad prism (walls, posts, slabs). */
export function addPrism(acc: GeometryAccumulator, piece: PrismPiece): void {
  const { footprint: f, bottom, top } = piece;
  const b = f.map((p, i) => toWorld(p, bottom[i]));
  const t = f.map((p, i) => toWorld(p, top[i]));
  const cx = (f[0].x + f[1].x + f[2].x + f[3].x) / 4;
  const cy = (f[0].y + f[1].y + f[2].y + f[3].y) / 4;

  acc.quad(t[0], t[1], t[2], t[3], UP);
  acc.quad(b[0], b[1], b[2], b[3], DOWN);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const outward = new Vector3((f[i].x + f[j].x) / 2 - cx, 0, (f[i].y + f[j].y) / 2 - cy);
    acc.quad(b[i], b[j], t[j], t[i], outward);
  }
}

/**
 * Appends a planar roof slab whose footprint is a union of rectangles. The union is
 * rasterized onto a compressed grid of the rectangles' coordinates; each covered cell
 * contributes its top and bottom faces, and side faces are emitted only along the
 * outline, so the result is a single clean solid with no internal faces.
 */
export function addRoof(acc: GeometryAccumulator, piece: RoofPiece): void {
  const xs = uniqueSorted(piece.footprint.flatMap((r) => [r.x0, r.x1]));
  const ys = uniqueSorted(piece.footprint.flatMap((r) => [r.y0, r.y1]));
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  if (cols < 1 || rows < 1) return;

  const filled = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= cols || j >= rows) return false;
    const cx = (xs[i] + xs[i + 1]) / 2;
    const cy = (ys[j] + ys[j + 1]) / 2;
    return piece.footprint.some((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1);
  };

  const under = (x: number, y: number) => toWorld({ x, y }, roofHeightOnPlane(piece.plane, x, y));
  const over = (x: number, y: number) =>
    toWorld({ x, y }, roofHeightOnPlane(piece.plane, x, y) + piece.verticalThickness);

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (!filled(i, j)) continue;
      const [ax, bx, ay, by] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
      acc.quad(over(ax, ay), over(bx, ay), over(bx, by), over(ax, by), UP);
      acc.quad(under(ax, ay), under(bx, ay), under(bx, by), under(ax, by), DOWN);

      if (!filled(i, j - 1)) acc.quad(under(ax, ay), under(bx, ay), over(bx, ay), over(ax, ay), new Vector3(0, 0, -1));
      if (!filled(i, j + 1)) acc.quad(under(ax, by), under(bx, by), over(bx, by), over(ax, by), new Vector3(0, 0, 1));
      if (!filled(i - 1, j)) acc.quad(under(ax, ay), under(ax, by), over(ax, by), over(ax, ay), new Vector3(-1, 0, 0));
      if (!filled(i + 1, j)) acc.quad(under(bx, ay), under(bx, by), over(bx, by), over(bx, ay), new Vector3(1, 0, 0));
    }
  }
}

function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((v, i) => i === 0 || v - sorted[i - 1] > 1e-9);
}

import { Floor } from '../model/types';
import { FloorRegion } from './floor-region';
import { Box, pointIn, uniqueSorted } from './region';
import { wallBoxes, wallGeoms } from './wall-graph';

export interface Room {
  /** Net floor area inside the walls, sq ft. */
  area: number;
  /** Where to put the label. */
  x: number;
  y: number;
  /** Clear width/depth, when the room is a plain rectangle. */
  rect: { w: number; d: number } | null;
  /** The room's area as disjoint boxes (for asking which room a point is in). */
  cells: Box[];
}

/** Rooms smaller than this (sq ft) are left unlabeled (wall pockets, chases). */
const MIN_ROOM_AREA = 12;
/** Room dividers aren't built, so they split rooms as a hairline that takes no real area. */
const DIVIDER_THICKNESS = 1e-3;

/**
 * Splits a floor's interior into rooms: the connected areas left between the
 * walls and room dividers (door openings count as closed). Works on the compressed grid of the
 * interior's and walls' edges, so it's exact for this rectilinear world.
 */
export function findRooms(floor: Floor, region: FloorRegion, ti: number): Room[] {
  const solid = wallBoxes(floor, ti);
  const thin = wallBoxes(floor, DIVIDER_THICKNESS);
  const walls = wallGeoms(floor).map((g) => (g.wall.divider ? thin : solid).get(g.wall.id)!);
  const xs = uniqueSorted([...region.interior, ...walls].flatMap((b) => [b.x0, b.x1]));
  const ys = uniqueSorted([...region.interior, ...walls].flatMap((b) => [b.y0, b.y1]));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx < 1 || ny < 1) return [];

  const free = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      free[i * ny + j] = pointIn(region.interior, (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2) ? 1 : 0;
    }
  }
  const lower = (arr: number[], v: number) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v - 1e-6) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const w of walls) {
    for (let i = lower(xs, w.x0); i < lower(xs, w.x1); i++) {
      for (let j = lower(ys, w.y0); j < lower(ys, w.y1); j++) free[i * ny + j] = 0;
    }
  }

  const seen = new Uint8Array(nx * ny);
  const rooms: Room[] = [];
  for (let start = 0; start < nx * ny; start++) {
    if (!free[start] || seen[start]) continue;
    let area = 0;
    const cells: Box[] = [];
    let best: Box | null = null;
    let bestArea = 0;
    const bounds: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const i = Math.floor(c / ny);
      const j = c % ny;
      const cell = { x0: xs[i], x1: xs[i + 1], y0: ys[j], y1: ys[j + 1] };
      const a = (cell.x1 - cell.x0) * (cell.y1 - cell.y0);
      area += a;
      cells.push(cell);
      if (a > bestArea) [best, bestArea] = [cell, a];
      bounds.x0 = Math.min(bounds.x0, cell.x0);
      bounds.y0 = Math.min(bounds.y0, cell.y0);
      bounds.x1 = Math.max(bounds.x1, cell.x1);
      bounds.y1 = Math.max(bounds.y1, cell.y1);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const k = ii * ny + jj;
        if (free[k] && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    if (area < MIN_ROOM_AREA || !best) continue;
    const boundsArea = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0);
    const isRect = Math.abs(boundsArea - area) < 1e-3;
    const label = isRect ? bounds : best;
    rooms.push({
      area,
      x: (label.x0 + label.x1) / 2,
      y: (label.y0 + label.y1) / 2,
      rect: isRect ? { w: bounds.x1 - bounds.x0, d: bounds.y1 - bounds.y0 } : null,
      cells,
    });
  }
  return rooms;
}

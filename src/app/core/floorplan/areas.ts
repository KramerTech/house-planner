import { Floor } from '../model/types';
import { FloorRegion, floorArea } from './floor-region';
import { Box, pointIn, uniqueSorted } from './region';
import { findRooms, Room } from './rooms';
import { wallGeoms } from './wall-graph';

/** A floor's gross area, split by whether the rooms are heated (sq ft). */
export interface FloorAreas {
  heated: number;
  unheated: number;
}

/** True if a room's name marks it unheated. */
export function isUnheated(floor: Pick<Floor, 'roomNames'>, room: Pick<Room, 'cells'>): boolean {
  return floor.roomNames.some((n) => n.unheated && pointIn(room.cells, n.x, n.y));
}

/**
 * A floor's gross area (to the outside faces of its walls, less openings to the
 * floor below), split into heated and unheated. Rooms are heated unless named and
 * marked unheated. Walls go to the room nearest them, so an unheated room takes
 * the exterior walls around it and its half of any interior wall it shares.
 */
export function floorAreas(floor: Floor, region: FloorRegion, openings: readonly Box[], ti: number): FloorAreas {
  const gross = floorArea(region, openings);
  const rooms = findRooms(floor, region, ti);
  const cold = rooms.filter((r) => isUnheated(floor, r));
  if (!cold.length) return { heated: gross, unheated: 0 };
  const warm = rooms.filter((r) => !cold.includes(r));

  // A grid on every edge, plus interior walls' center lines so a wall splits down its middle.
  const boxes = [...region.footprint, ...openings, ...rooms.flatMap((r) => r.cells)];
  const centers = wallGeoms(floor);
  const xs = uniqueSorted([...boxes.flatMap((b) => [b.x0, b.x1]), ...centers.filter((g) => g.axis === 'y').map((g) => g.coord)]);
  const ys = uniqueSorted([...boxes.flatMap((b) => [b.y0, b.y1]), ...centers.filter((g) => g.axis === 'x').map((g) => g.coord)]);

  const gap = (cells: readonly Box[], x: number, y: number) =>
    Math.min(...cells.map((b) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1))));
  const coldCells = cold.flatMap((r) => r.cells);
  const warmCells = warm.flatMap((r) => r.cells);

  let unheated = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const [x, y] = [(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2];
      if (!pointIn(region.footprint, x, y) || pointIn(openings, x, y)) continue;
      // The nearest room wins; ties go to the heated one.
      const toCold = gap(coldCells, x, y);
      if (warmCells.length && gap(warmCells, x, y) <= toCold + 1e-9) continue;
      unheated += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    }
  }
  return { heated: Math.max(0, gross - unheated), unheated };
}

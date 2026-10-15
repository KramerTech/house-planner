import { createFloor, createSection, DEFAULT_SETTINGS } from '../model/defaults';
import { Floor, Section } from '../model/types';
import { placeDoors } from './doors';
import { floorFootprint, floorRegion } from './floor-region';
import { boundary, boxArea, erode } from './region';
import { findRooms } from './rooms';
import { addWall, deleteWalls, followOutline, moveIsValid, moveWallLine, wallFits, wallGeoms } from './wall-graph';

const settings = DEFAULT_SETTINGS;
const ti = settings.interiorWallThickness;
const area = (boxes: { x0: number; x1: number; y0: number; y1: number }[]) => boxes.reduce((a, b) => a + boxArea(b), 0);

/** A 20×10 house: two 10×10 sections side by side, 0.5 walls centered on the edges (interior 0.25..19.75 × 0.25..9.75). */
function house(): Section[] {
  return [createSection({ x: 0, y: 0, w: 10, d: 10 }, { pitch: 0 }), createSection({ x: 10, y: 0, w: 10, d: 10 }, { pitch: 0 })];
}

describe('regions', () => {
  it('erodes a union as one shape (no wall between joined sections)', () => {
    const inner = erode(
      [
        { x0: 0, x1: 10, y0: 0, y1: 10 },
        { x0: 10, x1: 20, y0: 0, y1: 10 },
      ],
      0.5,
    );
    expect(area(inner)).toBeCloseTo(19 * 9);
  });

  it('cuts the inside-corner square of an L', () => {
    // L: 10×10 plus 10×5 to its east along the top. Inner area = outline − wall band.
    const inner = erode(
      [
        { x0: 0, x1: 10, y0: 0, y1: 10 },
        { x0: 10, x1: 20, y0: 0, y1: 5 },
      ],
      0.5,
    );
    // 9×9 room plus a 10×4 arm, minus nothing overlapping: (0.5..9.5)×(0.5..9.5) ∪ (9.5..19.5)×(0.5..4.5)
    expect(area(inner)).toBeCloseTo(81 + 10 * 4);
  });

  it('traces the outline as maximal faces', () => {
    const faces = boundary([
      { x0: 0, x1: 10, y0: 0, y1: 10 },
      { x0: 10, x1: 20, y0: 0, y1: 10 },
    ]);
    expect(faces).toHaveLength(4);
    expect(faces.find((f) => f.side === 'N')).toEqual({ side: 'N', coord: 0, from: 0, to: 20 });
  });
});

describe('floor region', () => {
  it('puts the outside faces half a wall beyond the drawn lines and the interior half a wall inside', () => {
    const r = floorRegion(house(), settings, 0);
    expect(r.footprint).toEqual([{ x0: -0.25, x1: 20.25, y0: -0.25, y1: 10.25 }]);
    expect(r.interior).toEqual([{ x0: 0.25, x1: 19.75, y0: 0.25, y1: 9.75 }]);
  });
});

describe('upper floor footprint', () => {
  it('keeps the part of a sloped section with 8′ of headroom', () => {
    // Slopes down to the south from 9′ at y=12 rising 4/12: height at y is 9 + (12−y)/3.
    const s = createSection({ x: 0, y: 0, w: 10, d: 12 }, { slopeDir: 'S', pitch: 4, lowWallHeight: 9 });
    // Max height 13 at the north wall; a floor at 4′ needs 12′ → y ≤ 3.
    expect(floorFootprint([s], 4)).toEqual([{ x0: 0, x1: 10, y0: 0, y1: 3 }]);
    expect(floorFootprint([s], 9)).toEqual([]);
  });

  it('ignores patios', () => {
    const patio = { ...createSection({ x: 0, y: 0, w: 10, d: 10 }), patio: { enabled: true, postSpacing: 8 } };
    expect(floorFootprint([patio], 0)).toEqual([]);
  });
});

describe('wall graph', () => {
  const region = () => floorRegion(house(), settings, 0);

  it('splits walls at T junctions and crossings, and joins straight runs', () => {
    let f = createFloor();
    f = addWall(f, { x: 5, y: 0.25 }, { x: 5, y: 9.75 }, ti);
    f = addWall(f, { x: 0.25, y: 5 }, { x: 19.75, y: 5 }, ti); // crosses the first
    expect(f.walls).toHaveLength(4);
    expect(f.nodes.find((n) => n.x === 5 && n.y === 5)).toBeDefined();
    // Removing one arm leaves a T; removing the opposite arm rejoins the straight wall.
    const arm = wallGeoms(f).find((g) => g.axis === 'y' && g.lo === 0.25)!;
    f = deleteWalls(f, new Set([arm.wall.id]), ti);
    expect(f.walls).toHaveLength(3);
    const other = wallGeoms(f).find((g) => g.axis === 'y')!;
    f = deleteWalls(f, new Set([other.wall.id]), ti);
    expect(f.walls).toHaveLength(1);
    expect(wallGeoms(f)[0]).toMatchObject({ axis: 'x', lo: 0.25, hi: 19.75 });
  });

  it('moves a whole line and stretches the walls hanging off it', () => {
    let f = createFloor();
    f = addWall(f, { x: 0.25, y: 5 }, { x: 12, y: 5 }, ti);
    f = addWall(f, { x: 12, y: 5 }, { x: 12, y: 9.75 }, ti); // L corner down to the S wall
    const eastWest = wallGeoms(f).find((g) => g.axis === 'x')!;
    const moved = moveWallLine(f, eastWest.wall.id, -2);
    expect(moveIsValid(f, moved, region(), ti)).toBe(true);
    const ns = wallGeoms(moved).find((g) => g.axis === 'y')!;
    expect([ns.lo, ns.hi]).toEqual([3, 9.75]);
    // Can't drag a wall out through the exterior wall.
    expect(moveIsValid(f, moveWallLine(f, eastWest.wall.id, -10), region(), ti)).toBe(false);
  });

  it('keeps walls attached to exterior walls when dragging along them', () => {
    let f = createFloor();
    f = addWall(f, { x: 5, y: 0.25 }, { x: 5, y: 9.75 }, ti); // N wall to S wall
    const g = wallGeoms(f)[0];
    expect(moveIsValid(f, moveWallLine(f, g.wall.id, 3), region(), ti)).toBe(true);
  });

  it('only fits walls inside the interior', () => {
    expect(wallFits({ x: 0.25, y: 5 }, { x: 19.75, y: 5 }, region(), ti)).toBe(true);
    expect(wallFits({ x: 0, y: 5 }, { x: 19.75, y: 5 }, region(), ti)).toBe(false);
    expect(wallFits({ x: 1, y: 1 }, { x: 5, y: 5 }, region(), ti)).toBe(false); // diagonal
  });

  it('follows the exterior wall when a section is resized', () => {
    let f = createFloor();
    f = addWall(f, { x: 5, y: 0.25 }, { x: 5, y: 9.75 }, ti);
    const before = floorRegion(house(), settings, 0);
    const taller = house().map((s) => ({ ...s, rect: { ...s.rect, d: 14 } }));
    const after = floorRegion(taller, settings, 0);
    const g = wallGeoms(followOutline(f, before, after))[0];
    expect([g.lo, g.hi]).toEqual([0.25, 13.75]);
  });
});

describe('rooms and doors', () => {
  it('finds the rooms a wall divides the interior into', () => {
    const region = floorRegion(house(), settings, 0);
    let f: Floor = createFloor();
    f = addWall(f, { x: 8, y: 0.25 }, { x: 8, y: 9.75 }, ti);
    const rooms = findRooms(f, region, ti);
    expect(rooms).toHaveLength(2);
    const areas = rooms.map((r) => r.area).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo((8 - ti / 2 - 0.25) * 9.5);
    expect(rooms.every((r) => r.rect)).toBe(true);
  });

  it('places doors on interior and exterior walls, clamped into the wall', () => {
    const region = floorRegion(house(), settings, 0);
    let f: Floor = createFloor();
    f = addWall(f, { x: 8, y: 0.25 }, { x: 8, y: 9.75 }, ti);
    f.doors = [
      { id: 'a', host: { wallId: f.walls[0].id }, at: 0, width: 3, kind: 'single', swing: 1, hinge: 1 },
      { id: 'b', host: { side: 'S', coord: 10.25 }, at: 5, width: 3, kind: 'single', swing: -1, hinge: 1 },
    ];
    const [inner, outer] = placeDoors(f, region, ti);
    expect(inner.valid).toBe(true);
    expect(inner.box.y0).toBeCloseTo(0.25 + ti / 2);
    expect(outer.exterior).toBe(true);
    expect(outer.box).toEqual({ x0: 3.5, x1: 6.5, y0: 9.75, y1: 10.25 });
  });
});

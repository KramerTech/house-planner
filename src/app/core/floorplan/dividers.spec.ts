import { describe, expect, it } from 'vitest';
import { doorSpot, hitTest, planContext, snapItem } from '../../floorplan/plan-tools';
import { createFloor, createSection, DEFAULT_SETTINGS } from '../model/defaults';
import { CATALOG_BY_ID, itemShape, stairArrival, stairOpeningLocal } from './catalog';
import { doorHeight, doorWidths, fitDoorWidth } from './doors';
import { floorRegion } from './floor-region';
import { findRooms } from './rooms';
import { addWall, normalize, setDividers, wallGeoms } from './wall-graph';

const settings = DEFAULT_SETTINGS;
const ti = settings.interiorWallThickness;
const region = floorRegion([createSection({ x: 0, y: 0, w: 20, d: 12 })], settings, 0);

describe('room dividers', () => {
  const withDivider = () => addWall(createFloor(), { x: 10, y: 0.25 }, { x: 10, y: 11.75 }, ti, true);

  it('split rooms, losing no real area to the line', () => {
    const rooms = findRooms(withDivider(), region, ti);
    expect(rooms).toHaveLength(2);
    expect(rooms.reduce((a, r) => a + r.area, 0)).toBeCloseTo(19.5 * 11.5, 1);
  });

  it('stay dividers when split by a crossing wall, and only join their own kind', () => {
    let f = withDivider();
    f = addWall(f, { x: 0.25, y: 6 }, { x: 19.75, y: 6 }, ti);
    const geoms = wallGeoms(f);
    expect(geoms.filter((g) => g.wall.divider)).toHaveLength(2);
    expect(geoms.filter((g) => !g.wall.divider)).toHaveLength(2);
    // Removing the crossing wall leaves a single divider again.
    f = normalize({ ...f, walls: f.walls.filter((w) => w.divider) }, ti);
    expect(wallGeoms(f)).toHaveLength(1);
    expect(f.walls[0].divider).toBe(true);
  });

  it('become walls when a wall is drawn over them', () => {
    const f = addWall(withDivider(), { x: 10, y: 0.25 }, { x: 10, y: 11.75 }, ti);
    expect(f.walls).toHaveLength(1);
    expect(f.walls[0].divider).toBeFalsy();
  });

  it('hold no doors, and furniture does not snap to them', () => {
    let f = addWall(createFloor(), { x: 10, y: 0.25 }, { x: 10, y: 11.75 }, ti);
    f = { ...f, doors: [{ id: 'd', host: { wallId: f.walls[0].id }, at: 6, width: 3, kind: 'single', swing: 1, hinge: 1 }] };
    f = setDividers(f, new Set([f.walls[0].id]), true, ti);
    expect(f.doors).toEqual([]);
    const ctx = planContext(f, region, ti, []);
    expect(doorSpot(ctx, { x: 10, y: 6 }, 0.3, 3, 0.25)).toBeNull();
    // A 2'-wide piece just west of the line stays where it's put (grid), not pulled flush.
    expect(snapItem(ctx, { x: 8.9, y: 6 }, { w: 2, d: 2 }, 0.3, 0.25).x).toBeCloseTo(9);
  });
});

describe('door widths', () => {
  it('come in standard sizes per kind', () => {
    expect(doorWidths('single').map((w) => Math.round(w * 12))).toEqual([24, 28, 30, 32, 36]);
    expect(doorWidths('double').map((w) => Math.round(w * 12))).toEqual([60, 64, 72]);
  });

  it('include overhead garage doors, one- and two-car, 7′ or 8′ high', () => {
    expect(doorWidths('garage')).toEqual([8, 9, 10, 16, 18, 20]);
    expect(fitDoorWidth('garage', 32 / 12)).toBe(8);
    expect(doorHeight({ kind: 'garage' })).toBe(7);
    expect(doorHeight({ kind: 'garage', height: 8 })).toBe(8);
    expect(doorHeight({ kind: 'single', height: 8 })).toBeCloseTo(6 + 8 / 12);
  });

  it('move to the nearest offered size when the kind changes', () => {
    expect(Math.round(fitDoorWidth('double', 32 / 12) * 12)).toBe(60);
    expect(Math.round(fitDoorWidth('single', 64 / 12) * 12)).toBe(36);
    expect(fitDoorWidth('pocket', 2.5)).toBe(2.5);
  });
});

describe('catalog', () => {
  const stairs = CATALOG_BY_ID.get('stairs')!;

  it('drops the stairs’ top landing from the plan where the floor above provides it', () => {
    const full = itemShape(stairs, 10).box;
    const trimmed = itemShape(stairs, 10, true).box;
    expect(full.y0).toBeCloseTo(-itemShape(stairs, 10).d / 2);
    expect(trimmed.y0).toBeCloseTo(full.y0 + 3); // a 3' landing
    expect(trimmed.y1).toBeCloseTo(full.y1);
    expect(itemShape(stairs, 10, true).symbol.filter((p) => p.t === 'rect' && p.s === 'soft')).toHaveLength(1);
  });

  it('shows the top landing and the opening on the floor the stairs climb to', () => {
    const shape = itemShape(stairs, 10);
    const arrival = stairArrival(stairs, 10)!;
    const opening = stairOpeningLocal(stairs, 10, 8)!;
    // From the far end of the top landing down to the end of the opening over the flight.
    expect(arrival.box.y0).toBeCloseTo(-shape.d / 2);
    expect(arrival.box.y1).toBeCloseTo(opening.y1);
    expect(arrival.symbol.filter((p) => p.t === 'rect')).toHaveLength(1);
    expect(stairArrival(CATALOG_BY_ID.get('sofa')!, 10)).toBeNull();
  });

  it('picks up an arriving stair by its handle, under this floor’s own furniture', () => {
    const ctx = planContext({ ...createFloor(), items: [{ id: 'chair', type: 'desk-chair', x: 5, y: 5, rotation: 0 }] }, region, ti, []);
    const handles = [{ id: 'st', box: { x0: 3, x1: 6, y0: 2, y1: 10 } }];
    expect(hitTest(ctx, { x: 4, y: 8 }, 0.1, [], handles)).toEqual({ kind: 'stair', id: 'st' });
    expect(hitTest(ctx, { x: 5, y: 5 }, 0.1, [], handles)).toEqual({ kind: 'item', id: 'chair' });
  });

  it('has white basins in vanities and a silver one in the kitchen sink', () => {
    const colors = (id: string) => new Set(CATALOG_BY_ID.get(id)!.parts.map((p) => p.color));
    for (const id of ['vanity-30', 'vanity-36', 'vanity-60', 'vanity-72']) expect(colors(id)).toContain('#f2f4f5');
    expect(colors('sink-base')).toContain('#d3d8dc');
    // The double vanity's two basins each sink into the counter.
    const basinFloors = CATALOG_BY_ID.get('vanity-60')!.parts.filter((p) => p.color === '#f2f4f5' && p.z1 < 34 / 12 - 0.1);
    expect(basinFloors).toHaveLength(2);
  });

  it('has a weight rack with a bench: four uprights, a loaded bar and a pad', () => {
    const rack = CATALOG_BY_ID.get('weight-rack')!;
    expect(rack.category).toBe('other');
    expect(rack.parts.filter((p) => p.z0 === 0 && p.z1 === 7.5)).toHaveLength(4);
    const bar = rack.parts.find((p) => p.x1 - p.x0 === rack.w)!;
    expect(bar.z0).toBeGreaterThan(3);
    // Everything stays within the footprint.
    expect(rack.parts.every((p) => p.x0 >= -rack.w / 2 && p.x1 <= rack.w / 2 && p.y0 >= -rack.d / 2 && p.y1 <= rack.d / 2)).toBe(true);
  });

  it('has a chest of drawers in the bedroom: five drawers with pulls, within its footprint', () => {
    const chest = CATALOG_BY_ID.get('chest-of-drawers')!;
    expect(chest.category).toBe('bedroom');
    expect(chest.parts.filter((p) => p.color === '#aeb4b9')).toHaveLength(5);
    expect(Math.max(...chest.parts.map((p) => p.z1))).toBe(4);
    expect(chest.parts.every((p) => p.x0 >= -chest.w / 2 && p.x1 <= chest.w / 2 && p.y0 >= -chest.d / 2 && p.y1 <= chest.d / 2 + 1e-9)).toBe(true);
  });

  it('has a coat rack: feet, a pole and arms', () => {
    const rack = CATALOG_BY_ID.get('coat-rack')!;
    expect(rack.parts.some((p) => p.z1 > 5.5 && p.x1 - p.x0 < 0.2 && p.y1 - p.y0 < 0.2)).toBe(true); // pole
    expect(rack.parts.filter((p) => p.z0 < 0.2 && p.x1 - p.x0 > 1.5)).toHaveLength(1); // a foot bar across
    expect(rack.parts.filter((p) => p.z0 > 4.5 && p.z0 < 5.6).length).toBeGreaterThanOrEqual(8); // arms and hooks
  });
});

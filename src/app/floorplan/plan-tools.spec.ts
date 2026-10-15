import { floorRegion } from '../core/floorplan/floor-region';
import { wallFits } from '../core/floorplan/wall-graph';
import { createFloor, createSection, DEFAULT_SETTINGS } from '../core/model/defaults';
import { connects, planContext, snapAlong, snapItem, snapPoint, snapTo } from './plan-tools';

const settings = DEFAULT_SETTINGS; // 6" exterior, 4.5" interior walls
const ti = settings.interiorWallThickness;

// L-shaped house: 20×10 plus 10×10 below its west half. The outline turns inward at
// (10,10); the walls there meet in a corner block 9.75..10.25 that juts into the room,
// its room-side corner at (9.75, 9.75).
const sections = [createSection({ x: 0, y: 0, w: 20, d: 10 }), createSection({ x: 0, y: 10, w: 10, d: 10 })];
const region = floorRegion(sections, settings, 0);
const ctx = planContext(createFloor(), region, ti, []);

describe('jut corner snap', () => {
  it('finds the corner jutting into the room', () => {
    expect(ctx.juts.map((j) => j.at)).toEqual([{ x: 9.75, y: 9.75 }]);
  });

  it('snaps to half an interior wall back into the jut, and highlights the corner block', () => {
    const s = snapPoint(ctx, { x: 9.9, y: 9.9 }, 0.3, 0.25);
    expect(s.kind).toBe('corner');
    expect(s.p).toEqual({ x: 9.75 + ti / 2, y: 9.75 + ti / 2 });
    expect(s.highlight).toEqual({ x0: 9.75, x1: 10.25, y0: 9.75, y1: 10.25 });
    expect(connects(s)).toBe(true);
  });

  it('lets a wall from there continue either face of the jut flush', () => {
    const start = { x: 9.75 + ti / 2, y: 9.75 + ti / 2 };
    // North: its west face continues the jut's west face, x = 9.75.
    expect(wallFits(start, { x: start.x, y: 0.25 }, region, ti)).toBe(true);
    // West: its north face continues the jut's north face, y = 9.75.
    expect(wallFits(start, { x: 0.25, y: start.y }, region, ti)).toBe(true);
    // East would run inside the exterior wall.
    expect(wallFits(start, { x: 15, y: start.y }, region, ti)).toBe(false);
  });

  it('ends a wall drawn along a jut face line at the jut', () => {
    const from = { x: 9.75 + ti / 2, y: 3 };
    const s = snapAlong(ctx, from, 'y', 10, 0.3, 0.25);
    expect(s.kind).toBe('corner');
    expect(s.p.y).toBeCloseTo(9.75 + ti / 2);
  });
});

describe('tape marks', () => {
  const mark = { a: { x: 3, y: 2 }, b: { x: 3, y: 8 } };
  const marked = planContext(createFloor(), region, ti, [], undefined, [mark]);

  it('snaps to a mark’s ends without treating them as walls', () => {
    const s = snapPoint(marked, { x: 3.1, y: 7.9 }, 0.3, 0.25);
    expect(s).toMatchObject({ kind: 'mark', p: { x: 3, y: 8 } });
    expect(connects(s)).toBe(false);
  });

  it('snaps onto a mark’s line', () => {
    expect(snapPoint(marked, { x: 3.1, y: 5.03 }, 0.3, 0.25)).toMatchObject({ kind: 'mark', p: { x: 3, y: 5.03 } });
  });

  it('stops a wall being drawn across a square mark where they meet', () => {
    const s = snapAlong(marked, { x: 0.25, y: 5 }, 'x', 3.2, 0.3, 0.25);
    expect(s).toMatchObject({ kind: 'mark', p: { x: 3, y: 5 } });
  });
});

describe('furniture snapping', () => {
  // The L house; a 2′×1.5′ nightstand (2 wide, 1.5 deep), and a queen bed (5 × 6′8″) against the north wall.
  const floor = createFloor();
  floor.items = [{ id: 'bed', type: 'bed-queen', x: 5, y: 3.6, rotation: 0 }];
  const withBed = planContext(floor, region, ti, []);
  const stand = { w: 2, d: 1.5 };
  const bed = { x0: 2.5, x1: 7.5 };

  it('snaps flush against another piece of furniture', () => {
    const p = snapItem(withBed, { x: bed.x1 + 1 + 0.2, y: 2 }, stand, 0.3, 0.25);
    expect(p.x - stand.w / 2).toBeCloseTo(bed.x1);
  });

  it('snaps flush against a wall it is alongside', () => {
    // North wall's inside face is at y = 0.25.
    const p = snapItem(withBed, { x: 12, y: 0.25 + 0.75 + 0.2 }, stand, 0.3, 0.25);
    expect(p.y - stand.d / 2).toBeCloseTo(0.25);
  });

  it('does not snap to a wall line it is nowhere near', () => {
    // x = 9.75 is the jut's west face, which only runs from y = 9.75 south; at y = 3 it isn't there.
    const p = snapItem(planContext(createFloor(), region, ti, []), { x: 9.75 - 1 - 0.1, y: 3 }, stand, 0.3, 0.25);
    expect(p.x).toBe(8.75); // just the grid
  });

  it('leaves the pieces being moved out', () => {
    const p = snapItem(withBed, { x: bed.x1 + 1 + 0.2, y: 2 }, stand, 0.3, 0.25, new Set(['bed']));
    expect(p.x).toBe(snapTo(bed.x1 + 1.2, 0.25));
  });
});

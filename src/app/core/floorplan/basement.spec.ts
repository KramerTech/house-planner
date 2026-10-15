import { describe, expect, it } from 'vitest';
import { createFloor, createSection, DEFAULT_SETTINGS } from '../model/defaults';
import { floorRegion, groundIndex, normalizeLevels, regionOf, stairOpenings } from './floor-region';
import { boxArea } from './region';

const settings = DEFAULT_SETTINGS; // 6" exterior walls
// A 20×12 house with a 10×12 garage section on its east side.
const sections = [createSection({ x: 0, y: 0, w: 20, d: 12 }), createSection({ x: 20, y: 0, w: 10, d: 12 })];

describe('basement region', () => {
  it('matches the ground floor when all of it is dug', () => {
    const basement = createFloor(-9);
    expect(regionOf(sections, settings, basement)).toEqual(floorRegion(sections, settings, 0));
  });

  it('leaves undug areas out, with walls along their edges', () => {
    const basement = createFloor(-9);
    basement.unexcavated = [{ id: 'g', x0: 20, y0: -5, x1: 40, y1: 20 }]; // past the outline: only the overlap counts
    const r = regionOf(sections, settings, basement);
    expect(r.lines).toEqual([{ x0: 0, y0: 0, x1: 20, y1: 12 }]);
    // The foundation wall on the garage line straddles it like any wall.
    expect(r.interior).toEqual([{ x0: 0.25, y0: 0.25, x1: 19.75, y1: 11.75 }]);
    expect(r.footprint.reduce((a, b) => a + boxArea(b), 0)).toBeCloseTo(20.5 * 12.5);
  });

  it('ignores undug areas on floors that are not basements', () => {
    const ground = createFloor();
    ground.unexcavated = [{ id: 'g', x0: 20, y0: 0, x1: 30, y1: 12 }];
    expect(regionOf(sections, settings, ground)).toEqual(floorRegion(sections, settings, 0));
  });
});

describe('floor levels', () => {
  it('finds the ground floor after a basement', () => {
    expect(groundIndex([createFloor()])).toBe(0);
    expect(groundIndex([createFloor(-9), createFloor(), createFloor(10)])).toBe(1);
  });

  it('keeps one basement and the ground floor at 0', () => {
    expect(normalizeLevels([createFloor(-9), createFloor(0.5), createFloor(10)]).map((f) => f.elevation)).toEqual([-9, 0, 10]);
    // A lone floor below 0 is just a misplaced ground floor.
    expect(normalizeLevels([createFloor(-9)]).map((f) => f.elevation)).toEqual([0]);
  });

  it('opens the ground floor over basement stairs', () => {
    const basement = createFloor(-9);
    basement.items = [{ id: 's', type: 'stairs', x: 5, y: 6, rotation: 0 }];
    const floors = [basement, createFloor()];
    expect(stairOpenings(floors, 1)).toHaveLength(1);
    expect(stairOpenings(floors, 0)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { createFloor, createSection, DEFAULT_SETTINGS } from '../model/defaults';
import { Floor } from '../model/types';
import { floorAreas } from './areas';
import { floorRegion } from './floor-region';
import { addWall } from './wall-graph';

const settings = DEFAULT_SETTINGS;
const ti = settings.interiorWallThickness;
// 20×12 on its wall center lines: 20.5 × 12.5 = 256.25 sq ft to the outside faces.
const region = floorRegion([createSection({ x: 0, y: 0, w: 20, d: 12 })], settings, 0);

/** Two rooms either side of a wall on x = 10; the west one named, unheated or not. */
function floor(unheated: boolean): Floor {
  const f = addWall(createFloor(), { x: 10, y: 0.25 }, { x: 10, y: 11.75 }, ti);
  return { ...f, roomNames: [{ id: 'r', x: 5, y: 6, name: 'Garage', unheated }] };
}

describe('heated and unheated floor area', () => {
  it('is all heated until a room is marked unheated', () => {
    expect(floorAreas(floor(false), region, [], ti)).toEqual({ heated: 256.25, unheated: 0 });
  });

  it('gives an unheated room its exterior walls and its half of the wall it shares', () => {
    const a = floorAreas(floor(true), region, [], ti);
    // From the west outside face (−0.25) to the shared wall's center line (10).
    expect(a.unheated).toBeCloseTo(10.25 * 12.5);
    expect(a.heated + a.unheated).toBeCloseTo(256.25);
  });

  it('leaves out openings to the floor below', () => {
    const a = floorAreas(floor(true), region, [{ x0: 2, y0: 2, x1: 4, y1: 6 }], ti);
    expect(a.unheated).toBeCloseTo(10.25 * 12.5 - 8);
    expect(a.heated).toBeCloseTo(256.25 - 10.25 * 12.5);
  });
});

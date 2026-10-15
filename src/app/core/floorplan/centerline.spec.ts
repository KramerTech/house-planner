import { validateLayout } from '../geometry/constraints';
import { layoutStep } from '../geometry/rect';
import { sideResizeRange } from '../geometry/side-resize';
import { createFloor, createSection, DEFAULT_SETTINGS } from '../model/defaults';
import { migrateProject } from '../persistence/project-repository';
import { exteriorDims } from './exterior-dims';
import { grossAreas, outsideFootprint } from './floor-region';

const settings = DEFAULT_SETTINGS; // 6" walls

/** Two 3′ squares (wall centerlines) sharing one foot at the corner. */
function corner() {
  const a = createSection({ x: 0, y: 0, w: 3, d: 3 });
  const b = createSection({ x: 3, y: 2, w: 3, d: 3 });
  return [a, b];
}

describe('exterior dimensions', () => {
  it('measures each outside face and the overall size, to the outside of the walls', () => {
    const dims = exteriorDims(outsideFootprint(corner(), settings));
    const north = dims.find((d) => d.side === 'N')!;
    expect(north.to - north.from).toBe(6.5); // overall: 3 + 3 centerline, plus half a wall each end
    expect(north.pieces.map((p) => p.to - p.from)).toEqual([3.5, 3]);
    const west = dims.find((d) => d.side === 'W')!;
    expect(west.to - west.from).toBe(5.5);
    expect(west.pieces.map((p) => p.to - p.from)).toEqual([3.5, 2]);
  });

  it('counts gross areas to the outside faces', () => {
    const house = createSection({ x: 0, y: 0, w: 16, d: 12 });
    const patio = { ...createSection({ x: 16, y: 0, w: 8, d: 12 }), patio: { enabled: true, postSpacing: 8 } };
    const a = grossAreas([house, patio], settings);
    expect(a.enclosed).toBeCloseTo(16.5 * 12.5);
    // Patio out to its posts' outside faces, less what the house wall already covers.
    expect(a.covered).toBeCloseTo((24.25 - 16.25) * 12.5);
  });
});

describe('half-wall layout grid', () => {
  it('snaps section sides to half a wall thickness', () => {
    const s = createSection({ x: 0, y: 0, w: 3, d: 3 });
    const range = sideResizeRange([s], s.id, { sectionId: s.id, side: 'E' }, layoutStep(settings.wallThickness));
    expect(range.min).toBe(1);
    expect(validateLayout([{ ...s, rect: { ...s.rect, w: 3.25 } }], s.id)).toBeNull();
    expect(validateLayout([{ ...s, rect: { ...s.rect, w: 1 / 3 } }], s.id)).toBe('off-grid');
  });
});

describe('v4 → v5 migration', () => {
  it('moves interior walls that ended on a wall face onto the new face', () => {
    const s = createSection({ x: 0, y: 0, w: 10, d: 10 });
    const floor = createFloor();
    // v4: walls sat inside the edges, so the inside faces were at 0.5 and 9.5.
    floor.nodes = [
      { id: 'a', x: 5, y: 0.5 },
      { id: 'b', x: 5, y: 9.5 },
    ];
    floor.walls = [{ id: 'w', a: 'a', b: 'b' }];
    const p = migrateProject({ schemaVersion: 4, id: 'p', rootId: s.id, sections: [s], floors: [floor] })!;
    expect(p.floors[0].nodes.map((n) => n.y)).toEqual([0.25, 9.75]);
  });
});

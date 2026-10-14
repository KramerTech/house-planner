import { createProject, createSection } from '../../core/model/defaults';
import { Project, Rect, RoofSpec, Section } from '../../core/model/types';
import { buildBuildingModel, postPositions } from './building-builder';
import { PrismPiece, RoofPiece } from './building-model';

function project(sections: Section[]): Project {
  return { ...createProject('t'), rootId: sections[0].id, sections };
}

function sec(id: string, rect: Rect, roof: Partial<RoofSpec> = {}, patio = false): Section {
  const s = createSection(rect, roof);
  return { ...s, id, patio: { ...s.patio, enabled: patio } };
}

const roofOf = (p: Project, id: string) =>
  buildBuildingModel(p).pieces.find((x): x is RoofPiece => x.kind === 'roof' && x.sectionId === id)!;

const extent = (roof: RoofPiece) => ({
  x0: Math.min(...roof.footprint.map((r) => r.x0)),
  x1: Math.max(...roof.footprint.map((r) => r.x1)),
  y0: Math.min(...roof.footprint.map((r) => r.y0)),
  y1: Math.max(...roof.footprint.map((r) => r.y1)),
});

describe('roof overhang', () => {
  it('overhangs every edge of a lone section', () => {
    const p = project([sec('a', { x: 0, y: 0, w: 10, d: 10 })]);
    expect(extent(roofOf(p, 'a'))).toEqual({ x0: -2, x1: 12, y0: -2, y1: 12 });
  });

  it('omits overhang on both sides where roofs meet level', () => {
    // Both slope south with the same low wall, so their roofs match along the shared wall.
    const p = project([sec('a', { x: 0, y: 0, w: 10, d: 10 }), sec('b', { x: 10, y: 0, w: 10, d: 10 })]);
    expect(extent(roofOf(p, 'a')).x1).toBe(10);
    expect(extent(roofOf(p, 'b')).x0).toBe(10);
  });

  it('only the higher roof overhangs a shared wall', () => {
    const p = project([
      sec('a', { x: 0, y: 0, w: 10, d: 10 }, { lowWallHeight: 12 }),
      sec('b', { x: 10, y: 0, w: 10, d: 10 }, { lowWallHeight: 9 }),
    ]);
    expect(extent(roofOf(p, 'a')).x1).toBe(12);
    expect(extent(roofOf(p, 'b')).x0).toBe(10);
  });

  it('only fills corners where both meeting edges overhang', () => {
    const p = project([
      sec('a', { x: 0, y: 0, w: 10, d: 10 }),
      sec('b', { x: 10, y: 0, w: 10, d: 10 }, { lowWallHeight: 12 }),
    ]);
    const roof = roofOf(p, 'a');
    const coversNE = roof.footprint.some((r) => r.x0 < 11 && r.x1 > 11 && r.y0 < -1 && r.y1 > -1);
    expect(coversNE).toBe(false);
  });
});

describe('patio', () => {
  const pieces = (p: Project, id: string, kind: PrismPiece['kind']) =>
    buildBuildingModel(p).pieces.filter((x) => x.kind === kind && x.sectionId === id);

  it('replaces open walls with posts but keeps walls shared with enclosed sections', () => {
    const p = project([
      sec('house', { x: 0, y: 0, w: 10, d: 10 }),
      sec('patio', { x: 10, y: 0, w: 8, d: 10 }, {}, true),
    ]);
    const walls = pieces(p, 'patio', 'wall') as PrismPiece[];
    expect(walls).toHaveLength(1);
    expect(walls[0].footprint[0].x).toBe(10); // the wall against the house
    expect(pieces(p, 'patio', 'post').length).toBeGreaterThanOrEqual(4);
  });

  it('does not duplicate corner posts', () => {
    const p = project([sec('patio', { x: 0, y: 0, w: 8, d: 8 }, {}, true)]);
    // spacing 8 → posts only at the 4 corners
    expect(pieces(p, 'patio', 'post')).toHaveLength(4);
  });
});

describe('postPositions', () => {
  it('places end posts flush and keeps spacing within the limit', () => {
    const pos = postPositions(0, 20, 0.5, 8);
    expect(pos[0]).toBe(0.25);
    expect(pos.at(-1)).toBe(19.75);
    for (let i = 1; i < pos.length; i++) expect(pos[i] - pos[i - 1]).toBeLessThanOrEqual(8);
  });
});

describe('roof plane', () => {
  it('passes through the low wall top and rises toward the high side', () => {
    const p = project([sec('a', { x: 0, y: 0, w: 10, d: 12 }, { slopeDir: 'S', pitch: 4, lowWallHeight: 9 })]);
    const { plane } = roofOf(p, 'a');
    const h = (x: number, y: number) => plane.base + plane.gx * x + plane.gy * y;
    expect(h(5, 12)).toBeCloseTo(9);
    expect(h(5, 0)).toBeCloseTo(13);
  });
});

describe('slab', () => {
  it('sits entirely below the walls', () => {
    const p = project([sec('a', { x: 0, y: 0, w: 10, d: 10 })]);
    const slab = buildBuildingModel(p).pieces.find((x): x is PrismPiece => x.kind === 'slab')!;
    expect(Math.max(...slab.top)).toBe(0);
    expect(Math.min(...slab.bottom)).toBeLessThan(0);
  });
});

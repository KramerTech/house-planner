import { createProject, createSection } from '../../core/model/defaults';
import { Project, Rect, RoofSpec, Section } from '../../core/model/types';
import { buildBuildingModel, postPositions } from './building-builder';
import { PrismPiece, RoofPiece } from './building-model';

// Section edges are wall centerlines; default walls are 6" (0.5 ft), so walls span
// edge ± 0.25 and outside faces sit 0.25 beyond the edges.

function project(sections: Section[]): Project {
  return { ...createProject('t'), rootId: sections[0].id, sections };
}

function sec(id: string, rect: Rect, roof: Partial<RoofSpec> = {}, patio = false): Section {
  const s = createSection(rect, roof);
  return { ...s, id, patio: { ...s.patio, enabled: patio } };
}

const roofOf = (p: Project, id: string) =>
  buildBuildingModel(p).pieces.find((x): x is RoofPiece => x.kind === 'roof' && x.sectionId === id)!;

const xsOf = (w: PrismPiece) => w.footprint.map((p) => p.x);
const ysOf = (w: PrismPiece) => w.footprint.map((p) => p.y);
const range = (vs: number[]) => [Math.min(...vs), Math.max(...vs)];

/** True if `w` is a N/S-running wall centered on the line x = `x`. */
function isWallOnX(w: PrismPiece, x: number): boolean {
  const [lo, hi] = range(xsOf(w));
  return Math.abs((lo + hi) / 2 - x) < 1e-9 && hi - lo <= 1;
}

/** The wall pieces covering plan point (x, y) — at height h, if given. */
function wallsAt(walls: PrismPiece[], x: number, y: number, h?: number): PrismPiece[] {
  return walls.filter((w) => {
    const [x0, x1] = range(xsOf(w));
    const [y0, y1] = range(ysOf(w));
    const inPlan = x > x0 && x < x1 && y > y0 && y < y1;
    return inPlan && (h === undefined || (h >= Math.min(...w.bottom) && h <= Math.max(...w.top)));
  });
}

const extent = (roof: RoofPiece) => ({
  x0: Math.min(...roof.footprint.map((r) => r.x0)),
  x1: Math.max(...roof.footprint.map((r) => r.x1)),
  y0: Math.min(...roof.footprint.map((r) => r.y0)),
  y1: Math.max(...roof.footprint.map((r) => r.y1)),
});

const pieces = (p: Project, kind: PrismPiece['kind']) =>
  buildBuildingModel(p).pieces.filter((x): x is PrismPiece => x.kind === kind);

describe('centerline walls', () => {
  it('centers exterior walls on the section edges', () => {
    const walls = pieces(project([sec('a', { x: 0, y: 0, w: 10, d: 10 })]), 'wall');
    const west = walls.filter((w) => isWallOnX(w, 0));
    expect(west).toHaveLength(1);
    expect(range(xsOf(west[0]))).toEqual([-0.25, 0.25]);
    // Carried half a wall past each end, so the corners are closed.
    expect(range(ysOf(west[0]))).toEqual([-0.25, 10.25]);
  });

  it('lines up walls of different sections on one line as one straight wall', () => {
    // The 3′ squares meeting at a corner: A's east wall and B's west wall both lie on x = 3.
    const walls = pieces(
      project([sec('a', { x: 0, y: 0, w: 3, d: 3 }), sec('b', { x: 3, y: 2, w: 3, d: 3 })]),
      'wall',
    );
    // A's and B's walls, plus the step wall above A's lower roof on the shared foot.
    const onLine = walls.filter((w) => isWallOnX(w, 3));
    expect(onLine).toHaveLength(3);
    for (const w of onLine) expect(range(xsOf(w))).toEqual([2.75, 3.25]);
    // Nothing anywhere is thicker than one wall: the shared stretch is not walled
    // over from both sides.
    for (const w of walls) {
      const [x0, x1] = range(xsOf(w));
      const [y0, y1] = range(ysOf(w));
      expect(Math.min(x1 - x0, y1 - y0)).toBeCloseTo(0.5);
    }
  });

  it('meets a gable end’s two halves flush under the ridge, without overlap', () => {
    // Two 10×6 halves sloping away from a ridge on y = 6; both gable ends lie on x = 0.
    const walls = pieces(
      project([
        sec('n', { x: 0, y: 0, w: 10, d: 6 }, { slopeDir: 'N', pitch: 6 }),
        sec('s', { x: 0, y: 6, w: 10, d: 6 }, { slopeDir: 'S', pitch: 6 }),
      ]),
      'wall',
    );
    const west = walls.filter((w) => isWallOnX(w, 0)).map((w) => range(ysOf(w)));
    expect(west.sort((a, b) => a[0] - b[0])).toEqual([
      [-0.25, 6],
      [6, 12.25],
    ]);
    // So the end peaks once, at the ridge.
    expect(Math.max(...walls.filter((w) => isWallOnX(w, 0)).flatMap((w) => w.top))).toBeCloseTo(9 + 3);
  });
});

describe('roof overhang', () => {
  it('overhangs every edge of a lone section, past the outside face of the wall', () => {
    const p = project([sec('a', { x: 0, y: 0, w: 10, d: 10 })]);
    expect(extent(roofOf(p, 'a'))).toEqual({ x0: -2.25, x1: 12.25, y0: -2.25, y1: 12.25 });
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
    expect(extent(roofOf(p, 'a')).x1).toBe(12.25);
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
  const ofSection = (p: Project, id: string, kind: PrismPiece['kind']) =>
    buildBuildingModel(p).pieces.filter((x): x is PrismPiece => x.kind === kind && x.sectionId === id);

  it('replaces open walls with posts, and skips the redundant wall copy shared with an enclosed section', () => {
    const p = project([
      sec('house', { x: 0, y: 0, w: 10, d: 10 }),
      sec('patio', { x: 10, y: 0, w: 8, d: 10 }, {}, true),
    ]);
    // The house still builds the real wall against the patio, centered on the line...
    expect(ofSection(p, 'house', 'wall').some((w) => isWallOnX(w, 10))).toBe(true);
    // ...so the patio doesn't need its own copy of it.
    expect(ofSection(p, 'patio', 'wall')).toHaveLength(0);
    // Posts centered on the open corners and every ≤8′ between: (18,0), (18,5), (18,10).
    expect(ofSection(p, 'patio', 'post')).toHaveLength(3);
  });

  it('does not duplicate corner posts', () => {
    const p = project([sec('patio', { x: 0, y: 0, w: 8, d: 8 }, {}, true)]);
    // spacing 8 → posts only at the 4 corners
    expect(ofSection(p, 'patio', 'post')).toHaveLength(4);
  });

  it('centers posts on the patio edges', () => {
    const p = project([sec('patio', { x: 0, y: 0, w: 8, d: 8 }, {}, true)]);
    const corner = ofSection(p, 'patio', 'post').find((post) => post.footprint.some((q) => q.x < 0 && q.y < 0))!;
    expect(range(xsOf(corner))).toEqual([-0.25, 0.25]);
  });

  it('skips the post at a corner where the patio meets the house wall', () => {
    const p = project([
      sec('house', { x: 0, y: 0, w: 10, d: 10 }),
      sec('patio', { x: 10, y: 0, w: 8, d: 10 }, {}, true),
    ]);
    const posts = ofSection(p, 'patio', 'post');
    expect(posts.some((post) => post.footprint.some((pt) => pt.x < 10.5))).toBe(false);
  });
});

describe('interior boundaries', () => {
  it('builds no wall between two enclosed sections with matching rooflines', () => {
    const p = project([sec('a', { x: 0, y: 0, w: 10, d: 10 }), sec('b', { x: 10, y: 0, w: 10, d: 10 })]);
    expect(pieces(p, 'wall').filter((w) => isWallOnX(w, 10))).toHaveLength(0);
  });

  describe('offset sections (inside corners)', () => {
    // b sits 3 ft north of a, so they share x=10 only for y 0..7.
    const offset = (bHeight: number) =>
      project([
        sec('a', { x: 0, y: 0, w: 10, d: 10 }, { lowWallHeight: 9 }),
        sec('b', { x: 10, y: -3, w: 10, d: 10 }, { lowWallHeight: bHeight }),
      ]);

    it('closes both inside corners from the ground', () => {
      const walls = pieces(offset(9), 'wall');
      expect(wallsAt(walls, 10, 6.9, 1).length).toBeGreaterThan(0);
      expect(wallsAt(walls, 10, 0.1, 1).length).toBeGreaterThan(0);
    });

    it('centers the roofline infill on the shared line, between the walls it meets', () => {
      const walls = pieces(offset(14), 'wall');
      const infill = walls.filter((w) => isWallOnX(w, 10) && Math.min(...w.bottom) > 0);
      expect(infill.map((w) => range(ysOf(w)))).toEqual([[-0.25, 7.25]]);
    });
  });

  describe('where three sections meet', () => {
    const quad = (withB: boolean) =>
      project([
        sec('A', { x: 0, y: 0, w: 10, d: 10 }),
        ...(withB ? [sec('B', { x: 10, y: 0, w: 10, d: 10 }, { lowWallHeight: 14 })] : []),
        sec('C', { x: 0, y: 10, w: 10, d: 10 }),
        sec('D', { x: 10, y: 10, w: 10, d: 10 }),
      ]);

    it('closes the inside corner of an L of three sections from the ground', () => {
      expect(wallsAt(pieces(quad(false), 'wall'), 10, 10, 1).length).toBeGreaterThan(0);
    });

    it('closes the corner where the raised walls around a lower section meet', () => {
      // B's raised west wall and its raised south wall (over A's and D's roofs) meet at (10,10).
      const walls = pieces(quad(true), 'wall');
      expect(wallsAt(walls, 10.1, 10.1, 13).length).toBeGreaterThan(0);
    });
  });

  it('builds one infill above the lower roof where rooflines step', () => {
    const p = project([
      sec('a', { x: 0, y: 0, w: 10, d: 10 }, { lowWallHeight: 9 }),
      sec('b', { x: 10, y: 0, w: 10, d: 10 }, { lowWallHeight: 12 }),
    ]);
    const atBoundary = pieces(p, 'wall').filter((w) => isWallOnX(w, 10));
    expect(atBoundary).toHaveLength(1);
    const infill = atBoundary[0];
    expect(infill.sectionId).toBe('b');
    expect(range(ysOf(infill))).toEqual([-0.25, 10.25]);
    // Spans from a's roofline up to b's.
    for (let i = 0; i < 4; i++) expect(infill.top[i] - infill.bottom[i]).toBeCloseTo(3);
  });
});

describe('postPositions', () => {
  it('centers end posts on the corners and keeps spacing within the limit', () => {
    const pos = postPositions(0, 20, 8);
    expect(pos[0]).toBe(0);
    expect(pos.at(-1)).toBe(20);
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
  it('sits entirely below the walls and reaches their outside faces', () => {
    const p = project([sec('a', { x: 0, y: 0, w: 10, d: 10 })]);
    const slab = buildBuildingModel(p).pieces.find((x): x is PrismPiece => x.kind === 'slab')!;
    expect(Math.max(...slab.top)).toBe(0);
    expect(Math.min(...slab.bottom)).toBeLessThan(0);
    expect(range(xsOf(slab))).toEqual([-0.25, 10.25]);
  });
});

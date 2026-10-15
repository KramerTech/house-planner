import { describe, expect, it } from 'vitest';
import { createSection, DEFAULT_SETTINGS } from '../model/defaults';
import { HouseWindow } from '../model/types';
import { edgeAt, exteriorFaces, faceAt, followWindows, lowerRoofAt, pickFace, syncRooflines } from './faces';
import { clipBelow, clipSegment, shapeBounds, shapeOutline, windowFits, windowLines } from './windows';

const settings = DEFAULT_SETTINGS; // 6" walls
// 20×12 main house, 9' walls sloping south from 12'; a 10×12 wing east with a flat 10' roof.
const main = createSection({ x: 0, y: 0, w: 20, d: 12 }, { slopeDir: 'S', pitch: 3, lowWallHeight: 9 });
const wing = createSection({ x: 20, y: 0, w: 10, d: 12 }, { pitch: 0, lowWallHeight: 10 });

describe('wall faces', () => {
  const faces = exteriorFaces([main, wing], settings);

  it('finds each straight exterior wall, outside face out', () => {
    const house = faces.filter((f) => !f.clerestory);
    expect(house.map((f) => f.side)).toEqual(['N', 'E', 'S', 'W']);
    const south = house.find((f) => f.side === 'S')!;
    expect([south.coord, south.from, south.to]).toEqual([12.25, -0.25, 30.25]);
  });

  it('follows the roof along the top: the main roof, then the wing’s', () => {
    const north = faces.find((f) => f.side === 'N' && !f.clerestory)!;
    // Main roof at the north wall's outer face (y = −0.25): 9 + 12.25 × 3/12.
    expect(edgeAt(north.top, 5)).toBeCloseTo(9 + 12.25 * 0.25);
    expect(edgeAt(north.top, 25)).toBeCloseTo(10);
    expect(edgeAt(north.bottom, 5)).toBe(0);
  });

  it('finds the clerestory where the main house rises above the wing', () => {
    const c = faces.filter((f) => f.clerestory);
    expect(c).toHaveLength(1);
    expect(c[0].side).toBe('E');
    expect(c[0].coord).toBe(20.25);
    // From the wing's roof top up to the main roof.
    expect(edgeAt(c[0].bottom, 1)).toBeCloseTo(10 + settings.roofThickness);
    expect(edgeAt(c[0].top, 1)).toBeCloseTo(9 + 11 * 0.25);
  });

  it('defaults to a south wall', () => {
    expect(pickFace(faces, null)?.side).toBe('S');
    expect(pickFace(faces, faces[0].key)).toBe(faces[0]);
  });

  it('keeps windows in their wall when it moves', () => {
    const w: HouseWindow = { id: 'w', host: { side: 'S', coord: 12.25 }, shape: { t: 'rect', u: 4, z: 3, w: 3, h: 4 }, style: 'fixed', grille: { cols: 1, rows: 1 } };
    const deeper = createSection({ x: 0, y: 0, w: 20, d: 14 }, main.roof);
    const after = exteriorFaces([deeper, wing], settings);
    const [moved] = followWindows([w], faces, after, (x) => shapeBounds(x.shape).u0 + 1.5);
    expect(moved.host).toEqual({ side: 'S', coord: 14.25 });
    expect(faceAt(after, moved.host, 5.5)).not.toBeNull();
  });
});

describe('window shapes', () => {
  it('outlines rectangles, circles and arches', () => {
    expect(shapeBounds({ t: 'rect', u: 1, z: 2, w: 3, h: 4 })).toEqual({ u0: 1, u1: 4, z0: 2, z1: 6 });
    const c = shapeBounds({ t: 'circle', u: 5, z: 5, r: 1 });
    expect([c.u0, c.u1, c.z1]).toEqual([4, 6, 6]);
    // An arch's overall height includes its half-round top.
    const a = shapeBounds({ t: 'arch', u: 0, z: 3, w: 4, h: 6 });
    expect([a.u0, a.u1, a.z0, a.z1].map((v) => +v.toFixed(6))).toEqual([0, 4, 3, 9]);
  });

  it('clips grille bars to the shape, concave ones included', () => {
    const l = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]] as [number, number][]; // an L
    expect(clipSegment([-1, 3], [5, 3], l)).toEqual([[[0, 3], [2, 3]]]);
    const lines = windowLines({ shape: { t: 'poly', pts: l }, style: 'fixed', grille: { cols: 2, rows: 2 } });
    // The vertical bar at u = 2 runs only up the L's stem, the horizontal one at z = 2 across its foot.
    expect(lines.bars).toHaveLength(2);
  });

  it('draws the sashes', () => {
    const shape = { t: 'rect' as const, u: 0, z: 0, w: 3, h: 5 };
    expect(windowLines({ shape, style: 'double-hung', grille: { cols: 1, rows: 1 } }).bars).toEqual([[[0, 2.5], [3, 2.5]]]);
    expect(windowLines({ shape, style: 'slider', grille: { cols: 1, rows: 1 } }).bars).toEqual([[[1.5, 0], [1.5, 5]]]);
    expect(windowLines({ shape, style: 'casement', grille: { cols: 1, rows: 1 } }).hinge).toHaveLength(2);
    expect(windowLines({ shape, style: 'fixed', grille: { cols: 3, rows: 2 } }).bars).toHaveLength(3);
  });

  it('fits only inside its wall, clear of doors and other windows', () => {
    const south = exteriorFaces([main], settings).find((f) => f.side === 'S')!;
    const at = (u: number, z: number, h = 4) => ({ t: 'rect' as const, u, z, w: 3, h });
    expect(windowFits(at(4, 3), south, [])).toBe(true);
    expect(windowFits(at(4, 3, 7), south, [])).toBe(false); // through the roof (9' at the south wall)
    expect(windowFits(at(-1, 3), south, [])).toBe(false); // past the corner
    expect(windowFits(at(4, 3), south, [{ u0: 6, u1: 9, z0: 0, z1: 6.67 }])).toBe(false); // into a door
    expect(windowFits(at(4, 3), null, [])).toBe(false);
  });

  it('clips shapes at a height', () => {
    const cut = clipBelow(shapeOutline({ t: 'rect', u: 0, z: 0, w: 2, h: 10 }), 9);
    expect(Math.max(...cut.map((p) => p[1]))).toBe(9);
    expect(clipBelow(shapeOutline({ t: 'rect', u: 0, z: 10, w: 2, h: 2 }), 9)).toEqual([]);
  });
});

describe('roofline windows', () => {
  const roofline = (top: number, lower = false): HouseWindow => ({
    id: 'r',
    host: { side: 'E', coord: 30.25 },
    shape: { t: 'roofline', u: 2, z: 3, w: 6, h: 4, top, bottom: 0, lower },
    style: 'fixed',
    grille: { cols: 1, rows: 1 },
  });

  it('outlines with the top at its slope', () => {
    const b = shapeBounds({ t: 'roofline', u: 2, z: 3, w: 6, h: 4, top: -0.25, bottom: 0, lower: false });
    expect([b.u0, b.u1, b.z0, b.z1]).toEqual([2, 8, 3, 7]);
    expect(shapeOutline({ t: 'roofline', u: 2, z: 3, w: 6, h: 4, top: -0.25, bottom: 0, lower: false })[2]).toEqual([8, 5.5]);
  });

  it('keeps its top at the roof’s pitch as the roof changes', () => {
    // The main house's east wall (x = 20.25 is a clerestory; use a house with only the main section).
    const steeper = createSection({ x: 0, y: 0, w: 20, d: 12 }, { slopeDir: 'S', pitch: 6, lowWallHeight: 9 });
    const east = exteriorFaces([steeper], settings).find((f) => f.side === 'E')!;
    const [w] = syncRooflines([{ ...roofline(0), host: { side: 'E', coord: east.coord } }], [east]);
    // u runs along y on an east face; the roof falls toward the south (larger y) at 6/12.
    expect(w.shape.t === 'roofline' && w.shape.top).toBeCloseTo(-0.5);
  });

  it('follows a lower roof under a clerestory, or a patio roof, only when asked and only if there is one', () => {
    const faces = exteriorFaces([main, wing], settings);
    const clerestory = faces.find((f) => f.clerestory)!;
    expect(lowerRoofAt(clerestory, 6)).not.toBeNull();
    const south = faces.find((f) => f.side === 'S')!;
    expect(lowerRoofAt(south, 6)).toBeNull();

    const sloped = createSection({ x: 20, y: 0, w: 10, d: 12 }, { slopeDir: 'E', pitch: 2, lowWallHeight: 8 });
    const c2 = exteriorFaces([main, sloped], settings).find((f) => f.clerestory)!;
    // The wing's roof falls away from the wall here (east), so along the face it's level.
    const synced = syncRooflines([{ ...roofline(0, true), host: { side: c2.side, coord: c2.coord } }], [c2])[0].shape;
    expect(synced.t === 'roofline' && synced.lower).toBe(true);

    const patio = { ...createSection({ x: 0, y: 12, w: 20, d: 6 }, { slopeDir: 'S', pitch: 2, lowWallHeight: 8 }), patio: { enabled: true, postSpacing: 8 } };
    const porchWall = exteriorFaces([main, patio], settings).find((f) => f.side === 'S')!;
    expect(porchWall.lower).toHaveLength(1);
    expect(edgeAt(porchWall.lower[0].line, 10)).toBeGreaterThan(8);
    // Its slab, as thick as the roof is set (measured plumb on the 2/12 slope).
    expect(porchWall.lower[0].thickness).toBeCloseTo(settings.roofThickness * Math.sqrt(1 + (2 / 12) ** 2));
    // No lower roof under a plain wall: a request to follow one is dropped.
    const plain = syncRooflines([{ ...roofline(0, true), host: { side: 'S', coord: 12.25 }, shape: { t: 'roofline', u: 2, z: 3, w: 6, h: 4, top: 0, bottom: 0, lower: true } }], faces)[0];
    expect(plain.shape.t === 'roofline' && plain.shape.lower).toBe(false);
  });
});

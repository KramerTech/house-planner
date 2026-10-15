import { describe, expect, it } from 'vitest';
import { exteriorFaces } from '../core/floorplan/faces';
import { shapeOutline } from '../core/floorplan/windows';
import { createSection, DEFAULT_SETTINGS } from '../core/model/defaults';
import { buildScene, SceneItem, snapEdge, snapMove, snapSlide } from './window-snap';

// A 20' wide house with a flat roof 10' up: its south face runs u −0.25..20.25, z 0..10.
const face = exteriorFaces([createSection({ x: 0, y: 0, w: 20, d: 12 }, { pitch: 0, lowWallHeight: 10 })], DEFAULT_SETTINGS).find((f) => f.side === 'S')!;
const tol = 0.5;
const rect = (u: number, z: number, w: number, h: number) => shapeOutline({ t: 'rect', u, z, w, h });
const scene = (items: SceneItem[], extras: Partial<Parameters<typeof buildScene>[2]> = {}) =>
  buildScene(face, items, { wall: 0.5, floors: [0], ceilings: [], heights: [], clearances: [], sizes: { w: [], h: [] }, ...extras });
const win = (u0: number, u1: number, z0: number, z1: number): SceneItem => ({ kind: 'window', b: { u0, u1, z0, z1 } });
const door: SceneItem = { kind: 'door', b: { u0: 12, u1: 15, z0: 0, z1: 6 + 8 / 12 } };

describe('moving windows', () => {
  it('centers between the wall’s end and a doorway, showing both gaps', () => {
    // Between the wall's end (−0.25) and the door (12), a 3' window centers at 4.375.
    const s = snapMove(scene([door]), rect(4.4, 3, 3, 3), tol);
    expect(4.4 + s.du).toBeCloseTo(4.375);
    const dims = s.guides.filter((g) => g.t === 'dim' && g.axis === 'u');
    expect(dims).toHaveLength(2);
    expect(dims.map((g) => g.to - g.from)).toEqual([4.625, 4.625]);
  });

  it('lines its top up with another window’s', () => {
    const s = snapMove(scene([win(2, 5, 3, 7)]), rect(9, 3.6, 2, 3.3), tol);
    expect(3.6 + 3.3 + s.dz).toBeCloseTo(7);
    expect(s.guides).toContainEqual({ t: 'line', axis: 'z', at: 7 });
  });

  it('suggests a gap already used between windows', () => {
    // Two windows 2' apart; a third dragged in next to the second lands 2' from it too.
    const sc = scene([win(1, 4, 3, 7), win(6, 9, 3, 7)]);
    expect(sc.gaps.u).toEqual([2]);
    const s = snapMove(sc, rect(11.15, 3, 3, 4), tol);
    expect(11.15 + s.du).toBeCloseTo(11);
    // The new gap and the one it matches.
    expect(s.guides.filter((g) => g.t === 'dim' && Math.abs(g.to - g.from - 2) < 1e-6)).toHaveLength(2);
  });

  it('keeps the same clearance under the roof as other windows', () => {
    const s = snapMove(scene([], { clearances: [1] }), rect(4, 5.1, 3, 3.8), tol);
    // Top at 8.9 + dz should sit 1' under the 10' roof.
    expect(5.1 + 3.8 + s.dz).toBeCloseTo(9);
  });

  it('mirrors another window across the middle of the wall', () => {
    // A window at 2..5 mirrors to 15..18 on a face from −0.25 to 20.25.
    const s = snapMove(scene([win(2, 5, 3, 7)]), rect(15.2, 3.5, 3, 2), tol);
    expect(15.2 + s.du).toBeCloseTo(15);
  });

  it('falls back to whole inches', () => {
    const s = snapMove(scene([]), rect(7.73, 4.41, 1.5, 1.5), 0.01);
    expect((7.73 + s.du) * 12).toBeCloseTo(Math.round(7.73 * 12));
    expect((4.41 + s.dz) * 12).toBeCloseTo(Math.round(4.41 * 12));
  });
});

describe('ceilings', () => {
  it('center a window in its story between floor and ceiling, and line its head up with one', () => {
    // A second floor at 10' over a 1' deck: the ground floor's ceiling is at 9'.
    const sc = scene([], { floors: [0, 10], ceilings: [9] });
    const s = snapMove(sc, rect(4, 3.1, 3, 3), tol);
    expect(3.1 + s.dz).toBeCloseTo(3); // (0 + 9 − 3) / 2
    expect(snapEdge(sc, { u0: 4, u1: 7, z0: 3, z1: 8.8 }, 'z1', 8.8, tol).v).toBeCloseTo(9);
  });
});

describe('resizing windows', () => {
  it('matches another window’s width', () => {
    const r = snapEdge(scene([], { sizes: { w: [3], h: [] } }), { u0: 4, u1: 7.1, z0: 3, z1: 6 }, 'u1', 7.1, tol);
    expect(r.v).toBeCloseTo(7);
  });

  it('centers between its neighbors with the other edge held', () => {
    // Left edge fixed at 4: the right edge goes where the gaps to the wall (−0.25) and the door (12) match.
    const r = snapEdge(scene([door]), { u0: 4, u1: 8, z0: 3, z1: 6 }, 'u1', 7.9, tol);
    expect(r.v).toBeCloseTo(7.75);
  });

  it('keeps the usual clearance under the roof when raising the top', () => {
    const r = snapEdge(scene([], { clearances: [1.5] }), { u0: 4, u1: 7, z0: 3, z1: 8.4 }, 'z1', 8.4, tol, 10);
    expect(r.v).toBeCloseTo(8.5);
  });

  it('lines up with sills and door heads', () => {
    const r = snapEdge(scene([door]), { u0: 2, u1: 5, z0: 3, z1: 6.5 }, 'z1', 6.5, tol);
    expect(r.v).toBeCloseTo(6 + 8 / 12);
  });
});

describe('interior walls behind the face', () => {
  // Interior walls (4.5" thick) meet the south wall at u = 8 and u = 16, floor to 9'.
  const wall = (u: number): SceneItem => ({ kind: 'partition', b: { u0: u - 0.1875, u1: u + 0.1875, z0: 0, z1: 9 } });

  it('centers a window in the room between them, seen from inside', () => {
    // The room runs between the walls' faces, 8.1875..15.8125: a 3' window centers at 10.5.
    const s = snapMove(scene([wall(8), wall(16)]), rect(10.7, 3, 3, 4), tol);
    expect(10.7 + s.du).toBeCloseTo(10.5);
  });

  it('centers in an end room from the inside corner, not the outside one', () => {
    // The end room runs from the inside corner (−0.25 + 0.5) to the wall at 8: center 3.9688 − 1.5.
    const s = snapMove(scene([wall(8)]), rect(2.5, 3, 3, 4), tol);
    expect(2.5 + s.du).toBeCloseTo((0.25 + 7.8125) / 2 - 1.5);
    // Centering on the outside view is offered too, half a wall over.
    const out = snapMove(scene([wall(8)]), rect(2.3, 3, 3, 4), tol);
    expect(2.3 + out.du).toBeCloseTo((-0.25 + 7.8125) / 2 - 1.5);
  });

  it('doesn’t treat the space between a window and an interior wall as a gap to repeat', () => {
    expect(scene([wall(8), win(9, 11, 3, 7)]).gaps.u).toEqual([]);
  });
});

describe('sliding doors', () => {
  const doorAt = (u0: number) => ({ u0, u1: u0 + 3, z0: 0, z1: 6 + 8 / 12 });

  it('lines a door up with a window above it, by the same rules as windows', () => {
    const s = snapSlide(scene([win(4, 7, 8, 9)]), doorAt(4.2), tol);
    expect(4.2 + s.du).toBeCloseTo(4);
    expect(s.guides).toContainEqual({ t: 'line', axis: 'u', at: 4 });
  });

  it('centers between its neighbors, showing both gaps, and only ever moves sideways', () => {
    // Between the wall's end (−0.25) and a window at 12..15 at door height: centered at 4.375.
    const s = snapSlide(scene([win(12, 15, 3, 6)]), doorAt(4.4), tol);
    expect(4.4 + s.du).toBeCloseTo(4.375);
    expect(s.guides.filter((g) => g.t === 'dim' && g.axis === 'u')).toHaveLength(2);
    expect(s.guides.every((g) => g.axis === 'u')).toBe(true);
  });

  it('falls back to whole inches', () => {
    const s = snapSlide(scene([]), doorAt(2.53), tol / 10);
    expect((2.53 + s.du) * 12).toBeCloseTo(Math.round(2.53 * 12));
  });
});

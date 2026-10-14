import { createSection } from '../model/defaults';
import { Rect, Section } from '../model/types';
import { resolveHandle } from '../../editor/side-drag';
import { resolveSideResize, sideResizeRange } from './side-resize';

const sec = (id: string, rect: Rect): Section => ({ ...createSection(rect), id });
const rects = (layout: Section[] | null) => Object.fromEntries((layout ?? []).map((s) => [s.id, s.rect]));

describe('resolveSideResize', () => {
  // L on the left; T and B stacked on its right, meeting at L's horizontal centerline.
  const L = sec('L', { x: 0, y: 0, w: 10, d: 10 });
  const T = sec('T', { x: 10, y: -5, w: 10, d: 10 });
  const B = sec('B', { x: 10, y: 5, w: 10, d: 10 });
  const Q = sec('Q', { x: 0, y: -5, w: 5, d: 5 }); // quarter square on top of L, flush left
  const seedL = { sectionId: 'L', side: 'E' as const };

  it('pushes neighbors only as far as the dragged section grows into them', () => {
    const r = rects(resolveSideResize([L, T, B], 'L', seedL, 14));
    expect(r['L']).toEqual({ x: 0, y: 0, w: 14, d: 10 });
    expect(r['T']).toEqual({ x: 14, y: -5, w: 6, d: 10 });
    expect(r['B']).toEqual({ x: 14, y: 5, w: 6, d: 10 });
  });

  it('pulls neighbors that would otherwise be cut off', () => {
    const r = rects(resolveSideResize([L, T, B], 'L', seedL, 6));
    expect(r['T']).toEqual({ x: 6, y: -5, w: 14, d: 10 });
    expect(r['B']).toEqual({ x: 6, y: 5, w: 14, d: 10 });
    expect(sideResizeRange([L, T, B], 'L', seedL)).toEqual({ min: 1, max: 19 });
  });

  it('is springy: secondary resizes are recomputed from the original layout', () => {
    const original = [L, T, B];
    resolveSideResize(original, 'L', seedL, 14);
    expect(resolveSideResize(original, 'L', seedL, 10)).toEqual(original);
  });

  it('stops at a section off the dragged line; once on the line it can be pushed', () => {
    const all = [L, T, B, Q];
    // T is pulled west and would run into Q, whose side is at x=5, not on the line x=10.
    expect(sideResizeRange(all, 'L', seedL)).toEqual({ min: 5, max: 19 });

    const atStop = resolveSideResize(all, 'L', seedL, 5)!;
    // Everything stays connected through Q now, so L can shrink on its own…
    const alone = rects(resolveSideResize(atStop, 'L', seedL, 3));
    expect(alone['L']).toEqual({ x: 0, y: 0, w: 3, d: 10 });
    expect(alone['T']).toEqual({ x: 5, y: -5, w: 15, d: 10 });
    // …and growing T west pushes both Q and L, which are now on its line.
    const pushed = rects(resolveSideResize(atStop, 'L', { sectionId: 'T', side: 'W' }, 3));
    expect(pushed['T']).toEqual({ x: 3, y: -5, w: 17, d: 10 });
    expect(pushed['Q']).toEqual({ x: 0, y: -5, w: 3, d: 5 });
    expect(pushed['L']).toEqual({ x: 0, y: 0, w: 3, d: 10 });
    expect(pushed['B']).toEqual({ x: 5, y: 5, w: 15, d: 10 });
  });

  it('leaves a collinear side that only meets the line at a corner alone (L shape)', () => {
    const A = sec('A', { x: 0, y: 0, w: 10, d: 10 });
    const C = sec('C', { x: 0, y: 10, w: 10, d: 10 });
    const D = sec('D', { x: 10, y: 10, w: 10, d: 10 });
    const all = [A, C, D];
    const seed = { sectionId: 'A', side: 'E' as const };
    expect(sideResizeRange(all, 'A', seed)).toEqual({ min: 1, max: 500 });
    const r = rects(resolveSideResize(all, 'A', seed, 4));
    expect(r['C']).toEqual(C.rect);
    expect(r['D']).toEqual(D.rect);
  });

  it('resizes a section on its own when nothing else has to move (offset 2x2)', () => {
    const TL = sec('TL', { x: 0, y: -5, w: 10, d: 10 });
    const BL = sec('BL', { x: 0, y: 5, w: 10, d: 10 });
    const TR = sec('TR', { x: 10, y: 0, w: 10, d: 10 });
    const BR = sec('BR', { x: 10, y: 10, w: 10, d: 10 });
    const all = [TL, BL, TR, BR];
    const seed = { sectionId: 'TL', side: 'E' as const };

    const shrunk = rects(resolveSideResize(all, 'TL', seed, 4));
    expect(shrunk['TL']).toEqual({ x: 0, y: -5, w: 4, d: 10 });
    expect([shrunk['BL'], shrunk['TR'], shrunk['BR']]).toEqual([BL.rect, TR.rect, BR.rect]);

    const grown = rects(resolveSideResize(all, 'TL', seed, 13));
    expect(grown['TR']).toEqual({ x: 13, y: 0, w: 7, d: 10 }); // only TR is in the way
    expect([grown['BL'], grown['BR']]).toEqual([BL.rect, BR.rect]);
  });

  it('pulls a neighbor to keep the dragged section itself attached', () => {
    const H = sec('H', { x: 10, y: 0, w: 10, d: 10 });
    const R = sec('R', { x: 6, y: 2, w: 4, d: 4 });
    const r = rects(resolveSideResize([H, R], 'H', { sectionId: 'R', side: 'E' }, 8));
    expect(r['R']).toEqual({ x: 6, y: 2, w: 2, d: 4 });
    expect(r['H']).toEqual({ x: 8, y: 0, w: 12, d: 10 });
  });

  it('never pushes a section past its minimum size', () => {
    const A = sec('A', { x: 0, y: 0, w: 10, d: 10 });
    const Bn = sec('B', { x: 10, y: 0, w: 5, d: 10 });
    const X = sec('X', { x: 15, y: 0, w: 5, d: 10 });
    expect(sideResizeRange([A, Bn, X], 'A', { sectionId: 'A', side: 'E' }).max).toBe(14);
  });
});

describe('resolveHandle', () => {
  it('at a corner, picks the side matching the drag axis', () => {
    const corner = [
      { sectionId: 'c', side: 'E' as const },
      { sectionId: 'c', side: 'N' as const },
    ];
    expect(resolveHandle(corner, { x: 6, y: 1 })).toEqual({ sectionId: 'c', side: 'E' });
    expect(resolveHandle(corner, { x: 1, y: 6 })).toEqual({ sectionId: 'c', side: 'N' });
  });
});

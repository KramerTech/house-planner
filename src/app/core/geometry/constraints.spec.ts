import { createSection } from '../model/defaults';
import { Rect, Section } from '../model/types';
import { canDeleteSection, planSectionFromSegment, validateLayout } from './constraints';
import { sideSegments } from './edges';

const sec = (id: string, rect: Rect): Section => ({ ...createSection(rect), id });

describe('validateLayout', () => {
  const a = sec('a', { x: 0, y: 0, w: 10, d: 10 });
  it('accepts a connected, non-overlapping layout', () => {
    expect(validateLayout([a, sec('b', { x: 0, y: 10, w: 3, d: 3 })], 'a')).toBeNull();
  });
  it('rejects overlap, disconnection and corner-only contact', () => {
    expect(validateLayout([a, sec('b', { x: 5, y: 5, w: 10, d: 10 })], 'a')).toBe('overlap');
    expect(validateLayout([a, sec('b', { x: 11, y: 0, w: 3, d: 3 })], 'a')).toBe('disconnected');
    expect(validateLayout([a, sec('b', { x: 10, y: 10, w: 3, d: 3 })], 'a')).toBe('disconnected');
  });
});

describe('planSectionFromSegment', () => {
  it('spans the segment and is clipped by whatever is in the way', () => {
    const a = sec('a', { x: 0, y: 0, w: 10, d: 10 });
    const b = sec('b', { x: 10, y: 0, w: 4, d: 4 });
    const blocker = sec('c', { x: 14, y: 0, w: 4, d: 30 });
    const all = [a, b, blocker];
    const [free] = sideSegments(a, 'E', all).filter((s) => !s.neighborId);
    expect(free).toMatchObject({ from: 4, to: 10, coord: 10 });
    expect(planSectionFromSegment(all, free, 12)).toEqual({ x: 10, y: 4, w: 4, d: 6 });
  });

  it('uses the preferred depth when there is room', () => {
    const a = sec('a', { x: 0, y: 0, w: 10, d: 10 });
    const [north] = sideSegments(a, 'N', [a]);
    expect(planSectionFromSegment([a], north, 12)).toEqual({ x: 0, y: -12, w: 10, d: 12 });
  });
});

describe('canDeleteSection', () => {
  it('protects the root and sections others depend on', () => {
    const a = sec('a', { x: 0, y: 0, w: 10, d: 10 });
    const b = sec('b', { x: 10, y: 0, w: 10, d: 10 });
    const c = sec('c', { x: 20, y: 0, w: 10, d: 10 });
    const all = [a, b, c];
    expect(canDeleteSection(all, 'a', 'a')).toBe(false);
    expect(canDeleteSection(all, 'a', 'b')).toBe(false);
    expect(canDeleteSection(all, 'a', 'c')).toBe(true);
  });
});


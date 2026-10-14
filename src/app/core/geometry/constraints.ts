import { MIN_SECTION_SIZE, WORLD_LIMIT } from '../model/defaults';
import { Rect, Section } from '../model/types';
import { isConnected } from './graph';
import { interiorsOverlap, intervalsOverlap, outwardSign, sideAxis, spanAcross, x0, x1, y0, y1 } from './rect';
import { SideSegment } from './edges';

/**
 * Layout invariants. Every layout mutation is checked against these before it is
 * committed, so the section graph can never become corrupted.
 */
export type LayoutViolation =
  | 'non-integer'
  | 'too-small'
  | 'out-of-bounds'
  | 'overlap'
  | 'disconnected'
  | 'missing-root';

export function validateLayout(sections: readonly Section[], rootId: string): LayoutViolation | null {
  if (!sections.some((s) => s.id === rootId)) return 'missing-root';
  for (const { rect: r } of sections) {
    if (![r.x, r.y, r.w, r.d].every(Number.isInteger)) return 'non-integer';
    if (r.w < MIN_SECTION_SIZE || r.d < MIN_SECTION_SIZE) return 'too-small';
    if (x0(r) < -WORLD_LIMIT || y0(r) < -WORLD_LIMIT || x1(r) > WORLD_LIMIT || y1(r) > WORLD_LIMIT) {
      return 'out-of-bounds';
    }
  }
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      if (interiorsOverlap(sections[i].rect, sections[j].rect)) return 'overlap';
    }
  }
  if (!isConnected(sections, rootId)) return 'disconnected';
  return null;
}

/**
 * Distance from a line at `coord` (moving outward in direction `sign` along `axis`)
 * to the nearest section whose cross-span overlaps `span`. Capped at the world limit.
 */
export function clearanceFrom(
  sections: readonly Section[],
  axis: 'x' | 'y',
  sign: 1 | -1,
  coord: number,
  span: { lo: number; hi: number },
  excludeId?: string,
): number {
  let limit = sign > 0 ? WORLD_LIMIT : -WORLD_LIMIT;
  for (const o of sections) {
    if (o.id === excludeId) continue;
    if (!intervalsOverlap(span, spanAcross(o.rect, axis))) continue;
    const near = axis === 'x' ? (sign > 0 ? x0(o.rect) : x1(o.rect)) : sign > 0 ? y0(o.rect) : y1(o.rect);
    if (sign > 0 && near >= coord) limit = Math.min(limit, near);
    if (sign < 0 && near <= coord) limit = Math.max(limit, near);
  }
  return Math.abs(limit - coord);
}

export function replaceRect(sections: readonly Section[], id: string, rect: Rect): Section[] {
  return sections.map((s) => (s.id === id ? { ...s, rect } : s));
}

/**
 * Footprint for a new section placed against a free segment: it spans the segment
 * exactly and extends outward by the preferred depth, or less if something is in the way.
 * Returns null if there is no room.
 */
export function planSectionFromSegment(
  sections: readonly Section[],
  seg: SideSegment,
  preferredDepth: number,
): Rect | null {
  const axis = sideAxis(seg.side);
  const sign = outwardSign(seg.side);
  const span = { lo: seg.from, hi: seg.to };
  const room = Math.floor(clearanceFrom(sections, axis, sign, seg.coord, span));
  const depth = Math.min(Math.max(MIN_SECTION_SIZE, Math.round(preferredDepth)), room);
  if (depth < MIN_SECTION_SIZE) return null;

  const len = seg.to - seg.from;
  switch (seg.side) {
    case 'N':
      return { x: seg.from, y: seg.coord - depth, w: len, d: depth };
    case 'S':
      return { x: seg.from, y: seg.coord, w: len, d: depth };
    case 'W':
      return { x: seg.coord - depth, y: seg.from, w: depth, d: len };
    case 'E':
      return { x: seg.coord, y: seg.from, w: depth, d: len };
  }
}

export function canDeleteSection(sections: readonly Section[], rootId: string, id: string): boolean {
  if (id === rootId) return false;
  return isConnected(
    sections.filter((s) => s.id !== id),
    rootId,
  );
}

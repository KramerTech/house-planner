import { Section, Side } from '../model/types';
import { oppositeSide, overlapLength, sideCoord, sideSpan } from './rect';

/**
 * A piece of one side of a section. Sides are split wherever the set of sections
 * on the other side of the line changes, so each segment is either entirely free
 * (exterior) or entirely shared with exactly one neighbor.
 */
export interface SideSegment {
  sectionId: string;
  side: Side;
  /** Coordinate of the line the side lies on (x for E/W, y for N/S). */
  coord: number;
  /** Start/end along the line (x-range for N/S, y-range for E/W). */
  from: number;
  to: number;
  /** Section sharing this segment, or null if the segment faces open space. */
  neighborId: string | null;
}

/** Sections whose opposite side lies on the same line as `side` of `section` and overlaps it. */
export function neighborsOnSide(section: Section, side: Side, all: readonly Section[]): Section[] {
  const coord = sideCoord(section.rect, side);
  const span = sideSpan(section.rect, side);
  const opp = oppositeSide(side);
  return all.filter(
    (o) =>
      o.id !== section.id &&
      sideCoord(o.rect, opp) === coord &&
      overlapLength(span, sideSpan(o.rect, opp)) > 0,
  );
}

/** Splits one side into free/shared segments, ordered along the line. */
export function sideSegments(section: Section, side: Side, all: readonly Section[]): SideSegment[] {
  const coord = sideCoord(section.rect, side);
  const span = sideSpan(section.rect, side);
  const opp = oppositeSide(side);

  // Neighbor intervals clipped to this side. Neighbors never overlap each other,
  // so these intervals are disjoint.
  const shared = neighborsOnSide(section, side, all)
    .map((o) => {
      const s = sideSpan(o.rect, opp);
      return { lo: Math.max(s.lo, span.lo), hi: Math.min(s.hi, span.hi), id: o.id };
    })
    .sort((a, b) => a.lo - b.lo);

  const out: SideSegment[] = [];
  const push = (from: number, to: number, neighborId: string | null) => {
    if (to > from) out.push({ sectionId: section.id, side, coord, from, to, neighborId });
  };

  let cursor = span.lo;
  for (const s of shared) {
    push(cursor, s.lo, null);
    push(s.lo, s.hi, s.id);
    cursor = s.hi;
  }
  push(cursor, span.hi, null);
  return out;
}

export function allSideSegments(section: Section, all: readonly Section[]): SideSegment[] {
  return (['N', 'E', 'S', 'W'] as const).flatMap((side) => sideSegments(section, side, all));
}

/** Segments of a section that face open space — the targets for adding new sections. */
export function freeSegments(all: readonly Section[]): SideSegment[] {
  return all.flatMap((s) => allSideSegments(s, all).filter((seg) => seg.neighborId === null));
}

import { Side } from '../model/types';
import { Box, uniqueSorted } from './region';

/** One dimensioned stretch of the building's outside, seen from one side. */
export interface DimPiece {
  /** Extent along the side (x for N/S, y for E/W). */
  from: number;
  to: number;
  /** Coordinate of the outside face across the side (y for N/S, x for E/W). */
  face: number;
}

export interface SideDims {
  side: Side;
  /** The faces seen from this side, in order: the per-segment dimension string. */
  pieces: DimPiece[];
  /** Overall extent along the side. */
  from: number;
  to: number;
  /** The outermost face on this side (where dimension lines are measured out from). */
  extreme: number;
}

/**
 * Exterior dimension strings for a building outline (its outside faces, as a union
 * of boxes): looking at the building from each side, the faces you see in turn —
 * every jog in the outline starts a new piece — plus the overall extent.
 */
export function exteriorDims(boxes: readonly Box[]): SideDims[] {
  if (boxes.length === 0) return [];
  return (['N', 'E', 'S', 'W'] as Side[]).map((side) => {
    const horizontal = side === 'N' || side === 'S';
    const lo = (b: Box) => (horizontal ? b.x0 : b.y0);
    const hi = (b: Box) => (horizontal ? b.x1 : b.y1);
    const near = (b: Box) => (side === 'N' ? b.y0 : side === 'S' ? b.y1 : side === 'W' ? b.x0 : b.x1);
    const better = side === 'N' || side === 'W' ? Math.min : Math.max;

    const cuts = uniqueSorted(boxes.flatMap((b) => [lo(b), hi(b)]));
    const pieces: DimPiece[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const mid = (cuts[i] + cuts[i + 1]) / 2;
      const covering = boxes.filter((b) => lo(b) < mid && hi(b) > mid);
      if (covering.length === 0) continue;
      const face = better(...covering.map(near));
      const prev = pieces.at(-1);
      if (prev && Math.abs(prev.face - face) < 1e-9 && Math.abs(prev.to - cuts[i]) < 1e-9) prev.to = cuts[i + 1];
      else pieces.push({ from: cuts[i], to: cuts[i + 1], face });
    }
    return {
      side,
      pieces,
      from: pieces[0]?.from ?? 0,
      to: pieces.at(-1)?.to ?? 0,
      extreme: better(...pieces.map((p) => p.face)),
    };
  });
}

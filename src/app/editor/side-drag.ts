import { sideAxis, sideCoord, snapLayout } from '../core/geometry/rect';
import { SideRange, SideRef } from '../core/geometry/side-resize';
import { Section } from '../core/model/types';
import { clamp, Point } from './viewport';

/** Screen distance (px) the pointer must travel before a side drag commits to a handle. */
export const DRAG_START_THRESHOLD_PX = 3;

export interface ActiveSideDrag {
  seed: SideRef;
  axis: 'x' | 'y';
  /** Layout when the drag began; every frame is resolved from it so secondary resizes spring back. */
  original: readonly Section[];
  range: SideRange;
  /** Pointer position minus side coordinate at grab time, so the side doesn't jump to the cursor. */
  grabOffset: number;
  lastValue: number;
  /** Snap step (ft). */
  step: number;
}

/**
 * Picks which handle a drag should move. Candidates arrive sorted best-first (nearest,
 * then the section the pointer is inside), so at a corner the drag direction picks the
 * axis and the first candidate on it wins.
 */
export function resolveHandle(candidates: readonly SideRef[], delta: Point): SideRef {
  const axis = Math.abs(delta.x) >= Math.abs(delta.y) ? 'x' : 'y';
  return candidates.find((h) => sideAxis(h.side) === axis) ?? candidates[0];
}

export function beginSideDrag(
  seed: SideRef,
  original: readonly Section[],
  range: SideRange,
  pointerWorld: Point,
  step: number,
): ActiveSideDrag {
  const section = original.find((s) => s.id === seed.sectionId)!;
  const axis = sideAxis(seed.side);
  const coord = sideCoord(section.rect, seed.side);
  const pointerAxis = axis === 'x' ? pointerWorld.x : pointerWorld.y;
  return { seed, axis, original, range, grabOffset: pointerAxis - coord, lastValue: coord, step };
}

/** The snapped, clamped side coordinate for a pointer position. */
export function dragValue(drag: ActiveSideDrag, pointerWorld: Point): number {
  const pointerAxis = drag.axis === 'x' ? pointerWorld.x : pointerWorld.y;
  return clamp(snapLayout(pointerAxis - drag.grabOffset, drag.step), drag.range.min, drag.range.max);
}

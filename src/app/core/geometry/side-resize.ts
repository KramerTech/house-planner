import { WORLD_LIMIT } from '../model/defaults';
import { Section, Side, SIDES } from '../model/types';
import { validateLayout } from './constraints';
import { reachableFrom } from './graph';
import { interiorsOverlap, outwardSign, overlapLength, quantize, sideAxis, sideCoord, sideSpan, withSideAt } from './rect';

/** One side of one section. */
export interface SideRef {
  sectionId: string;
  side: Side;
}

export interface SideRange {
  min: number;
  max: number;
}

/**
 * Moves one side of one section to `v`, adjusting other sections only where they
 * have to give way, and returns the resulting layout — or null if no valid layout
 * exists for that position.
 *
 * Secondary adjustments (always computed from `original`, so they spring back as
 * soon as the dragged side retreats):
 *   - Push: a section the moving geometry would overlap shrinks, moving its facing
 *     side to `v`.
 *   - Pull: a section that would otherwise lose its connection to the root grows
 *     to follow, moving its facing side to `v`.
 * Only sides that lay on the dragged side's original line can be pushed or pulled.
 * Anything else in the way stops the drag; once the line meets it and the drag is
 * released, its side is on the line and the next drag can move it too.
 */
export function resolveSideResize(
  original: readonly Section[],
  rootId: string,
  seed: SideRef,
  v: number,
): Section[] | null {
  const dragged = original.find((s) => s.id === seed.sectionId);
  if (!dragged) return null;
  const axis = sideAxis(seed.side);
  const c = sideCoord(dragged.rect, seed.side);
  if (v === c) return [...original];
  const dir = Math.sign(v - c);

  // The side of each section lying on the original line (at most one per section).
  const onLine = new Map<string, Side>();
  for (const s of original) {
    for (const side of SIDES) {
      if (sideAxis(side) === axis && sideCoord(s.rect, side) === c) onLine.set(s.id, side);
    }
  }
  /** Moving a section's on-line side to v grows it (+1), shrinks it (-1), or it has none (0). */
  const effect = (id: string): number => {
    const side = onLine.get(id);
    return side ? outwardSign(side) * dir : 0;
  };

  const moved = new Set<string>([dragged.id]);
  const build = () =>
    original.map((s) => (moved.has(s.id) ? { ...s, rect: withSideAt(s.rect, onLine.get(s.id)!, v) } : s));

  for (let pass = 0; pass <= original.length; pass++) {
    const layout = build();

    // 1. Push: resolve overlaps by shrinking whichever section can give way.
    let pushed = false;
    for (let i = 0; i < layout.length; i++) {
      for (let j = i + 1; j < layout.length; j++) {
        if (!interiorsOverlap(layout[i].rect, layout[j].rect)) continue;
        const target = [layout[i], layout[j]].find((s) => !moved.has(s.id) && effect(s.id) < 0);
        if (!target) return null; // something that can't move is in the way
        moved.add(target.id);
        pushed = true;
      }
    }
    if (pushed) continue;

    // 2. Pull: reconnect sections that the move cut off from the root.
    const reach = reachableFrom(layout, rootId);
    if (reach.size === layout.length) return validateLayout(layout, rootId) ? null : layout;

    // Candidates grow toward v and shared wall length with a moving section across the
    // line; pull them if either side of that shared wall is now cut off.
    const sharesWall = (a: Section, b: Section) =>
      overlapLength(sideSpan(a.rect, onLine.get(a.id)!), sideSpan(b.rect, onLine.get(b.id)!)) > 0;
    const movers = original.filter((s) => moved.has(s.id));
    const pulls = original.filter(
      (s) =>
        !moved.has(s.id) &&
        effect(s.id) > 0 &&
        movers.some((m) => sharesWall(s, m) && (!reach.has(s.id) || !reach.has(m.id))),
    );
    if (pulls.length === 0) return null;
    pulls.forEach((s) => moved.add(s.id));
  }
  return null;
}

/**
 * The contiguous range of coordinates the side can be dragged to, walking outward
 * one snap `step` at a time (on the step's grid) from its current position.
 */
export function sideResizeRange(original: readonly Section[], rootId: string, seed: SideRef, step = 1): SideRange {
  const section = original.find((s) => s.id === seed.sectionId);
  if (!section) throw new Error(`Unknown section ${seed.sectionId}`);
  const c = sideCoord(section.rect, seed.side);
  const reach = (dir: 1 | -1): number => {
    let last = c;
    // First grid line beyond c in this direction, then one step at a time.
    let n = dir > 0 ? Math.floor(c / step + 1e-9) + 1 : Math.ceil(c / step - 1e-9) - 1;
    for (let i = 0; i < (2 * WORLD_LIMIT) / step; i++, n += dir) {
      const v = quantize(n * step);
      if (!resolveSideResize(original, rootId, seed, v)) break;
      last = v;
    }
    return last;
  };
  return { min: reach(-1), max: reach(1) };
}

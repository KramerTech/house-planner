import { DoorPlacement, doorHeight } from '../../core/floorplan/doors';
import { Floor } from '../../core/model/types';
import { PlanRect, PrismPiece } from './building-model';
import { rectPrism } from './prism-ops';

const IN = 1 / 12;

/** Door colors: painted interior leaves, stained exterior ones, and brass knobs. */
export const DOOR_COLORS = { interior: '#f4f3ef', exterior: '#7a5233', hardware: '#c2a25e' } as const;

/** Leaf thickness (ft): 1 3/8" inside, 1 3/4" for exterior doors. */
const LEAF = { interior: 1.375 * IN, exterior: 1.75 * IN };

/**
 * A six-panel leaf, in inches for a standard 80" leaf (scaled to others): the rails,
 * bottom to top, as [from, to]. The panels fill the gaps between them, in pairs either
 * side of a center mullion: medium at the bottom, tall in the middle, short at the top.
 */
const SIX_PANEL = {
  height: 80,
  rails: [
    [0, 9],
    [26, 34],
    [61, 65.5],
    [75.5, 80],
  ],
  stile: 4.5,
  mullion: 4.5,
  /** How far the panels sit back from each face. */
  recess: 0.25,
} as const;

/** Swing-door knobs: height, backset from the latch edge, rose and knob sizes and projections (in). */
const KNOB = { height: 36, backset: 2.375, rose: 2.5, roseProud: 0.3, size: 1.75, proud: 2.4 };

/** How far interior swing doors stand open. */
const OPEN_ANGLE = Math.PI / 4;

/** Gap between a pair of leaves, so they read as two (ft). */
const PAIR_GAP = 0.125 * IN;

/** Barn doors hang just off the wall face and overlap the opening a little, as drawn in plan (ft). */
const BARN = { standoff: 0.08, overlap: 0.15, head: 1.5 * IN };

/** Sectional garage door: thickness, how many sections, and the groove between them (ft). */
const GARAGE = { thickness: 2 / 12, sections: 4, groove: 0.75 / 12, grooveDepth: 0.5 / 12, color: '#eef0f1' };

/**
 * A door's leaves: six-panel leaves (white inside, brown in exterior walls), a
 * sectional garage door, or nothing for a cased opening. Interior swing doors stand
 * open 45° toward their swing side; the rest are shown closed.
 */
export function doorPieces(p: DoorPlacement, floor: Floor): PrismPiece[] {
  const { door, at } = p;
  if (door.kind === 'opening') return [];
  if (door.kind === 'garage') return garageDoor(p, floor);

  const thick = p.exterior ? LEAF.exterior : LEAF.interior;
  const color = p.exterior ? DOOR_COLORS.exterior : DOOR_COLORS.interior;
  const face = door.swing > 0 ? p.c1 : p.c0; // the face the door opens toward
  const [a0, a1] = [at - door.width / 2, at + door.width / 2];
  const z0 = floor.elevation;
  const z1 = z0 + doorHeight(door);

  switch (door.kind) {
    case 'single': {
      const c: [number, number] = [face - door.swing * thick, face];
      const leaf = [...sixPanel(p, color, a0, a1, c, z0, z1), ...knob(p, door.hinge > 0 ? a0 : a1, door.hinge > 0 ? 1 : -1, c, z0)];
      return p.exterior ? leaf : swingOpen(p, leaf, door.hinge > 0 ? a1 : a0, door.hinge, face);
    }
    case 'double': {
      const c: [number, number] = [face - door.swing * thick, face];
      const left = [...sixPanel(p, color, a0, at - PAIR_GAP / 2, c, z0, z1), ...knob(p, at - PAIR_GAP / 2, -1, c, z0)];
      const right = [...sixPanel(p, color, at + PAIR_GAP / 2, a1, c, z0, z1), ...knob(p, at + PAIR_GAP / 2, 1, c, z0)];
      if (p.exterior) return [...left, ...right];
      return [...swingOpen(p, left, a0, -1, face), ...swingOpen(p, right, a1, 1, face)];
    }
    case 'pocket': {
      const mid = (p.c0 + p.c1) / 2;
      return sixPanel(p, color, a0, a1, [mid - thick / 2, mid + thick / 2], z0, z1);
    }
    case 'barn': {
      const near = face + door.swing * BARN.standoff;
      const s0 = Math.max(a0 - BARN.overlap, p.lo);
      const s1 = Math.min(a1 + BARN.overlap, p.hi);
      return sixPanel(p, color, s0, s1, [near, near + door.swing * thick], z0, z1 + BARN.head);
    }
  }
}

/**
 * One six-panel leaf from a0 to a1 along the wall, c across it, z0 to z1: a core at
 * panel thickness, with the stiles, rails and mullions at full thickness over it, so
 * the panels show recessed on both faces once the pieces are merged.
 */
function sixPanel(p: DoorPlacement, color: string, a0: number, a1: number, c: [number, number], z0: number, z1: number): PrismPiece[] {
  const [c0, c1] = [Math.min(...c), Math.max(...c)];
  const scale = (z1 - z0) / SIX_PANEL.height;
  const z = (inches: number) => z0 + inches * scale;
  const stile = Math.min(SIX_PANEL.stile * IN, (a1 - a0) / 6);
  const mullion = Math.min(SIX_PANEL.mullion * IN, (a1 - a0) / 6);
  const mid = (a0 + a1) / 2;
  const recess = Math.min(SIX_PANEL.recess * IN, (c1 - c0) / 4);

  const base = { kind: 'door' as const, sectionId: p.door.id, color };
  const piece = (from: number, to: number, b: number, t: number, inset = 0) =>
    rectPrism(base, band(p, from, to, c0 + inset, c1 - inset), () => b, () => t);

  const out = [piece(a0, a1, z0, z1, recess), piece(a0, a0 + stile, z0, z1), piece(a1 - stile, a1, z0, z1)];
  const rails = SIX_PANEL.rails;
  rails.forEach(([from, to], i) => {
    out.push(piece(a0 + stile, a1 - stile, z(from), z(to)));
    const next = rails[i + 1];
    if (next) out.push(piece(mid - mullion / 2, mid + mullion / 2, z(to), z(next[0])));
  });
  return out;
}

/**
 * A knob on each face of a swing leaf: a square rose with a knob on it, `backset` in
 * from the latch edge at `edge` (`inward` is the direction from that edge into the leaf).
 */
function knob(p: DoorPlacement, edge: number, inward: 1 | -1, c: [number, number], z0: number): PrismPiece[] {
  const [c0, c1] = [Math.min(...c), Math.max(...c)];
  const center = edge + inward * (KNOB.backset * IN);
  const h = z0 + KNOB.height * IN;
  const base = { kind: 'door' as const, sectionId: p.door.id, color: DOOR_COLORS.hardware };
  const square = (size: number, proud: number) => {
    const r = (size * IN) / 2;
    return rectPrism(base, band(p, center - r, center + r, c0 - proud * IN, c1 + proud * IN), () => h - r, () => h + r);
  };
  return [square(KNOB.rose, KNOB.roseProud), square(KNOB.size, KNOB.proud)];
}

/**
 * A leaf's pieces turned open on hinges at `hingeAt` along the wall, on the face it
 * swings toward (`hinge` is which end that is: +1 the larger coordinate), so its free
 * end swings out toward that side.
 */
function swingOpen(p: DoorPlacement, pieces: PrismPiece[], hingeAt: number, hinge: 1 | -1, face: number): PrismPiece[] {
  // Turning the leaf (pointing from its hinge along the wall) toward the swing side.
  const sign = p.axis === 'x' ? -hinge * p.door.swing : hinge * p.door.swing;
  const pivot = p.axis === 'x' ? { x: hingeAt, y: face } : { x: face, y: hingeAt };
  const turn = { ...pivot, angle: sign * OPEN_ANGLE };
  return pieces.map((piece) => ({ ...piece, turn }));
}

/** A plan rect from a0 to a1 along the door's wall and c0 to c1 across it. */
function band(p: DoorPlacement, a0: number, a1: number, c0: number, c1: number): PlanRect {
  const [lo, hi] = [Math.min(c0, c1), Math.max(c0, c1)];
  return p.axis === 'x' ? { x0: a0, x1: a1, y0: lo, y1: hi } : { x0: lo, x1: hi, y0: a0, y1: a1 };
}

/**
 * A closed overhead garage door in its opening: stacked sections set just inside
 * the wall's inner face (the side the door opens toward), with a shallow groove
 * between each pair, recessed from the outside.
 */
function garageDoor(p: DoorPlacement, floor: Floor): PrismPiece[] {
  const { door, at } = p;
  const face = door.swing > 0 ? p.c1 : p.c0;
  const out = face - door.swing * GARAGE.thickness; // the outside surface
  const section = (from: number, to: number) => band(p, at - door.width / 2, at + door.width / 2, from, to);
  const base = { kind: 'door' as const, sectionId: floor.id, color: GARAGE.color };
  const h = doorHeight(door);
  const step = h / GARAGE.sections;
  const g = GARAGE.groove / 2;
  const pieces: PrismPiece[] = [];
  for (let i = 0; i < GARAGE.sections; i++) {
    const z0 = floor.elevation + i * step + (i > 0 ? g : 0);
    const z1 = floor.elevation + (i + 1) * step - (i < GARAGE.sections - 1 ? g : 0);
    pieces.push(rectPrism(base, section(out, face), () => z0, () => z1));
    if (i > 0) {
      const z = floor.elevation + i * step;
      pieces.push(rectPrism(base, section(out + door.swing * GARAGE.grooveDepth, face), () => z - g, () => z + g));
    }
  }
  return pieces;
}

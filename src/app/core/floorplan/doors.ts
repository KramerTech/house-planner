import { STORY } from '../model/defaults';
import { Door, DoorKind, Floor, Side } from '../model/types';
import { FloorRegion } from './floor-region';
import { Box } from './region';
import { Axis, clampAlong, wallGeoms } from './wall-graph';

const inches = (list: number[]) => list.map((n) => n / 12);

/** Door widths offered in the editor (ft): standard single leaves, and pairs. */
export const SINGLE_DOOR_WIDTHS = inches([24, 28, 30, 32, 36]);
export const DOUBLE_DOOR_WIDTHS = inches([60, 64, 72]);
/** Cased openings have no leaf, so they come in the single sizes and wider. */
const OPENING_WIDTHS = inches([24, 28, 30, 32, 36, 48, 60, 72, 96]);
/** Overhead garage doors: one-car widths, then two-car. */
export const GARAGE_DOOR_WIDTHS = [8, 9, 10, 16, 18, 20];
export const GARAGE_DOOR_HEIGHTS = [7, 8];

export function doorWidths(kind: DoorKind): readonly number[] {
  switch (kind) {
    case 'double':
      return DOUBLE_DOOR_WIDTHS;
    case 'opening':
      return OPENING_WIDTHS;
    case 'garage':
      return GARAGE_DOOR_WIDTHS;
    default:
      return SINGLE_DOOR_WIDTHS;
  }
}

/** How tall a door's opening is: a garage door's own height, else the standard 6'8". */
export function doorHeight(door: Pick<Door, 'kind' | 'height'>): number {
  return door.kind === 'garage' ? (door.height ?? GARAGE_DOOR_HEIGHTS[0]) : STORY.doorHeight;
}

/** `width` if it's offered for `kind`, else the nearest width that is. */
export function fitDoorWidth(kind: DoorKind, width: number): number {
  const list = doorWidths(kind);
  if (list.some((w) => Math.abs(w - width) < 1e-6)) return width;
  return list.reduce((best, w) => (Math.abs(w - width) < Math.abs(best - width) ? w : best));
}

export const DOOR_KINDS: { kind: DoorKind; label: string; icon: string }[] = [
  { kind: 'single', label: 'Swing door', icon: 'single' },
  { kind: 'double', label: 'Double doors', icon: 'double' },
  { kind: 'pocket', label: 'Pocket door', icon: 'pocket' },
  { kind: 'barn', label: 'Barn door', icon: 'barn' },
  { kind: 'opening', label: 'Cased opening (no door)', icon: 'opening' },
  { kind: 'garage', label: 'Garage door (overhead)', icon: 'garage' },
];

/** Where a door actually sits, resolved against its wall. */
export interface DoorPlacement {
  door: Door;
  /** Direction the host wall runs. */
  axis: Axis;
  /** Door center along the run, clamped into the wall. */
  at: number;
  /** The wall's extent across its run (y-range for an E/W wall). */
  c0: number;
  c1: number;
  /** Clear span of the host wall along its run. */
  lo: number;
  hi: number;
  exterior: boolean;
  /** Opening through the wall, in plan. */
  box: Box;
  /** False if the wall is gone or too short for the door. */
  valid: boolean;
}

/** The across-range of an exterior wall whose outer face looks toward `side` at `coord`. */
export function exteriorWallBand(side: Side, coord: number, t: number): [number, number] {
  return side === 'N' || side === 'W' ? [coord, coord + t] : [coord - t, coord];
}

export function placeDoor(door: Door, floor: Floor, region: FloorRegion, ti: number): DoorPlacement | null {
  let axis: Axis;
  let c0: number;
  let c1: number;
  let lo: number;
  let hi: number;
  let exterior = false;

  if ('wallId' in door.host) {
    const wallId = door.host.wallId;
    const g = wallGeoms(floor).find((w) => w.wall.id === wallId);
    if (!g) return null;
    axis = g.axis;
    [c0, c1] = [g.coord - ti / 2, g.coord + ti / 2];
    [lo, hi] = [g.lo + ti / 2, g.hi - ti / 2];
  } else {
    const { side, coord } = door.host;
    const seg = region.outer.find(
      (s) => s.side === side && Math.abs(s.coord - coord) < 1e-4 && door.at >= s.from - 1e-4 && door.at <= s.to + 1e-4,
    );
    if (!seg) return null;
    exterior = true;
    axis = side === 'N' || side === 'S' ? 'x' : 'y';
    [c0, c1] = exteriorWallBand(side, coord, region.t);
    [lo, hi] = [seg.from + region.t, seg.to - region.t];
  }

  const at = clampAlong(door.at, door.width, lo, hi);
  const [a0, a1] = [at - door.width / 2, at + door.width / 2];
  const box = axis === 'x' ? { x0: a0, x1: a1, y0: c0, y1: c1 } : { x0: c0, x1: c1, y0: a0, y1: a1 };
  return { door, axis, at, c0, c1, lo, hi, exterior, box, valid: hi - lo >= door.width - 1e-6 };
}

export function placeDoors(floor: Floor, region: FloorRegion, ti: number): DoorPlacement[] {
  return floor.doors.map((d) => placeDoor(d, floor, region, ti)).filter((p): p is DoorPlacement => !!p);
}

/** Next swing/hinge combination when a door is clicked: cycles through all four. */
export function nextSwing(d: Pick<Door, 'swing' | 'hinge'>): Pick<Door, 'swing' | 'hinge'> {
  if (d.swing === 1 && d.hinge === -1) return { swing: 1, hinge: 1 };
  if (d.swing === 1 && d.hinge === 1) return { swing: -1, hinge: 1 };
  if (d.swing === -1 && d.hinge === 1) return { swing: -1, hinge: -1 };
  return { swing: 1, hinge: -1 };
}

import { CATALOG_BY_ID, itemShape, rotatedBox } from '../core/floorplan/catalog';
import { DoorPlacement, exteriorWallBand } from '../core/floorplan/doors';
import { FloorRegion } from '../core/floorplan/floor-region';
import { Box, pointIn, pointInBox } from '../core/floorplan/region';
import { Axis, clampAlong, Pt, WallGeom, wallBoxes, wallGeoms } from '../core/floorplan/wall-graph';
import { STORY } from '../core/model/defaults';
import { DoorHost, Floor, FloorOpening, FurnitureItem, Side } from '../core/model/types';

/**
 * Snapping and hit testing for the floor plan editor, in plan (world) units.
 * `tol` is the pointer tolerance converted to feet at the current zoom.
 */

/** Plan grid steps: 3" normally, 1" with Alt held. */
export const GRID = 0.25;
export const FINE_GRID = 1 / 12;

export const snapTo = (v: number, step: number) => Math.round(v / step) * step;

/** Everything about the active floor the tools need, computed once per change. */
export interface PlanContext {
  floor: Floor;
  region: FloorRegion;
  ti: number;
  geoms: WallGeom[];
  /** Solid wall boxes by wall id (corners filled), room dividers included. */
  wallBoxes: Map<string, Box>;
  /** The ids of walls that are room dividers. */
  dividers: ReadonlySet<string>;
  doors: DoorPlacement[];
  juts: JutCorner[];
  /** Height to the floor above, which sizes stairs. */
  rise: number;
  /** Whether there is a floor above (its deck is the stairs' top landing). */
  floorAbove: boolean;
  /** Tape measurements left on the plan, as snap references. */
  marks: readonly Mark[];
}

/** A tape measurement kept on the plan: something to snap to, not part of the design. */
export interface Mark {
  a: Pt;
  b: Pt;
}

export function planContext(
  floor: Floor,
  region: FloorRegion,
  ti: number,
  doors: DoorPlacement[],
  rise: number = STORY.defaultHeight,
  marks: readonly Mark[] = [],
  floorAbove = false,
): PlanContext {
  const geoms = wallGeoms(floor);
  const dividers = new Set(floor.walls.filter((w) => w.divider).map((w) => w.id));
  return { floor, region, ti, geoms, wallBoxes: wallBoxes(floor, ti), dividers, doors, juts: jutCorners(region, ti), rise, floorAbove, marks };
}

/**
 * A corner of the exterior walls jutting into the room (where the outline turns
 * inward). A wall drawn from here should continue one of the jut's faces flush, so
 * its centerline starts half an interior wall back into the jut on both axes.
 */
export interface JutCorner {
  /** Where the two wall faces meet. */
  at: Pt;
  /** The centerline point for a flush wall: half an interior wall back into the jut. */
  snap: Pt;
  /** The jut's corner block (one exterior wall thick each way), highlighted on hover. */
  box: Box;
}

export function jutCorners(region: FloorRegion, ti: number): JutCorner[] {
  const seen = new Set<string>();
  const out: JutCorner[] = [];
  const e = 1e-3;
  for (const f of region.faces) {
    const h = isHorizontal(f.side);
    for (const a of [f.from, f.to]) {
      const at = h ? { x: a, y: f.coord } : { x: f.coord, y: a };
      const key = `${at.x},${at.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const empty = [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ].filter(([dx, dy]) => !pointIn(region.interior, at.x + dx * e, at.y + dy * e));
      if (empty.length !== 1) continue;
      const [dx, dy] = empty[0];
      const t = region.t;
      out.push({
        at,
        snap: { x: at.x + (dx * ti) / 2, y: at.y + (dy * ti) / 2 },
        box: {
          x0: Math.min(at.x, at.x + dx * t),
          x1: Math.max(at.x, at.x + dx * t),
          y0: Math.min(at.y, at.y + dy * t),
          y1: Math.max(at.y, at.y + dy * t),
        },
      });
    }
  }
  return out;
}

export type SnapKind = 'node' | 'corner' | 'mark' | 'wall' | 'face' | 'align' | 'grid';

export interface Snap {
  p: Pt;
  kind: SnapKind;
  /** Alignment guides to draw (a vertical line at x, a horizontal line at y). */
  guideX?: number;
  guideY?: number;
  /** A jut corner snapped to, to highlight. */
  highlight?: Box;
}

/** True if the snap lands on something it would connect to. */
export const connects = (s: Snap) => s.kind === 'node' || s.kind === 'corner' || s.kind === 'wall' || s.kind === 'face';

const isHorizontal = (side: Side) => side === 'N' || side === 'S';

const markEnds = (ctx: PlanContext): Pt[] => ctx.marks.flatMap((m) => [m.a, m.b]);

function closestOnSegment({ a, b }: Mark, p: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Snaps a free point: to a node, onto a wall or exterior wall face, or to the grid (with alignment). */
export function snapPoint(ctx: PlanContext, w: Pt, tol: number, step: number, skipNodes: ReadonlySet<string> = new Set()): Snap {
  let best: Snap | null = null;
  let bestDist = tol;
  for (const n of ctx.floor.nodes) {
    if (skipNodes.has(n.id)) continue;
    const d = Math.hypot(n.x - w.x, n.y - w.y);
    if (d <= bestDist) [best, bestDist] = [{ p: { x: n.x, y: n.y }, kind: 'node' }, d];
  }
  for (const p of markEnds(ctx)) {
    const d = Math.hypot(p.x - w.x, p.y - w.y);
    if (d <= bestDist) [best, bestDist] = [{ p: { ...p }, kind: 'mark' }, d];
  }
  if (best) return best;

  for (const j of ctx.juts) {
    if (pointInBox(grow(j.box, tol), w.x, w.y)) return { p: { ...j.snap }, kind: 'corner', highlight: j.box };
  }

  bestDist = tol;
  for (const g of ctx.geoms) {
    const along = g.axis === 'x' ? w.x : w.y;
    const across = g.axis === 'x' ? w.y : w.x;
    if (along < g.lo - tol || along > g.hi + tol) continue;
    const d = Math.abs(across - g.coord);
    if (d > bestDist) continue;
    const a = Math.min(g.hi, Math.max(g.lo, snapTo(along, step)));
    best = { p: g.axis === 'x' ? { x: a, y: g.coord } : { x: g.coord, y: a }, kind: 'wall' };
    bestDist = d;
  }
  for (const f of ctx.region.faces) {
    const h = isHorizontal(f.side);
    const along = h ? w.x : w.y;
    const across = h ? w.y : w.x;
    if (along < f.from - tol || along > f.to + tol) continue;
    const d = Math.abs(across - f.coord);
    if (d > bestDist) continue;
    const a = Math.min(f.to, Math.max(f.from, snapTo(along, step)));
    best = { p: h ? { x: a, y: f.coord } : { x: f.coord, y: a }, kind: 'face' };
    bestDist = d;
  }
  for (const m of ctx.marks) {
    const q = closestOnSegment(m, w);
    const d = Math.hypot(q.x - w.x, q.y - w.y);
    if (d > bestDist) continue;
    best = { p: q, kind: 'mark' };
    bestDist = d;
  }
  if (best) return best;

  const snap: Snap = { p: { x: snapTo(w.x, step), y: snapTo(w.y, step) }, kind: 'grid' };
  const ax = alignment(ctx, 'x', w.x, tol, skipNodes);
  const ay = alignment(ctx, 'y', w.y, tol, skipNodes);
  if (ax !== null) [snap.p.x, snap.guideX, snap.kind] = [ax, ax, 'align'];
  if (ay !== null) [snap.p.y, snap.guideY, snap.kind] = [ay, ay, 'align'];
  return snap;
}

/** A node or face coordinate near `v` on the given axis, to line things up with. */
function alignment(ctx: PlanContext, axis: Axis, v: number, tol: number, skip: ReadonlySet<string>): number | null {
  let best: number | null = null;
  let bestDist = tol;
  const consider = (c: number) => {
    const d = Math.abs(c - v);
    if (d <= bestDist) [best, bestDist] = [c, d];
  };
  for (const n of ctx.floor.nodes) if (!skip.has(n.id)) consider(axis === 'x' ? n.x : n.y);
  for (const p of markEnds(ctx)) consider(axis === 'x' ? p.x : p.y);
  for (const f of ctx.region.faces) if (isHorizontal(f.side) === (axis === 'y')) consider(f.coord);
  return best;
}

/**
 * Snaps the far end of a wall being drawn from `origin` along `axis`: to where it
 * would meet a crossing wall or exterior wall, to a node's line, or to the grid.
 */
export function snapAlong(ctx: PlanContext, origin: Pt, axis: Axis, raw: number, tol: number, step: number): Snap {
  const cross = axis === 'x' ? origin.y : origin.x;
  const at = (v: number): Pt => (axis === 'x' ? { x: v, y: origin.y } : { x: origin.x, y: v });
  let best: Snap | null = null;
  let bestDist = tol;
  const consider = (v: number, kind: SnapKind, guide?: number, highlight?: Box) => {
    const d = Math.abs(v - raw);
    if (d > bestDist) return;
    bestDist = d;
    best = { p: at(v), kind };
    if (guide !== undefined) best[axis === 'x' ? 'guideX' : 'guideY'] = guide;
    if (highlight) best.highlight = highlight;
  };
  // A jut corner whose flush line this wall is on: end tucked into the jut.
  for (const j of ctx.juts) {
    if (Math.abs((axis === 'x' ? j.snap.y : j.snap.x) - cross) < 1e-6) consider(axis === 'x' ? j.snap.x : j.snap.y, 'corner', undefined, j.box);
  }
  for (const g of ctx.geoms) {
    if (g.axis !== axis && cross >= g.lo - 1e-6 && cross <= g.hi + 1e-6) consider(g.coord, 'wall');
  }
  for (const f of ctx.region.faces) {
    if (isHorizontal(f.side) !== (axis === 'y')) continue;
    if (cross >= f.from - 1e-6 && cross <= f.to + 1e-6) consider(f.coord, 'face');
  }
  for (const n of ctx.floor.nodes) {
    const v = axis === 'x' ? n.x : n.y;
    const onLine = Math.abs((axis === 'x' ? n.y : n.x) - cross) < 1e-6;
    consider(v, onLine ? 'node' : 'align', onLine ? undefined : v);
  }
  for (const p of markEnds(ctx)) {
    const v = axis === 'x' ? p.x : p.y;
    const onLine = Math.abs((axis === 'x' ? p.y : p.x) - cross) < 1e-6;
    consider(v, onLine ? 'mark' : 'align', onLine ? undefined : v);
  }
  for (const m of ctx.marks) {
    // A square mark running across this line: where they meet.
    const [lo, hi] = axis === 'x' ? [Math.min(m.a.y, m.b.y), Math.max(m.a.y, m.b.y)] : [Math.min(m.a.x, m.b.x), Math.max(m.a.x, m.b.x)];
    const crossing = axis === 'x' ? Math.abs(m.a.x - m.b.x) < 1e-6 : Math.abs(m.a.y - m.b.y) < 1e-6;
    if (crossing && cross >= lo - 1e-6 && cross <= hi + 1e-6) consider(axis === 'x' ? m.a.x : m.a.y, 'mark');
  }
  return best ?? { p: at(snapTo(raw, step)), kind: 'grid' };
}

// ===================================================================== hit testing

export type Target =
  | { kind: 'node'; id: string }
  | { kind: 'door'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'item'; id: string }
  /** A stair on the floor below, picked up by its top landing or opening on this floor. */
  | { kind: 'stair'; id: string }
  | { kind: 'opening'; id: string; edge: Side | null };

/** What an item covers in plan (see `ItemShape.box`). */
export function itemBox(item: FurnitureItem, rise: number, floorAbove = false): Box | null {
  const cat = CATALOG_BY_ID.get(item.type);
  if (!cat) return null;
  const b = rotatedBox(itemShape(cat, rise, floorAbove).box, item.rotation);
  return { x0: item.x + b.x0, x1: item.x + b.x1, y0: item.y + b.y0, y1: item.y + b.y1 };
}

const grow = (b: Box, by: number): Box => ({ x0: b.x0 - by, x1: b.x1 + by, y0: b.y0 - by, y1: b.y1 + by });

/** A stair arriving from the floor below: its item id and the plan box it can be picked up by. */
export interface StairHandle {
  id: string;
  box: Box;
}

/** What's under the pointer, most specific first. */
export function hitTest(
  ctx: PlanContext,
  w: Pt,
  tol: number,
  openings: readonly FloorOpening[],
  stairs: readonly StairHandle[] = [],
): Target | null {
  for (const n of ctx.floor.nodes) {
    if (Math.hypot(n.x - w.x, n.y - w.y) <= tol) return { kind: 'node', id: n.id };
  }
  for (const d of ctx.doors) {
    if (pointInBox(grow(d.box, tol), w.x, w.y) || pointInBox(swingBox(d), w.x, w.y)) return { kind: 'door', id: d.door.id };
  }
  for (const [id, b] of ctx.wallBoxes) {
    if (pointInBox(grow(b, tol), w.x, w.y)) return { kind: 'wall', id };
  }
  const items = [...ctx.floor.items].reverse(); // topmost (last drawn) first
  for (const it of items) {
    const b = itemBox(it, ctx.rise, ctx.floorAbove);
    if (b && pointInBox(b, w.x, w.y)) return { kind: 'item', id: it.id };
  }
  for (const s of stairs) {
    if (pointInBox(s.box, w.x, w.y)) return { kind: 'stair', id: s.id };
  }
  for (const o of [...openings].reverse()) {
    if (!pointInBox(grow(o, tol), w.x, w.y)) continue;
    const edge: Side | null =
      Math.abs(w.y - o.y0) <= tol ? 'N' : Math.abs(w.y - o.y1) <= tol ? 'S' : Math.abs(w.x - o.x0) <= tol ? 'W' : Math.abs(w.x - o.x1) <= tol ? 'E' : null;
    return { kind: 'opening', id: o.id, edge };
  }
  return null;
}

/** The square a door leaf sweeps (or the slab of a barn door), for easier picking. */
export function swingBox(d: DoorPlacement): Box {
  const { door, axis, at, c0, c1 } = d;
  const face = door.swing > 0 ? c1 : c0;
  const reach = door.kind === 'double' ? door.width / 2 : door.kind === 'single' ? door.width : 0.3;
  const a = [at - door.width / 2, at + door.width / 2];
  const c = [face, face + door.swing * reach].sort((p, q) => p - q);
  return axis === 'x' ? { x0: a[0], x1: a[1], y0: c[0], y1: c[1] } : { x0: c[0], x1: c[1], y0: a[0], y1: a[1] };
}

// ===================================================================== doors

/** Where the door tool would put a door: the wall under the pointer and the spot on it. */
export interface DoorSpot {
  host: DoorHost;
  axis: Axis;
  at: number;
  c0: number;
  c1: number;
  /** Default swing: toward the pointer's side of an interior wall; always inward for exterior doors. */
  side: 1 | -1;
  valid: boolean;
}

export function doorSpot(ctx: PlanContext, w: Pt, tol: number, width: number, step: number): DoorSpot | null {
  type Cand = { host: DoorHost; axis: Axis; coord: number; c0: number; c1: number; lo: number; hi: number; dist: number };
  const cands: Cand[] = [];
  for (const g of ctx.geoms) {
    if (g.wall.divider) continue;
    const along = g.axis === 'x' ? w.x : w.y;
    const across = g.axis === 'x' ? w.y : w.x;
    if (along < g.lo || along > g.hi) continue;
    const dist = Math.abs(across - g.coord) - ctx.ti / 2;
    if (dist <= tol) {
      cands.push({ host: { wallId: g.wall.id }, axis: g.axis, coord: g.coord, c0: g.coord - ctx.ti / 2, c1: g.coord + ctx.ti / 2, lo: g.lo + ctx.ti / 2, hi: g.hi - ctx.ti / 2, dist });
    }
  }
  for (const s of ctx.region.outer) {
    const h = isHorizontal(s.side);
    const along = h ? w.x : w.y;
    const across = h ? w.y : w.x;
    if (along < s.from || along > s.to) continue;
    const [c0, c1] = exteriorWallBand(s.side, s.coord, ctx.region.t);
    const dist = across < c0 ? c0 - across : across > c1 ? across - c1 : 0;
    if (dist <= tol) {
      cands.push({ host: { side: s.side, coord: s.coord }, axis: h ? 'x' : 'y', coord: (c0 + c1) / 2, c0, c1, lo: s.from + ctx.region.t, hi: s.to - ctx.region.t, dist });
    }
  }
  const c = cands.sort((a, b) => a.dist - b.dist)[0];
  if (!c) return null;
  const along = c.axis === 'x' ? w.x : w.y;
  const across = c.axis === 'x' ? w.y : w.x;
  const at = clampAlong(snapTo(along, step), width, c.lo, c.hi);
  const fits = c.hi - c.lo >= width - 1e-6;
  const clash = ctx.doors.some(
    (d) => sameHost(d.door.host, c.host) && Math.abs(d.at - at) < (d.door.width + width) / 2 - 1e-6,
  );
  const side: 1 | -1 = 'side' in c.host ? (c.host.side === 'N' || c.host.side === 'W' ? 1 : -1) : across >= c.coord ? 1 : -1;
  return { host: c.host, axis: c.axis, at, c0: c.c0, c1: c.c1, side, valid: fits && !clash };
}

export function sameHost(a: DoorHost, b: DoorHost): boolean {
  if ('wallId' in a && 'wallId' in b) return a.wallId === b.wallId;
  if ('side' in a && 'side' in b) return a.side === b.side && Math.abs(a.coord - b.coord) < 1e-6;
  return false;
}

// ===================================================================== furniture

/** A straight edge furniture can snap to: the line `axis` = `c`, running from `lo` to `hi`. */
interface SnapFace {
  /** Which coordinate the face fixes: 'x' for a N/S-running face, 'y' for an E/W one. */
  axis: Axis;
  c: number;
  lo: number;
  hi: number;
  /** How far past its ends a piece can be and still snap to it. */
  reach: number;
}

/** How far along another piece of furniture an edge still lines up with it (ft). */
const FURNITURE_REACH = 2;

/**
 * Snaps a piece of furniture centered near `center`: each axis is pulled so one of
 * its edges sits on the nearest face within `tol` — the faces of walls (interior
 * and exterior) it's alongside, and the edges of other furniture (flush against
 * it, or lined up with a neighbor's edge) — and otherwise snaps to the grid.
 * `extent` is the piece's plan footprint: a centered size, or a box of offsets from
 * its center. `skip` leaves out the pieces being moved.
 */
export function snapItem(
  ctx: PlanContext,
  center: Pt,
  extent: { w: number; d: number } | Box,
  tol: number,
  step: number,
  skip: ReadonlySet<string> = new Set(),
): Pt {
  const faces: SnapFace[] = [];
  const addBox = (b: Box, reach: number) => {
    faces.push({ axis: 'x', c: b.x0, lo: b.y0, hi: b.y1, reach }, { axis: 'x', c: b.x1, lo: b.y0, hi: b.y1, reach });
    faces.push({ axis: 'y', c: b.y0, lo: b.x0, hi: b.x1, reach }, { axis: 'y', c: b.y1, lo: b.x0, hi: b.x1, reach });
  };
  for (const [id, b] of ctx.wallBoxes) if (!ctx.dividers.has(id)) addBox(b, 0);
  for (const f of ctx.region.faces) faces.push({ axis: isHorizontal(f.side) ? 'y' : 'x', c: f.coord, lo: f.from, hi: f.to, reach: 0 });
  for (const it of ctx.floor.items) {
    if (skip.has(it.id)) continue;
    const b = itemBox(it, ctx.rise, ctx.floorAbove);
    if (b) addBox(b, FURNITURE_REACH);
  }

  const off: Box = 'w' in extent ? { x0: -extent.w / 2, x1: extent.w / 2, y0: -extent.d / 2, y1: extent.d / 2 } : extent;
  const box = { x0: center.x + off.x0, x1: center.x + off.x1, y0: center.y + off.y0, y1: center.y + off.y1 };
  /** The shift along `axis` that puts an edge on the nearest face in reach, or null. */
  const pull = (axis: Axis): number | null => {
    const [lo, hi] = axis === 'x' ? [box.y0, box.y1] : [box.x0, box.x1];
    const edges = axis === 'x' ? [box.x0, box.x1] : [box.y0, box.y1];
    let best: number | null = null;
    let bestDist = tol;
    for (const f of faces) {
      if (f.axis !== axis || hi < f.lo - f.reach - tol || lo > f.hi + f.reach + tol) continue;
      for (const e of edges) {
        const d = Math.abs(f.c - e);
        if (d < bestDist) [best, bestDist] = [f.c - e, d];
      }
    }
    return best;
  };
  const sx = pull('x');
  const sy = pull('y');
  return {
    x: sx !== null ? center.x + sx : snapTo(center.x, step),
    y: sy !== null ? center.y + sy : snapTo(center.y, step),
  };
}

/** The plan rectangle an opening edge drag produces, kept at least 1′ across. */
export function resizeOpening(o: FloorOpening, edge: Side, v: number): FloorOpening {
  const min = 1;
  switch (edge) {
    case 'N':
      return { ...o, y0: Math.min(v, o.y1 - min) };
    case 'S':
      return { ...o, y1: Math.max(v, o.y0 + min) };
    case 'W':
      return { ...o, x0: Math.min(v, o.x1 - min) };
    case 'E':
      return { ...o, x1: Math.max(v, o.x0 + min) };
  }
}


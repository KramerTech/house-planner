import { newId } from '../model/defaults';
import { Door, Floor, InteriorWall, PlanNode, Side } from '../model/types';
import { FloorRegion } from './floor-region';
import { BoundarySeg, Box, covers, segsAt } from './region';

/**
 * Interior walls form a graph of nodes joined by straight N/S or E/W walls. The
 * graph is kept "planar": walls are split wherever a node sits on them or another
 * wall crosses them, so every junction is a node. That keeps rooms, dragging and
 * door placement simple.
 *
 * Dragging keeps everything square by moving whole lines at once: all nodes joined
 * by E/W walls share one y, so moving one of those walls north or south moves the
 * whole line (its "line group"), and the N/S walls hanging off it stretch.
 */

/** Direction a wall runs: 'x' = east/west, 'y' = north/south. */
export type Axis = 'x' | 'y';

export interface Pt {
  x: number;
  y: number;
}

export const MIN_WALL_LENGTH = 0.25;
const GEO_EPS = 1e-4;

/** Coordinates are kept to 1/10000 ft so equal positions compare equal. */
export const roundCoord = (v: number) => Math.round(v * 1e4) / 1e4;
const same = (a: number, b: number) => Math.abs(a - b) < GEO_EPS;

export interface WallGeom {
  wall: InteriorWall;
  a: PlanNode;
  b: PlanNode;
  axis: Axis;
  /** The center line's fixed coordinate (y for E/W walls, x for N/S walls). */
  coord: number;
  /** Extent along the run. */
  lo: number;
  hi: number;
}

export const nodeMap = (floor: Pick<Floor, 'nodes'>) => new Map(floor.nodes.map((n) => [n.id, n]));

export function geomOf(wall: InteriorWall, nodes: Map<string, PlanNode>): WallGeom | null {
  const a = nodes.get(wall.a);
  const b = nodes.get(wall.b);
  if (!a || !b) return null;
  const axis: Axis = same(a.y, b.y) ? 'x' : 'y';
  const [pa, pb] = axis === 'x' ? [a.x, b.x] : [a.y, b.y];
  return { wall, a, b, axis, coord: axis === 'x' ? a.y : a.x, lo: Math.min(pa, pb), hi: Math.max(pa, pb) };
}

export function wallGeoms(floor: Pick<Floor, 'nodes' | 'walls'>): WallGeom[] {
  const nodes = nodeMap(floor);
  return floor.walls.map((w) => geomOf(w, nodes)).filter((g): g is WallGeom => !!g);
}

const isCardinal = (a: Pt, b: Pt) => same(a.x, b.x) !== same(a.y, b.y);

/** Plan box of a wall's center line ± ti/2, along its run extended by `extLo`/`extHi`. */
export function wallBox(g: WallGeom, ti: number, extLo = 0, extHi = 0): Box {
  const lo = g.lo - extLo;
  const hi = g.hi + extHi;
  return g.axis === 'x'
    ? { x0: lo, x1: hi, y0: g.coord - ti / 2, y1: g.coord + ti / 2 }
    : { x0: g.coord - ti / 2, x1: g.coord + ti / 2, y0: lo, y1: hi };
}

export function nodeDegrees(floor: Pick<Floor, 'walls'>): Map<string, number> {
  const deg = new Map<string, number>();
  for (const w of floor.walls) {
    deg.set(w.a, (deg.get(w.a) ?? 0) + 1);
    deg.set(w.b, (deg.get(w.b) ?? 0) + 1);
  }
  return deg;
}

/** The node at the low / high end of a wall's run. */
export const lowNode = (g: WallGeom) => ((g.axis === 'x' ? g.a.x : g.a.y) <= (g.axis === 'x' ? g.b.x : g.b.y) ? g.a : g.b);
export const highNode = (g: WallGeom) => (lowNode(g) === g.a ? g.b : g.a);

/**
 * The solid a wall occupies: extended by half a thickness into corners and
 * junctions (nodes shared with other walls) so L corners close up.
 */
export function solidWallBox(g: WallGeom, ti: number, degrees: Map<string, number>): Box {
  const ext = (n: PlanNode) => ((degrees.get(n.id) ?? 0) >= 2 ? ti / 2 : 0);
  return wallBox(g, ti, ext(lowNode(g)), ext(highNode(g)));
}

/**
 * Every wall's solid box by id (see `solidWallBox`). Walls and room dividers close
 * corners only with their own kind, so a wall ending at a divider stops square.
 */
export function wallBoxes(floor: Pick<Floor, 'nodes' | 'walls'>, ti: number): Map<string, Box> {
  const solid = nodeDegrees({ walls: floor.walls.filter((w) => !w.divider) });
  const dividers = nodeDegrees({ walls: floor.walls.filter((w) => w.divider) });
  return new Map(wallGeoms(floor).map((g) => [g.wall.id, solidWallBox(g, ti, g.wall.divider ? dividers : solid)]));
}

/** The walls that are built (room dividers left out). */
export const solidWalls = (floor: Floor): Floor => ({ ...floor, walls: floor.walls.filter((w) => !w.divider) });

// ===================================================================== editing

/** Adds a wall (or room divider) from p to q (snapped, cardinal) and re-normalizes the graph. */
export function addWall(floor: Floor, p: Pt, q: Pt, ti: number, divider = false): Floor {
  const a: PlanNode = { id: newId(), x: roundCoord(p.x), y: roundCoord(p.y) };
  const b: PlanNode = { id: newId(), x: roundCoord(q.x), y: roundCoord(q.y) };
  if (!isCardinal(a, b)) return floor;
  const wall: InteriorWall = divider ? { id: newId(), a: a.id, b: b.id, divider } : { id: newId(), a: a.id, b: b.id };
  return normalize({ ...floor, nodes: [...floor.nodes, a, b], walls: [...floor.walls, wall] }, ti);
}

/** Turns walls into room dividers (dropping their doors) or back into walls. */
export function setDividers(floor: Floor, wallIds: ReadonlySet<string>, divider: boolean, ti: number): Floor {
  return normalize(
    {
      ...floor,
      walls: floor.walls.map((w) => {
        if (!wallIds.has(w.id)) return w;
        const { divider: _, ...rest } = w;
        return divider ? { ...rest, divider } : rest;
      }),
      doors: divider ? floor.doors.filter((d) => !('wallId' in d.host && wallIds.has(d.host.wallId))) : floor.doors,
    },
    ti,
  );
}

export function deleteWalls(floor: Floor, wallIds: ReadonlySet<string>, ti: number): Floor {
  return normalize(
    {
      ...floor,
      walls: floor.walls.filter((w) => !wallIds.has(w.id)),
      doors: floor.doors.filter((d) => !('wallId' in d.host && wallIds.has(d.host.wallId))),
    },
    ti,
  );
}

/** Deletes every wall meeting at a node. */
export function deleteNode(floor: Floor, nodeId: string, ti: number): Floor {
  return deleteWalls(floor, new Set(floor.walls.filter((w) => w.a === nodeId || w.b === nodeId).map((w) => w.id)), ti);
}

/**
 * Nodes connected to `start` through walls running along `along`: they all share
 * the line's fixed coordinate, so they move together.
 */
export function lineGroup(floor: Pick<Floor, 'nodes' | 'walls'>, start: string, along: Axis): Set<string> {
  const adj = new Map<string, string[]>();
  for (const g of wallGeoms(floor)) {
    if (g.axis !== along) continue;
    adj.set(g.a.id, [...(adj.get(g.a.id) ?? []), g.b.id]);
    adj.set(g.b.id, [...(adj.get(g.b.id) ?? []), g.a.id]);
  }
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of adj.get(queue.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export function shiftNodes(floor: Floor, ids: ReadonlySet<string>, dx: number, dy: number): Floor {
  if (dx === 0 && dy === 0) return floor;
  return {
    ...floor,
    nodes: floor.nodes.map((n) => (ids.has(n.id) ? { ...n, x: roundCoord(n.x + dx), y: roundCoord(n.y + dy) } : n)),
  };
}

/** Moves a wall's whole line across its run (y for E/W walls, x for N/S walls). */
export function moveWallLine(base: Floor, wallId: string, delta: number): Floor {
  const g = wallGeoms(base).find((w) => w.wall.id === wallId);
  if (!g) return base;
  const group = lineGroup(base, g.a.id, g.axis);
  return g.axis === 'x' ? shiftNodes(base, group, 0, delta) : shiftNodes(base, group, delta, 0);
}

/** Moves a node, taking the N/S line through it along in x and the E/W line in y. */
export function moveNode(base: Floor, nodeId: string, dx: number, dy: number): Floor {
  const moved = shiftNodes(base, lineGroup(base, nodeId, 'y'), dx, 0);
  return shiftNodes(moved, lineGroup(base, nodeId, 'x'), 0, dy);
}

/**
 * Whether a drag from `base` to `moved` leaves every affected wall valid: still
 * square, at least the minimum length, not flipped past the node at its other end,
 * inside the floor's interior, and still attached to the outline wherever it was.
 */
export function moveIsValid(base: Floor, moved: Floor, region: FloorRegion, ti: number): boolean {
  const before = nodeMap(base);
  const after = nodeMap(moved);
  const changed = new Set(moved.nodes.filter((n) => {
    const o = before.get(n.id);
    return !o || o.x !== n.x || o.y !== n.y;
  }).map((n) => n.id));
  if (changed.size === 0) return true;

  for (const w of moved.walls) {
    if (!changed.has(w.a) && !changed.has(w.b)) continue;
    const a0 = before.get(w.a)!;
    const b0 = before.get(w.b)!;
    const a1 = after.get(w.a)!;
    const b1 = after.get(w.b)!;
    if (!isCardinal(a1, b1)) return false;
    const len = Math.abs(b1.x - a1.x) + Math.abs(b1.y - a1.y);
    if (len < MIN_WALL_LENGTH - GEO_EPS) return false;
    if (Math.sign(b1.x - a1.x) !== Math.sign(b0.x - a0.x) || Math.sign(b1.y - a1.y) !== Math.sign(b0.y - a0.y)) return false;
    const g = geomOf(w, after)!;
    if (!fits(region, g, ti)) return false;
  }
  for (const id of changed) {
    const o = before.get(id)!;
    const n = after.get(id)!;
    if (segsAt(region.faces, o.x, o.y).length > 0 && segsAt(region.faces, n.x, n.y).length === 0) return false;
  }
  return true;
}

/**
 * A wall fits if it lies inside the floor's interior, except that each end may tuck
 * up to half its thickness into the wall it meets (so a wall can continue the face
 * of an exterior wall's corner flush; see the wall tool's corner snap).
 */
function fits(region: FloorRegion, g: WallGeom, ti: number): boolean {
  const tuck = Math.min(ti / 2, (g.hi - g.lo) / 2 - 1e-3);
  return covers(region.interior, wallBox(g, ti, -tuck, -tuck));
}

/** True if a new wall from p to q fits: square, long enough, inside the interior. */
export function wallFits(p: Pt, q: Pt, region: FloorRegion, ti: number): boolean {
  if (!isCardinal(p, q)) return false;
  if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < MIN_WALL_LENGTH - GEO_EPS) return false;
  const axis: Axis = same(p.y, q.y) ? 'x' : 'y';
  const g = {
    axis,
    coord: axis === 'x' ? p.y : p.x,
    lo: axis === 'x' ? Math.min(p.x, q.x) : Math.min(p.y, q.y),
    hi: axis === 'x' ? Math.max(p.x, q.x) : Math.max(p.y, q.y),
  } as WallGeom;
  return fits(region, g, ti);
}

/** Walls that don't fit the floor (e.g. after the exterior changed). */
export function misfitWalls(floor: Floor, region: FloorRegion, ti: number): Set<string> {
  return new Set(
    wallGeoms(floor)
      .filter((g) => !fits(region, g, ti))
      .map((g) => g.wall.id),
  );
}

// ===================================================================== normalization

/**
 * Restores the graph invariants after an edit: coincident nodes merged, walls split
 * at every node on them and every crossing, duplicates removed, straight runs
 * through plain 2-wall nodes joined back into one wall, orphans dropped, and doors
 * re-attached to whichever wall now holds them.
 */
export function normalize(floor: Floor, ti: number): Floor {
  const doorLines = interiorDoorLines(floor);

  // Merge coincident nodes.
  const byKey = new Map<string, PlanNode>();
  const canon = new Map<string, string>();
  const key = (x: number, y: number) => `${roundCoord(x)},${roundCoord(y)}`;
  for (const n of floor.nodes) {
    const k = key(n.x, n.y);
    const hit = byKey.get(k);
    if (hit) canon.set(n.id, hit.id);
    else {
      byKey.set(k, { id: n.id, x: roundCoord(n.x), y: roundCoord(n.y) });
      canon.set(n.id, n.id);
    }
  }
  const addNode = (x: number, y: number) => {
    const k = key(x, y);
    if (!byKey.has(k)) byKey.set(k, { id: newId(), x: roundCoord(x), y: roundCoord(y) });
  };
  let nodes = () => new Map([...byKey.values()].map((n) => [n.id, n]));
  let walls = floor.walls
    .map((w) => ({ ...w, a: canon.get(w.a) ?? w.a, b: canon.get(w.b) ?? w.b }))
    .filter((w) => {
      const m = nodes();
      const a = m.get(w.a);
      const b = m.get(w.b);
      return a && b && w.a !== w.b && isCardinal(a, b);
    });

  // Add a node wherever two walls cross.
  {
    const gs = walls.map((w) => geomOf(w, nodes())!);
    for (const h of gs.filter((g) => g.axis === 'x')) {
      for (const v of gs.filter((g) => g.axis === 'y')) {
        if (v.coord > h.lo + GEO_EPS && v.coord < h.hi - GEO_EPS && h.coord > v.lo + GEO_EPS && h.coord < v.hi - GEO_EPS) {
          addNode(v.coord, h.coord);
        }
      }
    }
  }

  // Split walls at every node lying inside them.
  {
    const m = nodes();
    const all = [...m.values()];
    const out: InteriorWall[] = [];
    for (const w of walls) {
      const g = geomOf(w, m)!;
      const along = (n: PlanNode) => (g.axis === 'x' ? n.x : n.y);
      const inner = all
        .filter((n) => same(g.axis === 'x' ? n.y : n.x, g.coord) && along(n) > g.lo + GEO_EPS && along(n) < g.hi - GEO_EPS)
        .sort((p, q) => along(p) - along(q));
      if (inner.length === 0) {
        out.push(w);
        continue;
      }
      const chain = [lowNode(g), ...inner, highNode(g)];
      for (let i = 0; i + 1 < chain.length; i++) {
        out.push({ ...w, id: i === 0 ? w.id : newId(), a: chain[i].id, b: chain[i + 1].id });
      }
    }
    walls = out;
  }

  // Remove duplicates; a wall drawn over a room divider makes it a wall.
  {
    const seen = new Map<string, InteriorWall>();
    for (const w of walls) {
      const k = [w.a, w.b].sort().join('|');
      const kept = seen.get(k);
      if (!kept || (kept.divider && !w.divider)) seen.set(k, w);
    }
    walls = [...seen.values()];
  }

  // Join straight runs through nodes that only connect two collinear walls.
  for (let changed = true; changed; ) {
    changed = false;
    const m = nodes();
    const incident = new Map<string, InteriorWall[]>();
    for (const w of walls) {
      incident.set(w.a, [...(incident.get(w.a) ?? []), w]);
      incident.set(w.b, [...(incident.get(w.b) ?? []), w]);
    }
    for (const [id, ws] of incident) {
      if (ws.length !== 2) continue;
      const [g1, g2] = ws.map((w) => geomOf(w, m)!);
      if (g1.axis !== g2.axis || !ws[0].divider !== !ws[1].divider) continue;
      const far1 = ws[0].a === id ? ws[0].b : ws[0].a;
      const far2 = ws[1].a === id ? ws[1].b : ws[1].a;
      walls = walls.filter((w) => w !== ws[1]).map((w) => (w === ws[0] ? { ...w, a: far1, b: far2 } : w));
      changed = true;
      break;
    }
  }

  // Drop orphan nodes.
  const used = new Set(walls.flatMap((w) => [w.a, w.b]));
  const finalNodes = [...byKey.values()].filter((n) => used.has(n.id));
  nodes = () => new Map(finalNodes.map((n) => [n.id, n]));

  const next: Floor = { ...floor, nodes: finalNodes, walls };
  return { ...next, doors: rehostDoors(next, doorLines, ti) };
}

interface DoorLine {
  axis: Axis;
  coord: number;
}

function interiorDoorLines(floor: Floor): Map<string, DoorLine> {
  const geoms = new Map(wallGeoms(floor).map((g) => [g.wall.id, g]));
  const out = new Map<string, DoorLine>();
  for (const d of floor.doors) {
    if (!('wallId' in d.host)) continue;
    const g = geoms.get(d.host.wallId);
    if (g) out.set(d.id, { axis: g.axis, coord: g.coord });
  }
  return out;
}

function rehostDoors(floor: Floor, lines: Map<string, DoorLine>, ti: number): Door[] {
  const geoms = wallGeoms(floor);
  const out: Door[] = [];
  for (const d of floor.doors) {
    if (!('wallId' in d.host)) {
      out.push(d);
      continue;
    }
    const line = lines.get(d.id);
    if (!line) continue;
    const g = geoms
      .filter((w) => !w.wall.divider && w.axis === line.axis && same(w.coord, line.coord) && d.at >= w.lo - GEO_EPS && d.at <= w.hi + GEO_EPS)
      .sort((p, q) => q.hi - q.lo - (p.hi - p.lo))[0];
    if (!g) continue;
    out.push({ ...d, host: { wallId: g.wall.id }, at: clampAlong(d.at, d.width, g.lo + ti / 2, g.hi - ti / 2) });
  }
  return out;
}

/**
 * Clamps a door center so the door stays within [lo, hi] (centered if it can't fit).
 * Free positions are rounded like other coordinates, but a door pushed against an
 * end sits exactly flush there: rounding its center would leave its edge a hair
 * inside the wall it meets, and the opening would cut a sliver out of that wall.
 */
export function clampAlong(at: number, width: number, lo: number, hi: number): number {
  if (hi - lo <= width) return roundCoord((lo + hi) / 2);
  const [min, max] = [lo + width / 2, hi - width / 2];
  const r = roundCoord(at);
  return r <= min ? min : r >= max ? max : r;
}

// ===================================================================== following the outline

/**
 * After the house outline changes, keeps interior walls attached to the exterior
 * walls they ended on: a node that sat on an inside face that has moved is carried
 * (with its line) to the nearest face of the same orientation that still spans it.
 * Exterior doors likewise follow their wall's outer face.
 */
export function followOutline(
  floor: Floor,
  before: Pick<FloorRegion, 'faces' | 'outer'>,
  after: Pick<FloorRegion, 'faces' | 'outer'>,
): Floor {
  let f = floor;
  const doneX = new Set<string>();
  const doneY = new Set<string>();
  for (const n of floor.nodes) {
    for (const s of segsAt(before.faces, n.x, n.y)) {
      if (segsAt(after.faces, n.x, n.y).some((o) => o.side === s.side)) continue;
      const target = nearestFace(after.faces, s, s.side === 'N' || s.side === 'S' ? n.x : n.y);
      if (!target) continue;
      const delta = target.coord - s.coord;
      if (s.side === 'N' || s.side === 'S') {
        if (doneY.has(n.id)) continue;
        const group = lineGroup(f, n.id, 'x');
        group.forEach((id) => doneY.add(id));
        f = shiftNodes(f, group, 0, delta);
      } else {
        if (doneX.has(n.id)) continue;
        const group = lineGroup(f, n.id, 'y');
        group.forEach((id) => doneX.add(id));
        f = shiftNodes(f, group, delta, 0);
      }
    }
  }

  const doors = f.doors.map((d) => {
    if ('wallId' in d.host) return d;
    const { side, coord } = d.host;
    const still = before.outer.find((s) => s.side === side && same(s.coord, coord) && d.at >= s.from && d.at <= s.to);
    if (!still || after.outer.some((s) => s.side === side && same(s.coord, coord) && d.at >= s.from && d.at <= s.to)) return d;
    const target = nearestFace(after.outer, still, d.at);
    return target ? { ...d, host: { side, coord: target.coord } } : d;
  });
  return { ...f, doors };
}

function nearestFace(faces: readonly BoundarySeg[], like: { side: Side; coord: number }, along: number): BoundarySeg | null {
  let best: BoundarySeg | null = null;
  for (const s of faces) {
    if (s.side !== like.side || along < s.from - GEO_EPS || along > s.to + GEO_EPS) continue;
    if (!best || Math.abs(s.coord - like.coord) < Math.abs(best.coord - like.coord)) best = s;
  }
  return best;
}

import { edgeAt, Face } from '../core/floorplan/faces';
import { Bounds, UZ } from '../core/floorplan/windows';

/**
 * Snapping for windows on a wall face, in face coordinates (u along the face, z up).
 * Every rule proposes an offset with a weight; the strongest rule in reach wins
 * (reach scales with weight), else positions fall back to whole inches. Each rule
 * brings the guides that explain it: alignment lines and dimensions to draw.
 */

export const SNAP_GRID = 1 / 12;

/**
 * Something on the face to line up with or space from: a window, a door, or an
 * interior wall meeting the face from inside (its thickness, from its floor up to
 * its ceiling) — whose faces bound the rooms behind the wall.
 */
export interface SceneItem {
  kind: 'window' | 'door' | 'partition';
  b: Bounds;
}

export interface SnapScene {
  face: Face;
  /** Windows (not the ones being edited), doors and interior walls on this face. */
  items: SceneItem[];
  /** The exterior walls' thickness: the inside corners are this far in from the face's ends. */
  wall: number;
  /** Floor levels crossing the face (the ground floor's is 0). */
  floors: number[];
  /** Ceilings under the floors above (their decks' undersides). */
  ceilings: number[];
  /** Other heights worth lining up with: sills, door heads, windows on other faces. */
  heights: { z: number; weight: number }[];
  /** Gaps between neighbors already in use: side by side, and stacked. */
  gaps: { u: number[]; z: number[] };
  /** How far below the roof other windows' tops sit. */
  clearances: number[];
  /** Other windows' sizes. */
  sizes: { w: number[]; h: number[] };
}

export type Guide =
  /** An alignment line: u = at (vertical) or z = at (horizontal). */
  | { t: 'line'; axis: 'u' | 'z'; at: number }
  /** A measured span along an axis, drawn at `at` across it and labeled with its length. */
  | { t: 'dim'; axis: 'u' | 'z'; from: number; to: number; at: number };

interface Candidate {
  off: number;
  weight: number;
  guides: Guide[];
}

/** Rule strengths: how far each reaches, relative to plain alignment. */
const W = {
  center: 1.6,
  gap: 1.45,
  clearance: 1.5,
  size: 1.35,
  window: 1.25,
  door: 1.15,
  partition: 1.15,
  symmetric: 1.1,
  face: 1,
  story: 1,
} as const;

const EPS = 1e-6;
const mid = (a: number, b: number) => (a + b) / 2;
const overlaps = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > EPS;
const snapGrid = (v: number) => Math.round(v / SNAP_GRID) * SNAP_GRID;

/** The best candidate in reach (`tol` scaled by its weight), or null. */
function best(cands: Candidate[], tol: number): Candidate | null {
  let pick: Candidate | null = null;
  let score = Infinity;
  for (const c of cands) {
    const d = Math.abs(c.off);
    if (d > tol * c.weight) continue;
    const s = d / c.weight;
    if (s < score - EPS || (Math.abs(s - score) <= EPS && pick && c.weight > pick.weight)) [pick, score] = [c, s];
  }
  return pick;
}

/** Builds a scene, working out the gaps already in use between neighbors on the face. */
export function buildScene(face: Face, items: SceneItem[], extras: Omit<SnapScene, 'face' | 'items' | 'gaps'>): SnapScene {
  const u: number[] = [];
  const z: number[] = [];
  // Gaps between openings only: how far windows sit from interior walls varies room to room.
  const openings = items.filter((i) => i.kind !== 'partition');
  for (const a of openings) {
    // The nearest neighbor to the right at the same height, and the nearest one above.
    const right = openings.filter((b) => b !== a && b.b.u0 >= a.b.u1 - EPS && overlaps(a.b.z0, a.b.z1, b.b.z0, b.b.z1)).sort((p, q) => p.b.u0 - q.b.u0)[0];
    if (right && right.b.u0 - a.b.u1 > EPS) u.push(right.b.u0 - a.b.u1);
    const above = openings.filter((b) => b !== a && b.b.z0 >= a.b.z1 - EPS && overlaps(a.b.u0, a.b.u1, b.b.u0, b.b.u1)).sort((p, q) => p.b.z0 - q.b.z0)[0];
    if (above && above.b.z0 - a.b.z1 > EPS) z.push(above.b.z0 - a.b.z1);
  }
  return { face, items, gaps: { u: dedupe(u), z: dedupe(z) }, ...extras };
}

function dedupe(v: number[]): number[] {
  return [...v].sort((a, b) => a - b).filter((x, i, arr) => i === 0 || x - arr[i - 1] > 1 / 48);
}

const bounds = (pts: readonly UZ[]): Bounds => ({
  u0: Math.min(...pts.map((p) => p[0])),
  u1: Math.max(...pts.map((p) => p[0])),
  z0: Math.min(...pts.map((p) => p[1])),
  z1: Math.max(...pts.map((p) => p[1])),
});

/** How far below the roof an outline's highest point gets (the smallest gap to the roof). */
export function roofClearance(face: Face, pts: readonly UZ[]): number {
  return Math.min(...pts.map(([u, z]) => edgeAt(face.top, u) - z));
}

/**
 * Where the neighbors are on either side of a span at its height: windows, doors
 * and interior walls, else the wall's ends — both its outside corners (`left`,
 * `right`, as seen from outside) and its inside corners (`leftIn`, `rightIn`, as
 * seen from the room).
 */
function sideNeighbors(scene: SnapScene, b: Bounds) {
  const beside = scene.items.filter((i) => overlaps(i.b.z0, i.b.z1, b.z0, b.z1));
  const c = mid(b.u0, b.u1);
  const itemLeft = Math.max(-Infinity, ...beside.filter((i) => mid(i.b.u0, i.b.u1) < c).map((i) => i.b.u1));
  const itemRight = Math.min(Infinity, ...beside.filter((i) => mid(i.b.u0, i.b.u1) > c).map((i) => i.b.u0));
  const { from, to } = scene.face;
  return {
    left: Math.max(from, itemLeft),
    right: Math.min(to, itemRight),
    leftIn: Math.max(from + scene.wall, itemLeft),
    rightIn: Math.min(to - scene.wall, itemRight),
    leftIsItem: itemLeft > from + EPS,
    rightIsItem: itemRight < to - EPS,
  };
}

/** Distinct [left, right] spans to center in: between neighbors, measured outside and inside. */
function centerSpans(n: ReturnType<typeof sideNeighbors>): [number, number][] {
  const spans: [number, number][] = [[n.left, n.right]];
  if (Math.abs(n.leftIn - n.left) > EPS || Math.abs(n.rightIn - n.right) > EPS) spans.push([n.leftIn, n.rightIn]);
  return spans;
}

/** What's below and above a span: the floor or a window/door under it, the next floor, a window over it, or the roof. */
function stackNeighbors(scene: SnapScene, b: Bounds) {
  const uc = mid(b.u0, b.u1);
  const zc = mid(b.z0, b.z1);
  const over = scene.items.filter((i) => overlaps(i.b.u0, i.b.u1, b.u0, b.u1));
  const belowItems = over.filter((i) => mid(i.b.z0, i.b.z1) < zc).map((i) => i.b.z1);
  const aboveItems = over.filter((i) => mid(i.b.z0, i.b.z1) > zc).map((i) => i.b.z0);
  const floorBelow = Math.max(edgeAt(scene.face.bottom, uc), ...scene.floors.filter((f) => f <= zc + EPS));
  // Centered within a story means between its floor and its ceiling (the roof, on top).
  const floorAbove = Math.min(edgeAt(scene.face.top, uc), ...[...scene.floors, ...scene.ceilings].filter((f) => f > zc + EPS));
  return {
    below: Math.max(floorBelow, ...belowItems),
    above: Math.min(floorAbove, ...aboveItems),
    belowItem: belowItems.length ? Math.max(...belowItems) : null,
    aboveItem: aboveItems.length ? Math.min(...aboveItems) : null,
  };
}

/** Lines along an axis to line edges and centers up with, by strength. */
function lines(scene: SnapScene, axis: 'u' | 'z'): { at: number; weight: number }[] {
  const out: { at: number; weight: number }[] = [];
  for (const i of scene.items) {
    // Interior walls only run up the face, so only their sides (and middle) line up.
    if (i.kind === 'partition' && axis === 'z') continue;
    const w = W[i.kind];
    const [a, b] = axis === 'u' ? [i.b.u0, i.b.u1] : [i.b.z0, i.b.z1];
    out.push({ at: a, weight: w }, { at: b, weight: w });
    if (i.kind !== 'door') out.push({ at: mid(a, b), weight: w * 0.9 });
  }
  if (axis === 'u') out.push({ at: mid(scene.face.from, scene.face.to), weight: W.face });
  else {
    out.push(...[...scene.floors, ...scene.ceilings].map((z) => ({ at: z, weight: W.story })), ...scene.heights.map((h) => ({ at: h.z, weight: h.weight })));
  }
  return out;
}

// ===================================================================== moving

/**
 * Snaps a moving window (or several: their outlines together), proposed at `pts`:
 * the offset to apply, and the guides to show.
 */
export function snapMove(scene: SnapScene, pts: readonly UZ[], tol: number): { du: number; dz: number; guides: Guide[] } {
  const b = bounds(pts);
  const uPick = best(moveCandidatesU(scene, b), tol);
  const du = uPick ? uPick.off : snapGrid(b.u0) - b.u0;
  const moved = pts.map(([u, z]): UZ => [u + du, z]);
  const bm = { ...b, u0: b.u0 + du, u1: b.u1 + du };
  const zPick = best(moveCandidatesZ(scene, bm, moved), tol);
  const dz = zPick ? zPick.off : snapGrid(b.z0) - b.z0;
  const final = { ...bm, z0: bm.z0 + dz, z1: bm.z1 + dz };
  return { du, dz, guides: [...(uPick?.guides ?? []), ...(zPick?.guides ?? []), ...alignedLines(scene, final)] };
}

/**
 * Snaps something sliding along the face at a fixed height (an exterior door), by
 * the same rules as moving a window sideways: the offset to apply, and the guides.
 */
export function snapSlide(scene: SnapScene, b: Bounds, tol: number): { du: number; guides: Guide[] } {
  const pick = best(moveCandidatesU(scene, b), tol);
  const du = pick ? pick.off : snapGrid(b.u0) - b.u0;
  const final = { ...b, u0: b.u0 + du, u1: b.u1 + du };
  const lined = alignedLines(scene, final).filter((g) => g.t === 'line' && g.axis === 'u');
  return { du, guides: [...(pick?.guides ?? []), ...lined] };
}

function moveCandidatesU(scene: SnapScene, b: Bounds): Candidate[] {
  const out: Candidate[] = [];
  const w = b.u1 - b.u0;
  const zc = mid(b.z0, b.z1);
  for (const l of lines(scene, 'u')) {
    for (const e of [b.u0, mid(b.u0, b.u1), b.u1]) out.push({ off: l.at - e, weight: l.weight, guides: [{ t: 'line', axis: 'u', at: l.at }] });
  }
  const n = sideNeighbors(scene, b);
  const { left, right, leftIsItem, rightIsItem } = n;
  // Centered between whatever is on either side (wall ends, doors, windows, interior walls).
  for (const [l, r] of centerSpans(n)) {
    const u0 = (l + r - w) / 2;
    if (u0 < l - EPS) continue;
    out.push({
      off: u0 - b.u0,
      weight: W.center,
      guides: [
        { t: 'dim', axis: 'u', from: l, to: u0, at: zc },
        { t: 'dim', axis: 'u', from: u0 + w, to: r, at: zc },
      ],
    });
  }
  // A gap already used between neighbors, from the neighbor on either side.
  for (const g of scene.gaps.u) {
    if (leftIsItem) out.push({ off: left + g - b.u0, weight: W.gap, guides: gapGuides(scene, 'u', left, left + g, zc, g) });
    if (rightIsItem) out.push({ off: right - g - b.u1, weight: W.gap, guides: gapGuides(scene, 'u', right - g, right, zc, g) });
  }
  // Mirroring another window across the middle of the wall.
  const { from, to } = scene.face;
  for (const i of scene.items.filter((x) => x.kind === 'window')) {
    const m0 = from + to - i.b.u1;
    out.push({
      off: m0 - b.u0,
      weight: W.symmetric,
      guides: [
        { t: 'line', axis: 'u', at: mid(from, to) },
        { t: 'dim', axis: 'u', from, to: Math.min(i.b.u0, m0), at: mid(i.b.z0, i.b.z1) },
        { t: 'dim', axis: 'u', from: Math.max(i.b.u1, m0 + w), to, at: mid(i.b.z0, i.b.z1) },
      ],
    });
  }
  return out;
}

function moveCandidatesZ(scene: SnapScene, b: Bounds, pts: readonly UZ[]): Candidate[] {
  const out: Candidate[] = [];
  const h = b.z1 - b.z0;
  const uc = mid(b.u0, b.u1);
  for (const l of lines(scene, 'z')) {
    for (const e of [b.z0, mid(b.z0, b.z1), b.z1]) out.push({ off: l.at - e, weight: l.weight, guides: [{ t: 'line', axis: 'z', at: l.at }] });
  }
  // The same gap under the roof as other windows.
  const c = roofClearance(scene.face, pts);
  const low = pts.reduce((p, q) => (edgeAt(scene.face.top, q[0]) - q[1] < edgeAt(scene.face.top, p[0]) - p[1] ? q : p));
  for (const t of scene.clearances) {
    out.push({ off: c - t, weight: W.clearance, guides: [{ t: 'dim', axis: 'z', from: low[1] + c - t, to: edgeAt(scene.face.top, low[0]), at: low[0] }] });
  }
  // Centered in its story (or between what's stacked below and above it).
  const { below, above, belowItem, aboveItem } = stackNeighbors(scene, b);
  const z0 = (below + above - h) / 2;
  if (z0 > below - EPS) {
    out.push({
      off: z0 - b.z0,
      weight: W.center * 0.8,
      guides: [
        { t: 'dim', axis: 'z', from: below, to: z0, at: uc },
        { t: 'dim', axis: 'z', from: z0 + h, to: above, at: uc },
      ],
    });
  }
  for (const g of scene.gaps.z) {
    if (belowItem !== null) out.push({ off: belowItem + g - b.z0, weight: W.gap, guides: gapGuides(scene, 'z', belowItem, belowItem + g, uc, g) });
    if (aboveItem !== null) out.push({ off: aboveItem - g - b.z1, weight: W.gap, guides: gapGuides(scene, 'z', aboveItem - g, aboveItem, uc, g) });
  }
  return out;
}

/** A gap matched to one already in use: the new gap, and where that gap already is. */
function gapGuides(scene: SnapScene, axis: 'u' | 'z', from: number, to: number, at: number, g: number): Guide[] {
  const guides: Guide[] = [{ t: 'dim', axis, from, to, at }];
  for (const a of scene.items) {
    const next = scene.items.find((b) =>
      axis === 'u'
        ? Math.abs(b.b.u0 - a.b.u1 - g) < 1e-4 && overlaps(a.b.z0, a.b.z1, b.b.z0, b.b.z1)
        : Math.abs(b.b.z0 - a.b.z1 - g) < 1e-4 && overlaps(a.b.u0, a.b.u1, b.b.u0, b.b.u1),
    );
    if (!next) continue;
    guides.push(
      axis === 'u'
        ? { t: 'dim', axis, from: a.b.u1, to: next.b.u0, at: mid(Math.max(a.b.z0, next.b.z0), Math.min(a.b.z1, next.b.z1)) }
        : { t: 'dim', axis, from: a.b.z1, to: next.b.z0, at: mid(Math.max(a.b.u0, next.b.u0), Math.min(a.b.u1, next.b.u1)) },
    );
  }
  return guides;
}

/** Alignment lines a box's edges and centers end up exactly on (shown even when another rule won). */
function alignedLines(scene: SnapScene, b: Bounds): Guide[] {
  const out: Guide[] = [];
  for (const axis of ['u', 'z'] as const) {
    const edges = axis === 'u' ? [b.u0, mid(b.u0, b.u1), b.u1] : [b.z0, mid(b.z0, b.z1), b.z1];
    for (const l of lines(scene, axis)) {
      if (edges.some((e) => Math.abs(e - l.at) < 1e-4)) out.push({ t: 'line', axis, at: l.at });
    }
  }
  return out;
}

// ===================================================================== resizing

export type Edge = 'u0' | 'u1' | 'z0' | 'z1';

/**
 * Snaps one edge of a window being resized (or drawn) to `v`, the other edges of
 * `b` staying put. `roof` is the roof height its top is measured against, for
 * matching other windows' clearance below the roof.
 */
export function snapEdge(scene: SnapScene, b: Bounds, edge: Edge, v: number, tol: number, roof?: number): { v: number; guides: Guide[] } {
  const axis = edge[0] as 'u' | 'z';
  const out: Candidate[] = [];
  const cross = axis === 'u' ? mid(b.z0, b.z1) : mid(b.u0, b.u1);
  const add = (target: number, weight: number, guides: Guide[]) => out.push({ off: target - v, weight, guides });

  for (const l of lines(scene, axis)) add(l.at, l.weight, [{ t: 'line', axis, at: l.at }]);
  if (axis === 'u') add(edge === 'u0' ? scene.face.from : scene.face.to, W.face * 0.8, []);

  // The same width or height as another window.
  const fixed = b[opposite(edge)];
  const sign = edge.endsWith('1') ? 1 : -1;
  for (const s of axis === 'u' ? scene.sizes.w : scene.sizes.h) {
    const target = fixed + sign * s;
    add(target, W.size, [{ t: 'dim', axis, from: Math.min(fixed, target), to: Math.max(fixed, target), at: cross }]);
  }

  if (axis === 'u') {
    const n = sideNeighbors(scene, b);
    const { left, right, leftIsItem, rightIsItem } = n;
    // Centered between its neighbors, the other edge staying put.
    for (const [l, r] of centerSpans(n)) {
      const target = edge === 'u0' ? l + r - b.u1 : l + r - b.u0;
      const [s0, s1] = edge === 'u0' ? [target, b.u1] : [b.u0, target];
      if (s1 - s0 <= EPS) continue;
      add(target, W.center, [
        { t: 'dim', axis, from: l, to: s0, at: cross },
        { t: 'dim', axis, from: s1, to: r, at: cross },
      ]);
    }
    for (const g of scene.gaps.u) {
      if (edge === 'u0' && leftIsItem) add(left + g, W.gap, gapGuides(scene, 'u', left, left + g, cross, g));
      if (edge === 'u1' && rightIsItem) add(right - g, W.gap, gapGuides(scene, 'u', right - g, right, cross, g));
    }
  } else {
    const { belowItem, aboveItem } = stackNeighbors(scene, b);
    for (const g of scene.gaps.z) {
      if (edge === 'z0' && belowItem !== null) add(belowItem + g, W.gap, gapGuides(scene, 'z', belowItem, belowItem + g, cross, g));
      if (edge === 'z1' && aboveItem !== null) add(aboveItem - g, W.gap, gapGuides(scene, 'z', aboveItem - g, aboveItem, cross, g));
    }
    if (edge === 'z1' && roof !== undefined) {
      for (const c of scene.clearances) add(roof - c, W.clearance, [{ t: 'dim', axis: 'z', from: roof - c, to: roof, at: cross }]);
    }
  }

  const pick = best(out, tol);
  const value = pick ? v + pick.off : snapGrid(v);
  const final = { ...b, [edge]: value };
  return { v: value, guides: [...(pick?.guides ?? []), ...alignedLines(scene, final)] };
}

const opposite = (e: Edge): Edge => (e === 'u0' ? 'u1' : e === 'u1' ? 'u0' : e === 'z0' ? 'z1' : 'z0');

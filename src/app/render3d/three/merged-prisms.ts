import { Vector3 } from 'three';
import { PrismPiece } from '../build/building-model';
import { GeometryAccumulator } from './geometry-accumulator';
import { toWorld } from './piece-geometry';

/**
 * Turns a set of box pieces (walls, or floor slabs) into one watertight-looking
 * solid by working per *plane* rather than per piece.
 *
 * Every piece is an axis-aligned box with a possibly sloped top, so each of its four
 * sides lies on a vertical plane x = c or y = c. All side faces on the same plane
 * are gathered, then:
 *  - same-facing faces are unioned, so faces that overlap or abut (two sections'
 *    walls continuing along one line, or a gable infill meeting the end of a
 *    perpendicular wall) become one region;
 *  - opposite-facing faces cancel where they overlap — they're two solids touching
 *    back to back, so neither surface is really exposed (a wall's end cap against
 *    the next wall's end cap, or against the inside face of a perpendicular wall).
 *    Whatever is left over is real, e.g. the part of a taller wall's end that rises
 *    above a shorter neighbor.
 *  - any part lying strictly inside another piece (two pieces overlapping, like two
 *    raised walls that both claim a corner square) is buried and removed; left in,
 *    its edge shows up as a stray line on the other piece's face.
 *  - the result is triangulated so every pair of neighboring triangles shares its
 *    edge exactly (no T-junctions). EdgesGeometry only suppresses an outline edge
 *    when two coplanar triangles share it; a T-junction — one face's edge running
 *    0→9 against its neighbor's 0→14 — reads as two separate boundary edges and
 *    draws a line down the middle of a flat face.
 *
 * Tops and bottoms get the same treatment on their own (possibly sloped) planes:
 * every top on one plane — all wall tops under one roof plane, or every section's
 * slab top at grade — is unioned onto a shared grid and faced as one surface.
 */
const EPS = 1e-6;

type Axis = 'x' | 'y';

/** A vertical extent along a plane: u0..u1, with bottom and top heights at each end (linear in between). */
interface Span {
  u0: number;
  u1: number;
  b0: number;
  b1: number;
  t0: number;
  t1: number;
}

/** A side face on plane `axis = coord`, facing `dir` along `axis`. */
interface SideFace extends Span {
  axis: Axis;
  coord: number;
  dir: 1 | -1;
}

/** A vertical band within one slab of a plane: bottom and top lines, each as [height at ua, height at ub]. */
interface Band {
  lo: [number, number];
  hi: [number, number];
}

interface PlaneResult {
  dir: 1 | -1;
  ua: number;
  ub: number;
  band: Band;
}

const mid = (l: [number, number]) => (l[0] + l[1]) / 2;

interface Plane {
  c: number;
  gx: number;
  gy: number;
}

const heightOn = (p: Plane, x: number, y: number) => p.c + p.gx * x + p.gy * y;

/** A piece as a solid: its plan rect, with bottom and top planes. */
interface Solid {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  bottom: Plane;
  top: Plane;
}

function solidOf(piece: PrismPiece): Solid {
  const f = piece.footprint;
  const xs = f.map((p) => p.x);
  const ys = f.map((p) => p.y);
  const fit = (h: readonly number[]): Plane => {
    const d1x = f[1].x - f[0].x;
    const d1y = f[1].y - f[0].y;
    const d2x = f[2].x - f[0].x;
    const d2y = f[2].y - f[0].y;
    const det = d1x * d2y - d1y * d2x;
    const gx = ((h[1] - h[0]) * d2y - d1y * (h[2] - h[0])) / det;
    const gy = (d1x * (h[2] - h[0]) - (h[1] - h[0]) * d2x) / det;
    return { c: h[0] - gx * f[0].x - gy * f[0].y, gx, gy };
  };
  return {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
    bottom: fit(piece.bottom),
    top: fit(piece.top),
  };
}

export function addMergedPrisms(acc: GeometryAccumulator, pieces: readonly PrismPiece[]): void {
  const solids = pieces.map(solidOf);
  const planes = new Map<string, SideFace[]>();
  const flats = new Map<string, FlatFace[]>();
  const push = <T>(map: Map<string, T[]>, key: string, item: T) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(item);
  };
  pieces.forEach((piece, i) => {
    for (const face of sideFaces(piece)) push(planes, `${face.axis}|${face.coord.toFixed(4)}`, face);
    for (const face of flatFaces(solids[i])) push(flats, flatKey(face), face);
  });
  for (const faces of planes.values()) emitPlane(acc, faces, solids);
  for (const faces of flats.values()) emitFlat(acc, faces, solids);
}

function sideFaces(piece: PrismPiece): SideFace[] {
  const f = piece.footprint;
  const cx = (f[0].x + f[1].x + f[2].x + f[3].x) / 4;
  const cy = (f[0].y + f[1].y + f[2].y + f[3].y) / 4;
  const faces: SideFace[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const axis: Axis = Math.abs(f[i].x - f[j].x) < EPS ? 'x' : 'y';
    const coord = axis === 'x' ? f[i].x : f[i].y;
    const dir = coord > (axis === 'x' ? cx : cy) ? 1 : -1;
    const ui = axis === 'x' ? f[i].y : f[i].x;
    const uj = axis === 'x' ? f[j].y : f[j].x;
    if (Math.abs(ui - uj) < EPS) continue;
    const [a, b] = ui < uj ? [i, j] : [j, i];
    faces.push({
      axis,
      coord,
      dir,
      u0: Math.min(ui, uj),
      u1: Math.max(ui, uj),
      b0: piece.bottom[a],
      b1: piece.bottom[b],
      t0: piece.top[a],
      t1: piece.top[b],
    });
  }
  return faces;
}

/** A wall's top (dir 1) or bottom (dir -1): an axis-aligned plan rect on the plane h = c + gx·x + gy·y. */
interface FlatFace {
  dir: 1 | -1;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  c: number;
  gx: number;
  gy: number;
}

function flatFaces(s: Solid): FlatFace[] {
  const rect = { x0: s.x0, x1: s.x1, y0: s.y0, y1: s.y1 };
  return [
    { dir: 1, ...rect, ...s.top },
    { dir: -1, ...rect, ...s.bottom },
  ];
}

const round = (v: number, digits: number) => (Math.round(v * 10 ** digits) / 10 ** digits + 0).toString();
const flatKey = (f: FlatFace) => `${f.dir}|${round(f.gx, 5)}|${round(f.gy, 5)}|${round(f.c, 4)}`;

function uniqueSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((v, i) => i === 0 || v - sorted[i - 1] > EPS);
}

/**
 * Faces the union of coplanar tops (or bottoms) on a grid of every rect edge, one
 * quad per covered cell, so cells always share whole edges with their neighbors.
 */
function emitFlat(acc: GeometryAccumulator, faces: FlatFace[], solids: Solid[]): void {
  const { dir, c, gx, gy } = faces[0];
  // Grid lines at every face edge, plus every edge of another piece crossing these
  // faces, so a buried part (see below) is always a whole cell of its own.
  const within = (v: number, lo: number, hi: number) => v > lo + EPS && v < hi - EPS;
  const fx0 = Math.min(...faces.map((f) => f.x0));
  const fx1 = Math.max(...faces.map((f) => f.x1));
  const fy0 = Math.min(...faces.map((f) => f.y0));
  const fy1 = Math.max(...faces.map((f) => f.y1));
  const xs = uniqueSorted([
    ...faces.flatMap((f) => [f.x0, f.x1]),
    ...solids.flatMap((s) => [s.x0, s.x1]).filter((x) => within(x, fx0, fx1)),
  ]);
  const ys = uniqueSorted([
    ...faces.flatMap((f) => [f.y0, f.y1]),
    ...solids.flatMap((s) => [s.y0, s.y1]).filter((y) => within(y, fy0, fy1)),
  ]);
  const at = (x: number, y: number) => toWorld({ x, y }, c + gx * x + gy * y);
  const outward = new Vector3(0, dir, 0);
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (!faces.some((f) => cx > f.x0 && cx < f.x1 && cy > f.y0 && cy < f.y1)) continue;
      // Skip parts buried inside another piece (where two pieces overlap).
      const h = c + gx * cx + gy * cy;
      const buried = solids.some(
        (s) =>
          cx > s.x0 &&
          cx < s.x1 &&
          cy > s.y0 &&
          cy < s.y1 &&
          h > heightOn(s.bottom, cx, cy) + EPS &&
          h < heightOn(s.top, cx, cy) - EPS,
      );
      if (buried) continue;
      acc.quad(at(xs[i], ys[j]), at(xs[i + 1], ys[j]), at(xs[i + 1], ys[j + 1]), at(xs[i], ys[j + 1]), outward);
    }
  }
}

const lineAt = (u: number, u0: number, u1: number, v0: number, v1: number) =>
  v0 + ((v1 - v0) * (u - u0)) / (u1 - u0);

/**
 * Every u where the plane's region could change shape: face ends, plus anywhere
 * two faces' top/bottom lines cross (so within each slab no two lines cross and
 * ordering bands by their midpoint height is exact).
 */
function breakpoints(faces: Span[]): number[] {
  const us: number[] = [];
  const lines = faces.flatMap((f) => [
    { u0: f.u0, u1: f.u1, v0: f.b0, v1: f.b1 },
    { u0: f.u0, u1: f.u1, v0: f.t0, v1: f.t1 },
  ]);
  for (const f of faces) us.push(f.u0, f.u1);
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      const lo = Math.max(a.u0, b.u0);
      const hi = Math.min(a.u1, b.u1);
      if (hi - lo < EPS) continue;
      const dLo = lineAt(lo, a.u0, a.u1, a.v0, a.v1) - lineAt(lo, b.u0, b.u1, b.v0, b.v1);
      const dHi = lineAt(hi, a.u0, a.u1, a.v0, a.v1) - lineAt(hi, b.u0, b.u1, b.v0, b.v1);
      if ((dLo > EPS && dHi < -EPS) || (dLo < -EPS && dHi > EPS)) {
        us.push(lo + ((hi - lo) * dLo) / (dLo - dHi));
      }
    }
  }
  us.sort((a, b) => a - b);
  return us.filter((u, i) => i === 0 || u - us[i - 1] > EPS);
}

function union(bands: Band[]): Band[] {
  const sorted = [...bands].sort((a, b) => mid(a.lo) - mid(b.lo));
  const out: Band[] = [];
  for (const band of sorted) {
    const cur = out.at(-1);
    if (cur && mid(band.lo) <= mid(cur.hi) + EPS) {
      if (mid(band.hi) > mid(cur.hi)) cur.hi = band.hi;
    } else {
      out.push({ lo: band.lo, hi: band.hi });
    }
  }
  return out;
}

function subtract(from: Band[], remove: Band[]): Band[] {
  let pieces = from;
  for (const r of remove) {
    const next: Band[] = [];
    for (const p of pieces) {
      if (mid(r.hi) <= mid(p.lo) + EPS || mid(r.lo) >= mid(p.hi) - EPS) {
        next.push(p);
        continue;
      }
      if (mid(r.lo) > mid(p.lo) + EPS) next.push({ lo: p.lo, hi: r.lo });
      if (mid(r.hi) < mid(p.hi) - EPS) next.push({ lo: r.hi, hi: p.hi });
    }
    pieces = next;
  }
  return pieces.filter((b) => b.hi[0] - b.lo[0] > EPS || b.hi[1] - b.lo[1] > EPS);
}

/**
 * Where another piece passes through this plane (overlapping pieces, e.g. two
 * raised walls sharing a corner square), the part of the plane inside it, as
 * spans along the plane. Faces there are buried in that piece and get removed.
 */
function cutters(axis: Axis, coord: number, solids: Solid[]): Span[] {
  const out: Span[] = [];
  for (const s of solids) {
    const [a0, a1, u0, u1] = axis === 'x' ? [s.x0, s.x1, s.y0, s.y1] : [s.y0, s.y1, s.x0, s.x1];
    if (!(coord > a0 + EPS && coord < a1 - EPS)) continue;
    const h = (p: Plane, u: number) => (axis === 'x' ? heightOn(p, coord, u) : heightOn(p, u, coord));
    out.push({ u0, u1, b0: h(s.bottom, u0), b1: h(s.bottom, u1), t0: h(s.top, u0), t1: h(s.top, u1) });
  }
  return out;
}

const bandIn = (f: Span, ua: number, ub: number): Band | null =>
  f.u0 > ua + EPS || f.u1 < ub - EPS
    ? null
    : {
        lo: [lineAt(ua, f.u0, f.u1, f.b0, f.b1), lineAt(ub, f.u0, f.u1, f.b0, f.b1)],
        hi: [lineAt(ua, f.u0, f.u1, f.t0, f.t1), lineAt(ub, f.u0, f.u1, f.t0, f.t1)],
      };

function emitPlane(acc: GeometryAccumulator, faces: SideFace[], solids: Solid[]): void {
  const { axis, coord } = faces[0];
  const cuts = cutters(axis, coord, solids);
  const us = breakpoints([...faces, ...cuts]);
  const results: PlaneResult[] = [];

  for (let s = 0; s + 1 < us.length; s++) {
    const ua = us[s];
    const ub = us[s + 1];
    const pos: Band[] = [];
    const neg: Band[] = [];
    for (const f of faces) {
      const band = bandIn(f, ua, ub);
      if (band) (f.dir === 1 ? pos : neg).push(band);
    }
    const buried = union(cuts.map((c) => bandIn(c, ua, ub)).filter((b): b is Band => !!b));
    const posU = union(pos);
    const negU = union(neg);
    for (const band of subtract(subtract(posU, negU), buried)) results.push({ dir: 1, ua, ub, band });
    for (const band of subtract(subtract(negU, posU), buried)) results.push({ dir: -1, ua, ub, band });
  }

  // Every height any band starts or ends at, per breakpoint, so neighboring slabs
  // split their shared vertical edges at the same points.
  const heightsAt = new Map<number, number[]>();
  const addHeight = (u: number, h: number) => {
    let list = heightsAt.get(u);
    if (!list) heightsAt.set(u, (list = []));
    list.push(h);
  };
  for (const r of results) {
    addHeight(r.ua, r.band.lo[0]);
    addHeight(r.ua, r.band.hi[0]);
    addHeight(r.ub, r.band.lo[1]);
    addHeight(r.ub, r.band.hi[1]);
  }
  for (const list of heightsAt.values()) {
    list.sort((a, b) => a - b);
    const unique = list.filter((h, i) => i === 0 || h - list[i - 1] > EPS);
    list.length = 0;
    list.push(...unique);
  }

  const point = (u: number, h: number) => toWorld(axis === 'x' ? { x: coord, y: u } : { x: u, y: coord }, h);
  for (const r of results) {
    const outward = axis === 'x' ? new Vector3(r.dir, 0, 0) : new Vector3(0, 0, r.dir);
    const side = (u: number, lo: number, hi: number) =>
      heightsAt.get(u)!.filter((h) => h >= lo - EPS && h <= hi + EPS);
    const left = side(r.ua, r.band.lo[0], r.band.hi[0]).map((h) => point(r.ua, h));
    const right = side(r.ub, r.band.lo[1], r.band.hi[1]).map((h) => point(r.ub, h));
    stripTriangulate(acc, left, right, outward);
  }
}

/**
 * Triangulates a band between two vertical sides (each a bottom-to-top list of
 * points), using every point on both sides so shared edges line up with the
 * neighboring band's.
 */
function stripTriangulate(acc: GeometryAccumulator, left: Vector3[], right: Vector3[], outward: Vector3): void {
  let i = 0;
  let j = 0;
  while (i < left.length - 1 || j < right.length - 1) {
    const advanceLeft = j >= right.length - 1 || (i < left.length - 1 && left[i + 1].y <= right[j + 1].y);
    if (advanceLeft) {
      acc.triangle(left[i], right[j], left[i + 1], outward);
      i++;
    } else {
      acc.triangle(left[i], right[j], right[j + 1], outward);
      j++;
    }
  }
}

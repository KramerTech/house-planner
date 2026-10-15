import { sideSegments } from '../geometry/edges';
import { roofHeightAt, roofSlope } from '../geometry/roof';
import { x0, x1, y0, y1 } from '../geometry/rect';
import { HouseWindow, ProjectSettings, Section, Side, SIDES } from '../model/types';
import { floorRegion } from './floor-region';

/**
 * An exterior wall face windows go in: one flat, straight stretch of wall, seen from
 * outside. Its outline is in face coordinates — u along the face (plan x for N/S
 * faces, y for E/W) and z, height above the ground floor:
 *  - house faces: the outside faces of the exterior walls, from the ground up to
 *    the roof over each stretch;
 *  - clerestory faces: where a taller section's wall shows above a lower section's
 *    roof, from that roof up to the taller one.
 * Faces are identified by side and line (like exterior doors), so two faces looking
 * the same way at different depths are different faces.
 */
export interface Face {
  key: string;
  side: Side;
  /** The outer face's line: y for N/S faces, x for E/W faces. */
  coord: number;
  /** Extent along the face. */
  from: number;
  to: number;
  /** Bottom and top edges as [u, z] points, each running from `from` to `to`. */
  bottom: [number, number][];
  top: [number, number][];
  clerestory: boolean;
  /** Roofs below the face that meet it: the lower roof under a clerestory, or a patio's against a house wall. */
  lower: LowerRoof[];
}

/** A roof meeting a face from below, where it meets it. */
export interface LowerRoof {
  /** Its top surface along the face, as [u, z] points. */
  line: [number, number][];
  /** Its slab's vertical thickness (so its underside is this far below `line`). */
  thickness: number;
}

const EPS = 1e-6;
const horizontal = (side: Side) => side === 'N' || side === 'S';
/** A plan point on a face's line at `u`. */
export const facePoint = (side: Side, coord: number, u: number) => (horizontal(side) ? { x: u, y: coord } : { x: coord, y: u });

/** The face's outline: along the bottom, then back along the top. */
export const faceOutline = (f: Face): [number, number][] => [...f.bottom, ...[...f.top].reverse()];

/** Every face, in a walk round the house: north, east, south, west, each along its run. */
export function exteriorFaces(sections: readonly Section[], settings: ProjectSettings): Face[] {
  const order = { N: 0, E: 1, S: 2, W: 3 };
  return [...houseFaces(sections, settings), ...clerestoryFaces(sections, settings)].sort(
    (a, b) => order[a.side] - order[b.side] || Number(a.clerestory) - Number(b.clerestory) || a.coord - b.coord || a.from - b.from,
  );
}

/** The face with this key, else the first south wall (or any). */
export function pickFace(faces: readonly Face[], key: string | null): Face | null {
  return faces.find((f) => f.key === key) ?? faces.find((f) => f.side === 'S' && !f.clerestory) ?? faces[0] ?? null;
}

function houseFaces(sections: readonly Section[], settings: ProjectSettings): Face[] {
  const enclosed = sections.filter((s) => !s.patio.enabled);
  const t = settings.wallThickness;
  return floorRegion(sections, settings, 0).outer.map((seg) => {
    const h = horizontal(seg.side);
    const inward = seg.side === 'N' || seg.side === 'W' ? 1 : -1;
    // Split where the section behind the wall changes, so each stretch takes its roof.
    const cuts = uniq([seg.from, seg.to, ...enclosed.flatMap((s) => (h ? [x0(s.rect), x1(s.rect)] : [y0(s.rect), y1(s.rect)]))].filter((v) => v >= seg.from - EPS && v <= seg.to + EPS));
    const top: [number, number][] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      // Find the section behind the wall from the middle of the stretch (corners lie past every section's edge).
      const mid = Math.min(Math.max((a + b) / 2, seg.from + t), seg.to - t);
      const probe = facePoint(seg.side, seg.coord + inward * t, mid);
      const s = enclosed.find((e) => probe.x > x0(e.rect) && probe.x < x1(e.rect) && probe.y > y0(e.rect) && probe.y < y1(e.rect));
      if (!s) continue;
      const at = (u: number) => {
        const p = facePoint(seg.side, seg.coord, u);
        return roofHeightAt(s, p.x, p.y);
      };
      top.push([a, at(a)], [b, at(b)]);
    }
    const f = face(seg.side, seg.coord, seg.from, seg.to, [[seg.from, 0], [seg.to, 0]], dedupe(top), false);
    return { ...f, lower: patioRoofs(f, sections, settings) };
  });
}

/** Patio roofs meeting a house face: each patio built against the wall, along its overlap. */
function patioRoofs(f: Face, sections: readonly Section[], settings: ProjectSettings): LowerRoof[] {
  const h = horizontal(f.side);
  const center = f.coord + ((f.side === 'N' || f.side === 'W' ? 1 : -1) * settings.wallThickness) / 2;
  const out: LowerRoof[] = [];
  for (const p of sections.filter((s) => s.patio.enabled)) {
    // The patio lies outside the face, with its near edge on the wall's centerline.
    const near = f.side === 'S' ? y0(p.rect) : f.side === 'N' ? y1(p.rect) : f.side === 'E' ? x0(p.rect) : x1(p.rect);
    if (Math.abs(near - center) > 1e-6) continue;
    const [a, b] = [Math.max(f.from, h ? x0(p.rect) : y0(p.rect)), Math.min(f.to, h ? x1(p.rect) : y1(p.rect))];
    if (b - a < 1e-6) continue;
    const thick = settings.roofThickness * Math.sqrt(1 + roofSlope(p) ** 2);
    const line = [a, b].map((u): [number, number] => {
      const q = facePoint(f.side, f.coord, u);
      return [u, roofHeightAt(p, q.x, q.y) + thick];
    });
    out.push({ line, thickness: thick });
  }
  return out;
}

/** Where two enclosed sections meet with roofs at different heights, the taller wall shows above the lower roof. */
function clerestoryFaces(sections: readonly Section[], settings: ProjectSettings): Face[] {
  const t = settings.wallThickness;
  const byId = new Map(sections.map((s) => [s.id, s]));
  const out: Face[] = [];
  for (const s of sections) {
    if (s.patio.enabled) continue;
    for (const side of SIDES) {
      for (const seg of sideSegments(s, side, sections)) {
        const n = seg.neighborId ? byId.get(seg.neighborId) : undefined;
        if (!n || n.patio.enabled) continue;
        const mid = facePoint(side, seg.coord, (seg.from + seg.to) / 2);
        // Built once, from the taller section's side, facing the lower one.
        if (roofHeightAt(s, mid.x, mid.y) - roofHeightAt(n, mid.x, mid.y) <= 0.01) continue;
        const sign = side === 'N' || side === 'W' ? -1 : 1;
        const coord = seg.coord + (sign * t) / 2;
        // The lower roof's top surface, and the taller roof's underside.
        const lowTop = settings.roofThickness * Math.sqrt(1 + roofSlope(n) ** 2);
        const prof = (sec: Section, above: number) =>
          [seg.from, seg.to].map((u): [number, number] => {
            const p = facePoint(side, coord, u);
            return [u, roofHeightAt(sec, p.x, p.y) + above];
          });
        const bottom = prof(n, lowTop);
        out.push({ ...face(side, coord, seg.from, seg.to, bottom, prof(s, 0), true), lower: [{ line: bottom, thickness: lowTop }] });
      }
    }
  }
  return out;
}

function face(side: Side, coord: number, from: number, to: number, bottom: [number, number][], top: [number, number][], clerestory: boolean): Face {
  return { key: `${side}:${coord.toFixed(4)}:${from.toFixed(4)}`, side, coord, from, to, bottom, top, clerestory, lower: [] };
}

const uniq = (v: number[]) => [...v].sort((a, b) => a - b).filter((x, i, arr) => i === 0 || x - arr[i - 1] > EPS);

/** Drops repeated points (a stretch ending where the next begins at the same height). */
function dedupe(pts: [number, number][]): [number, number][] {
  return pts.filter((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) > EPS || Math.abs(p[1] - pts[i - 1][1]) > EPS);
}

/** The face a window (or exterior door, by its center) is in. */
export function faceAt(faces: readonly Face[], host: { side: Side; coord: number }, u: number): Face | null {
  return faces.find((f) => f.side === host.side && Math.abs(f.coord - host.coord) < 1e-4 && u >= f.from - 1e-4 && u <= f.to + 1e-4) ?? null;
}

/** Height of a face's top (or bottom) edge at u. */
export function edgeAt(edge: readonly [number, number][], u: number): number {
  for (let i = 0; i + 1 < edge.length; i++) {
    const [[ua, za], [ub, zb]] = [edge[i], edge[i + 1]];
    if (u >= ua - EPS && u <= ub + EPS) return ub - ua < EPS ? Math.max(za, zb) : za + ((zb - za) * (u - ua)) / (ub - ua);
  }
  return edge.length ? edge[edge.length - 1][1] : 0;
}

/** How steeply a line of [u, z] points rises at u (per foot along u); 0 off its ends. */
export function slopeAt(edge: readonly [number, number][], u: number): number {
  for (let i = 0; i + 1 < edge.length; i++) {
    const [[ua, za], [ub, zb]] = [edge[i], edge[i + 1]];
    if (ub - ua > EPS && u >= ua - EPS && u <= ub + EPS) return (zb - za) / (ub - ua);
  }
  return 0;
}

/** The top line of the lower roof meeting a face at u, if there is one. */
export function lowerRoofAt(f: Face, u: number): [number, number][] | null {
  const l = f.lower.find(({ line }) => line.length >= 2 && u >= line[0][0] - EPS && u <= line[line.length - 1][0] + EPS);
  return l?.line ?? null;
}

/**
 * Keeps roofline windows' slopes matched to their roofs (after the roof or outline
 * changes): the top to the roof above, the bottom to the lower roof if it follows
 * one (and there still is one), else level.
 */
export function syncRooflines(windows: readonly HouseWindow[], faces: readonly Face[]): HouseWindow[] {
  return windows.map((w) => {
    const s = w.shape;
    if (s.t !== 'roofline') return w;
    const u = s.u + s.w / 2;
    const f = faceAt(faces, w.host, u);
    if (!f) return w;
    const lower = s.lower ? lowerRoofAt(f, u) : null;
    const top = slopeAt(f.top, u);
    const bottom = lower ? slopeAt(lower, u) : 0;
    return top === s.top && bottom === s.bottom && s.lower === !!lower ? w : { ...w, shape: { ...s, top, bottom, lower: !!lower } };
  });
}

/**
 * After the outline changes, keeps windows in the wall they were in: a window whose
 * face line moved is carried to the nearest face of the same orientation that still
 * spans it (as exterior doors are).
 */
export function followWindows(windows: readonly HouseWindow[], before: readonly Face[], after: readonly Face[], center: (w: HouseWindow) => number): HouseWindow[] {
  return windows.map((w) => {
    const u = center(w);
    if (faceAt(after, w.host, u) || !faceAt(before, w.host, u)) return w;
    const candidates = after.filter((f) => f.side === w.host.side && u >= f.from - 1e-4 && u <= f.to + 1e-4);
    const best = candidates.sort((a, b) => Math.abs(a.coord - w.host.coord) - Math.abs(b.coord - w.host.coord))[0];
    return best ? { ...w, host: { side: w.host.side, coord: best.coord } } : w;
  });
}

/** Faces seen from outside: the face's direction, and which way u runs on screen (left to right). */
export function faceView(side: Side): { normal: { x: number; y: number }; flip: boolean } {
  // Looking at a south face from the south, west (smaller x) is on the left; at a north face, east is.
  switch (side) {
    case 'S':
      return { normal: { x: 0, y: 1 }, flip: false };
    case 'N':
      return { normal: { x: 0, y: -1 }, flip: true };
    case 'W':
      return { normal: { x: -1, y: 0 }, flip: false };
    case 'E':
      return { normal: { x: 1, y: 0 }, flip: true };
  }
}

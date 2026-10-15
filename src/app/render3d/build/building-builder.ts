import { sideSegments, SideSegment } from '../../core/geometry/edges';
import { roofHeightAt, roofSlope } from '../../core/geometry/roof';
import { oppositeSide, x0, x1, y0, y1 } from '../../core/geometry/rect';
import { SLAB_THICKNESS } from '../../core/model/defaults';
import { DesignSnapshot, Floor, HouseWindow, ProjectSettings, Section, Side, SIDES, Skylight } from '../../core/model/types';
import {
  BuildingModel,
  BuildingPiece,
  BuildView,
  EXTERIOR_VIEW,
  PlanPoint,
  PlanRect,
  PrismPiece,
  RoofPiece,
  SkylightPiece,
} from './building-model';
import { addFloors, excavation, viewCut } from './interior-builder';
import { buildWindows } from './window-builder';

/** Height difference (ft) below which two roofs are considered to meet level. */
const LEVEL_EPSILON = 0.01;
/** Positional/height tolerance (ft) for deciding whether two things coincide. */
const EPS = 1e-6;

/**
 * Geometry convention: section edges are wall *centerlines*. Every wall straddles
 * the line it was drawn on, half its thickness to each side, so walls that lie on
 * one line are one straight wall no matter which sections they belong to. The
 * building's outside faces are half a wall beyond the drawn lines (patios: half a
 * post), and slabs and roof overhangs are measured from those outside faces.
 */

/** Shared, precomputed data the per-section builders need. */
interface BuildContext {
  settings: ProjectSettings;
  byId: Map<string, Section>;
  /** Side segments per section id, keyed by side. */
  segments: Map<string, Record<Side, SideSegment[]>>;
}

/**
 * What gets built along a stretch of a section's perimeter, from that section's
 * own point of view:
 *  - 'wall': a true exterior wall (no neighbor, or the neighbor is an open patio).
 *  - 'posts': an open patio edge.
 *  - 'none': a boundary shared with another enclosed section, or a patio's side
 *    facing the enclosed section it's attached to. Nothing is built from this
 *    section's side; where two enclosed sections' rooflines step, the exposed part
 *    of the taller one above the lower roof is built once by
 *    `buildRooflineStepWalls` instead.
 */
type RunType = 'wall' | 'posts' | 'none';

interface PerimeterRun {
  side: Side;
  from: number;
  to: number;
  type: RunType;
}

// ===================================================================== entry point

/** The parts of a design the 3D model depends on (camera, names etc. excluded). */
export type BuildInput = Pick<DesignSnapshot, 'sections' | 'settings'> & {
  floors?: readonly Floor[];
  windows?: readonly HouseWindow[];
  skylights?: readonly Skylight[];
};

export function buildBuildingModel(design: BuildInput, view: BuildView = EXTERIOR_VIEW): BuildingModel {
  const ctx = createContext(design);
  const shell = [...design.sections.flatMap((s) => buildSectionPieces(s, ctx)), ...buildRooflineStepWalls(ctx)];
  const input = { sections: design.sections, settings: design.settings, floors: design.floors ?? [] };
  const pieces: BuildingPiece[] = [
    ...addFloors(shell, input, view),
    ...buildWindows(design.windows ?? [], design.settings, viewCut(input.floors, view)),
    // Floorplan mode takes the roofs off, skylights with them.
    ...(view.mode !== 'floorplan' ? buildSkylights(design.skylights ?? [], ctx) : []),
  ];
  return { pieces, excavation: excavation(input), bounds: computeBounds(pieces) };
}

function createContext({ sections, settings }: BuildInput): BuildContext {
  const segments = new Map<string, Record<Side, SideSegment[]>>();
  for (const s of sections) {
    segments.set(s.id, {
      N: sideSegments(s, 'N', sections),
      E: sideSegments(s, 'E', sections),
      S: sideSegments(s, 'S', sections),
      W: sideSegments(s, 'W', sections),
    });
  }
  return { settings, byId: new Map(sections.map((s) => [s.id, s])), segments };
}

/** Half the thickness of what stands on a section's edges: wall, or post for patios. */
export function edgeHalf(section: Section, settings: ProjectSettings): number {
  return (section.patio.enabled ? settings.postSize : settings.wallThickness) / 2;
}

function buildSectionPieces(section: Section, ctx: BuildContext): BuildingPiece[] {
  const runs = perimeterRuns(section, ctx);
  return [
    buildSlab(section, ctx),
    ...buildWalls(section, runs, ctx),
    ...buildPosts(section, runs, ctx),
    buildRoof(section, ctx),
  ];
}

// ===================================================================== perimeter

/**
 * Classifies every stretch of a section's perimeter. Enclosed sections are walled
 * everywhere they don't meet another enclosed section. Patio sections keep posts
 * on open edges and edges shared with other patios, and build nothing where they
 * meet an enclosed section (that section's own wall already covers it). Adjacent
 * stretches of the same type are merged.
 */
function perimeterRuns(section: Section, ctx: BuildContext): PerimeterRun[] {
  const runs: PerimeterRun[] = [];
  for (const side of SIDES) {
    for (const seg of ctx.segments.get(section.id)![side]) {
      const neighbor = seg.neighborId ? ctx.byId.get(seg.neighborId) : undefined;
      const type = runType(section, neighbor);
      const prev = runs.at(-1);
      if (prev && prev.side === side && prev.type === type && prev.to === seg.from) {
        prev.to = seg.to;
      } else {
        runs.push({ side, from: seg.from, to: seg.to, type });
      }
    }
  }
  return runs;
}

function runType(section: Section, neighbor: Section | undefined): RunType {
  if (section.patio.enabled) {
    return !neighbor || neighbor.patio.enabled ? 'posts' : 'none';
  }
  return !neighbor || neighbor.patio.enabled ? 'wall' : 'none';
}

/** The fixed coordinate of the line a side of `section` lies on. */
function sideLine(section: Section, side: Side): number {
  const r = section.rect;
  return side === 'N' ? y0(r) : side === 'S' ? y1(r) : side === 'W' ? x0(r) : x1(r);
}

/**
 * Footprint of a band of the given thickness centered on one side's line, running
 * from `from` to `to` along it.
 */
function bandAlongSide(section: Section, side: Side, from: number, to: number, thickness: number): PlanRect {
  const c = sideLine(section, side);
  const h = thickness / 2;
  return side === 'N' || side === 'S' ? { x0: from, x1: to, y0: c - h, y1: c + h } : { x0: c - h, x1: c + h, y0: from, y1: to };
}

// ===================================================================== pieces

/**
 * Floor slab out to the outside faces, its top at 0 so it never cuts into walls.
 * (Over a basement, the floors pass swaps the dug part for a framed deck.)
 */
function buildSlab(section: Section, ctx: BuildContext): PrismPiece {
  const r = section.rect;
  const h = edgeHalf(section, ctx.settings);
  const rect = { x0: x0(r) - h, y0: y0(r) - h, x1: x1(r) + h, y1: y1(r) + h };
  const piece = prismUnderRoof('slab', section, rect, () => 0);
  return { ...piece, bottom: [-SLAB_THICKNESS, -SLAB_THICKNESS, -SLAB_THICKNESS, -SLAB_THICKNESS] };
}

/**
 * One wall per exterior run, centered on the section's edge and carried half a
 * thickness past each end where the outline turns a corner, so the overhangs
 * exactly fill the corner square — outside corners and inside corners alike — and
 * overlapping corner squares fuse in merged-prisms. Where the wall instead carries
 * straight on as another section's wall (two sections side by side, e.g. the two
 * halves of a gable end), it stops at the shared line: carried on, each half's
 * sloped top would rise past the other's and the pair would peak twice.
 */
function buildWalls(section: Section, runs: PerimeterRun[], ctx: BuildContext): PrismPiece[] {
  const t = ctx.settings.wallThickness;
  return runs
    .filter((run) => run.type === 'wall')
    .map((run) => {
      const from = wallContinues(section, run.side, run.from, ctx) ? run.from : run.from - t / 2;
      const to = wallContinues(section, run.side, run.to, ctx) ? run.to : run.to + t / 2;
      return prismUnderRoof('wall', section, bandAlongSide(section, run.side, from, to, t), (p) => roofHeightAt(section, p.x, p.y));
    });
}

/**
 * True if another enclosed section has an exterior wall on the same side and line
 * as `section`'s `side`, ending at `along` — so a wall of `section` ending there
 * runs straight on into it rather than turning a corner.
 */
function wallContinues(section: Section, side: Side, along: number, ctx: BuildContext): boolean {
  const line = sideLine(section, side);
  for (const other of ctx.byId.values()) {
    if (other === section || other.patio.enabled || Math.abs(sideLine(other, side) - line) > EPS) continue;
    for (const seg of ctx.segments.get(other.id)![side]) {
      if (Math.abs(seg.from - along) > EPS && Math.abs(seg.to - along) > EPS) continue;
      if (runType(other, seg.neighborId ? ctx.byId.get(seg.neighborId) : undefined) === 'wall') return true;
    }
  }
  return false;
}

function buildPosts(section: Section, runs: PerimeterRun[], ctx: BuildContext): PrismPiece[] {
  const size = ctx.settings.postSize;
  const spacing = Math.max(size, section.patio.postSpacing);
  const seen = new Set<string>();
  const pieces: PrismPiece[] = [];

  for (const run of runs.filter((r) => r.type === 'posts')) {
    let positions = postPositions(run.from, run.to, spacing);
    // A post at a corner where the patio meets a wall (this section's own, or an
    // enclosed neighbor's) would sit inside the wall — the wall already holds that
    // corner up, so drop it.
    if (runEndTouchesSolid(section, runs, run, 'from')) positions = positions.filter((p) => Math.abs(p - run.from) > EPS);
    if (runEndTouchesSolid(section, runs, run, 'to')) positions = positions.filter((p) => Math.abs(p - run.to) > EPS);
    for (const along of positions) {
      const strip = bandAlongSide(section, run.side, along - size / 2, along + size / 2, size);
      const key = `${strip.x0.toFixed(3)},${strip.y0.toFixed(3)}`;
      if (seen.has(key)) continue; // corner posts are generated by both sides
      seen.add(key);
      pieces.push(prismUnderRoof('post', section, strip, (p) => roofHeightAt(section, p.x, p.y)));
    }
  }
  return pieces;
}

/** The plan point at one end of a perimeter run. */
function runEndPoint(section: Section, run: PerimeterRun, end: 'from' | 'to'): PlanPoint {
  const v = end === 'from' ? run.from : run.to;
  const c = sideLine(section, run.side);
  return run.side === 'N' || run.side === 'S' ? { x: v, y: c } : { x: c, y: v };
}

const pointsCoincide = (a: PlanPoint, b: PlanPoint): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

/**
 * True if a post run's end sits right where another, non-open run of the same
 * section starts or ends — either inline (same side) or across a rect corner.
 * Covers both real walls and 'none' runs (a redundant wall we chose not to draw
 * because the neighbor already builds it): either way there's a real wall there.
 */
function runEndTouchesSolid(section: Section, runs: PerimeterRun[], run: PerimeterRun, end: 'from' | 'to'): boolean {
  const p = runEndPoint(section, run, end);
  return runs.some(
    (other) =>
      other !== run &&
      other.type !== 'posts' &&
      (pointsCoincide(p, runEndPoint(section, other, 'from')) || pointsCoincide(p, runEndPoint(section, other, 'to'))),
  );
}

/**
 * Post center positions along [from, to]: one centered on each end (the corners)
 * and evenly spaced between them, no further apart than `spacing` on center.
 */
export function postPositions(from: number, to: number, spacing: number): number[] {
  const len = to - from;
  if (len <= EPS) return [from];
  const intervals = Math.max(1, Math.ceil(len / spacing - 1e-9));
  return Array.from({ length: intervals + 1 }, (_, i) => from + (len * i) / intervals);
}

// ===================================================================== roof

/**
 * Roof over the section, carried past the outside faces by the overhang on every
 * edge that overhangs. Where it doesn't (meeting a level or higher roof) it stops
 * at the shared line, so neighboring roofs meet exactly.
 */
function buildRoof(section: Section, ctx: BuildContext): RoofPiece {
  const r = section.rect;
  const o = ctx.settings.overhang + edgeHalf(section, ctx.settings);
  const footprint: PlanRect[] = [{ x0: x0(r), y0: y0(r), x1: x1(r), y1: y1(r) }];

  if (o > 0) {
    const segs = ctx.segments.get(section.id)!;
    const overhangs = (seg: SideSegment) => segmentGetsOverhang(section, seg, ctx);

    for (const side of SIDES) {
      for (const seg of segs[side].filter(overhangs)) {
        footprint.push(overhangStrip(section, side, seg.from, seg.to, o));
      }
    }

    // A corner is filled only when the segments meeting there both overhang.
    const endOverhangs = (side: Side, atStart: boolean) => {
      const list = segs[side];
      const seg = atStart ? list[0] : list[list.length - 1];
      return !!seg && overhangs(seg);
    };
    if (endOverhangs('N', true) && endOverhangs('W', true)) {
      footprint.push({ x0: x0(r) - o, x1: x0(r), y0: y0(r) - o, y1: y0(r) });
    }
    if (endOverhangs('N', false) && endOverhangs('E', true)) {
      footprint.push({ x0: x1(r), x1: x1(r) + o, y0: y0(r) - o, y1: y0(r) });
    }
    if (endOverhangs('S', true) && endOverhangs('W', false)) {
      footprint.push({ x0: x0(r) - o, x1: x0(r), y0: y1(r), y1: y1(r) + o });
    }
    if (endOverhangs('S', false) && endOverhangs('E', false)) {
      footprint.push({ x0: x1(r), x1: x1(r) + o, y0: y1(r), y1: y1(r) + o });
    }
  }

  const slope = roofSlope(section);
  return {
    kind: 'roof',
    sectionId: section.id,
    footprint,
    plane: roofPlane(section),
    verticalThickness: ctx.settings.roofThickness * Math.sqrt(1 + slope * slope),
  };
}

/**
 * Overhang rule: open edges always overhang. Where two sections meet, only the one
 * whose roof is higher along the shared edge overhangs; if they meet level, neither
 * does, so adjacent level roofs read as one continuous roof.
 */
export function segmentGetsOverhang(section: Section, seg: SideSegment, ctx: Pick<BuildContext, 'byId'>): boolean {
  if (!seg.neighborId) return true;
  const neighbor = ctx.byId.get(seg.neighborId);
  if (!neighbor) return true;
  const mid = (seg.from + seg.to) / 2;
  const p = seg.side === 'N' || seg.side === 'S' ? { x: mid, y: seg.coord } : { x: seg.coord, y: mid };
  return roofHeightAt(section, p.x, p.y) - roofHeightAt(neighbor, p.x, p.y) > LEVEL_EPSILON;
}

function overhangStrip(section: Section, side: Side, from: number, to: number, o: number): PlanRect {
  const r = section.rect;
  switch (side) {
    case 'N':
      return { x0: from, x1: to, y0: y0(r) - o, y1: y0(r) };
    case 'S':
      return { x0: from, x1: to, y0: y1(r), y1: y1(r) + o };
    case 'W':
      return { x0: x0(r) - o, x1: x0(r), y0: from, y1: to };
    case 'E':
      return { x0: x1(r), x1: x1(r) + o, y0: from, y1: to };
  }
}

/** How far skylight glass stands proud of the roof slab, above and below (ft). */
const SKYLIGHT_PROUD = 1.5 / 12;

/**
 * Skylights as glass slabs in the roof of the section they're over, clipped to that
 * section's roof, standing a little proud of the slab on both sides.
 */
function buildSkylights(skylights: readonly Skylight[], ctx: BuildContext): SkylightPiece[] {
  const out: SkylightPiece[] = [];
  for (const k of skylights) {
    const [cx, cy] = [(k.x0 + k.x1) / 2, (k.y0 + k.y1) / 2];
    const s = [...ctx.byId.values()].find((e) => cx > x0(e.rect) && cx < x1(e.rect) && cy > y0(e.rect) && cy < y1(e.rect));
    if (!s) continue;
    const r = { x0: Math.max(k.x0, x0(s.rect)), x1: Math.min(k.x1, x1(s.rect)), y0: Math.max(k.y0, y0(s.rect)), y1: Math.min(k.y1, y1(s.rect)) };
    if (r.x1 - r.x0 < EPS || r.y1 - r.y0 < EPS) continue;
    const slope = roofSlope(s);
    const plane = roofPlane(s);
    out.push({
      kind: 'skylight',
      sectionId: s.id,
      footprint: [r],
      plane: { ...plane, base: plane.base - SKYLIGHT_PROUD },
      verticalThickness: ctx.settings.roofThickness * Math.sqrt(1 + slope * slope) + 2 * SKYLIGHT_PROUD,
    });
  }
  return out;
}

/** Underside plane of the roof as z = base + gx·x + gy·y (matches roofHeightAt). */
function roofPlane(section: Section): RoofPiece['plane'] {
  const r = section.rect;
  const h = section.roof.lowWallHeight;
  const k = roofSlope(section);
  switch (section.roof.slopeDir) {
    case 'S':
      return { base: h + k * y1(r), gx: 0, gy: -k };
    case 'N':
      return { base: h - k * y0(r), gx: 0, gy: k };
    case 'E':
      return { base: h + k * x1(r), gx: -k, gy: 0 };
    case 'W':
      return { base: h - k * x0(r), gx: k, gy: 0 };
  }
}

// ===================================================================== helpers

function prismUnderRoof(
  kind: PrismPiece['kind'],
  section: Section,
  rect: PlanRect,
  topAt: (p: PlanPoint) => number,
  bottomAt: (p: PlanPoint) => number = () => 0,
): PrismPiece {
  const footprint: PrismPiece['footprint'] = [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
    { x: rect.x0, y: rect.y1 },
  ];
  return {
    kind,
    sectionId: section.id,
    footprint,
    bottom: footprint.map(bottomAt) as PrismPiece['bottom'],
    top: footprint.map(topAt) as PrismPiece['top'],
  };
}

/**
 * Where two enclosed sections share a boundary but their roofs don't meet level,
 * the wall on that line shows above the lower roof. Neither section builds a wall
 * on a shared boundary (see `runType`), so this builds that exposed part once per
 * boundary (`section.id < neighbor.id` skips the mirrored visit): centered on the
 * shared line like any other wall, from the lower roofline up to the taller one,
 * and carried half a thickness past each end into the walls it meets.
 */
function buildRooflineStepWalls(ctx: BuildContext): PrismPiece[] {
  const pieces: PrismPiece[] = [];
  const t = ctx.settings.wallThickness;

  for (const section of ctx.byId.values()) {
    if (section.patio.enabled) continue;
    for (const side of SIDES) {
      for (const seg of ctx.segments.get(section.id)![side]) {
        const neighbor = seg.neighborId ? ctx.byId.get(seg.neighborId) : undefined;
        if (!neighbor || neighbor.patio.enabled || section.id >= neighbor.id) continue;

        const mid = (seg.from + seg.to) / 2;
        const p = side === 'N' || side === 'S' ? { x: mid, y: seg.coord } : { x: seg.coord, y: mid };
        const hSelf = roofHeightAt(section, p.x, p.y);
        const hNeighbor = roofHeightAt(neighbor, p.x, p.y);
        if (Math.abs(hSelf - hNeighbor) < LEVEL_EPSILON) continue;

        const tall = hSelf > hNeighbor ? section : neighbor;
        const short = tall === section ? neighbor : section;
        const tallSide = tall === section ? side : oppositeSide(side);
        pieces.push(
          prismUnderRoof(
            'wall',
            tall,
            bandAlongSide(tall, tallSide, seg.from - t / 2, seg.to + t / 2, t),
            (q) => roofHeightAt(tall, q.x, q.y),
            (q) => roofHeightAt(short, q.x, q.y),
          ),
        );
      }
    }
  }
  return pieces;
}

export function roofHeightOnPlane(plane: RoofPiece['plane'], x: number, y: number): number {
  return plane.base + plane.gx * x + plane.gy * y;
}

function computeBounds(pieces: BuildingPiece[]): BuildingModel['bounds'] {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, maxHeight: 0 };
  const include = (x: number, y: number, h: number) => {
    b.x0 = Math.min(b.x0, x);
    b.y0 = Math.min(b.y0, y);
    b.x1 = Math.max(b.x1, x);
    b.y1 = Math.max(b.y1, y);
    b.maxHeight = Math.max(b.maxHeight, h);
  };
  for (const piece of pieces) {
    if (piece.kind === 'window') {
      // Within the walls' plan bounds already; only the height counts.
      for (const [, z] of piece.outline) b.maxHeight = Math.max(b.maxHeight, z);
    } else if (piece.kind === 'roof' || piece.kind === 'skylight') {
      for (const r of piece.footprint) {
        for (const [x, y] of [
          [r.x0, r.y0],
          [r.x1, r.y0],
          [r.x0, r.y1],
          [r.x1, r.y1],
        ]) {
          include(x, y, roofHeightOnPlane(piece.plane, x, y) + piece.verticalThickness);
        }
      }
    } else {
      piece.footprint.forEach((p, i) => include(p.x, p.y, piece.top[i]));
    }
  }
  if (!Number.isFinite(b.x0)) return { x0: 0, y0: 0, x1: 0, y1: 0, maxHeight: 0 };
  return b;
}

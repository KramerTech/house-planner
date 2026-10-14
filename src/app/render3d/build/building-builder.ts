import { sideSegments, SideSegment } from '../../core/geometry/edges';
import { roofHeightAt, roofSlope } from '../../core/geometry/roof';
import { x0, x1, y0, y1 } from '../../core/geometry/rect';
import { DesignSnapshot, ProjectSettings, Section, Side, SIDES } from '../../core/model/types';
import { BuildingModel, BuildingPiece, PlanPoint, PlanRect, PrismPiece, RoofPiece } from './building-model';

/** Height difference (ft) below which two roofs are considered to meet level. */
const LEVEL_EPSILON = 0.01;
/** Concrete slab thickness (ft). The slab sits entirely below y=0, where walls and posts start. */
export const SLAB_THICKNESS = 4 / 12;

/** Shared, precomputed data the per-section builders need. */
interface BuildContext {
  settings: ProjectSettings;
  byId: Map<string, Section>;
  /** Side segments per section id, keyed by side. */
  segments: Map<string, Record<Side, SideSegment[]>>;
}

/** What gets built along a stretch of a section's perimeter. */
type RunType = 'wall' | 'posts';

interface PerimeterRun {
  side: Side;
  from: number;
  to: number;
  type: RunType;
}

// ===================================================================== entry point

/** The parts of a design the 3D model depends on (camera, names etc. excluded). */
export type BuildInput = Pick<DesignSnapshot, 'sections' | 'settings'>;

export function buildBuildingModel(design: BuildInput): BuildingModel {
  const ctx = createContext(design);
  const pieces = design.sections.flatMap((s) => buildSectionPieces(s, ctx));
  return { pieces, bounds: computeBounds(pieces) };
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

function buildSectionPieces(section: Section, ctx: BuildContext): BuildingPiece[] {
  const runs = perimeterRuns(section, ctx);
  return [
    buildSlab(section),
    ...buildWalls(section, runs, ctx),
    ...buildPosts(section, runs, ctx),
    buildRoof(section, ctx),
  ];
}

// ===================================================================== perimeter

/**
 * Classifies every stretch of a section's perimeter. Enclosed sections are walled
 * all round. Patio sections only keep walls where they meet an enclosed section;
 * everything else (open edges and edges shared with other patios) becomes posts.
 * Adjacent stretches of the same type are merged.
 */
function perimeterRuns(section: Section, ctx: BuildContext): PerimeterRun[] {
  const runs: PerimeterRun[] = [];
  for (const side of SIDES) {
    for (const seg of ctx.segments.get(section.id)![side]) {
      const neighbor = seg.neighborId ? ctx.byId.get(seg.neighborId) : undefined;
      const type: RunType =
        section.patio.enabled && (!neighbor || neighbor.patio.enabled) ? 'posts' : 'wall';
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

/**
 * Footprint of a strip running along one side of `section`, from `from` to `to`
 * along the side and `inset` deep into the section.
 */
function stripAlongSide(section: Section, side: Side, from: number, to: number, inset: number): PlanRect {
  const r = section.rect;
  switch (side) {
    case 'N':
      return { x0: from, x1: to, y0: y0(r), y1: y0(r) + inset };
    case 'S':
      return { x0: from, x1: to, y0: y1(r) - inset, y1: y1(r) };
    case 'W':
      return { x0: x0(r), x1: x0(r) + inset, y0: from, y1: to };
    case 'E':
      return { x0: x1(r) - inset, x1: x1(r), y0: from, y1: to };
  }
}

// ===================================================================== pieces

/** Floor slab under the whole section footprint, kept below grade line so it never cuts into walls. */
function buildSlab(section: Section): PrismPiece {
  const r = section.rect;
  const piece = prismUnderRoof('slab', section, { x0: x0(r), y0: y0(r), x1: x1(r), y1: y1(r) }, () => 0);
  return { ...piece, bottom: [-SLAB_THICKNESS, -SLAB_THICKNESS, -SLAB_THICKNESS, -SLAB_THICKNESS] };
}

function buildWalls(section: Section, runs: PerimeterRun[], ctx: BuildContext): PrismPiece[] {
  const t = ctx.settings.wallThickness;
  const r = section.rect;
  const hasWallAt = (side: Side, at: number) =>
    runs.some((run) => run.side === side && run.type === 'wall' && run.from <= at && at <= run.to);

  return runs
    .filter((run) => run.type === 'wall')
    .map((run) => {
      let { from, to } = run;
      // E/W walls stop short of N/S walls at the corners so faces don't coincide.
      if (run.side === 'E' || run.side === 'W') {
        const cornerX = run.side === 'E' ? x1(r) : x0(r);
        if (from === y0(r) && hasWallAt('N', cornerX)) from += t;
        if (to === y1(r) && hasWallAt('S', cornerX)) to -= t;
      }
      return { run, from, to };
    })
    .filter(({ from, to }) => to - from > 1e-6)
    .map(({ run, from, to }) =>
      prismUnderRoof('wall', section, stripAlongSide(section, run.side, from, to, t), (p) =>
        roofHeightAt(section, p.x, p.y),
      ),
    );
}

function buildPosts(section: Section, runs: PerimeterRun[], ctx: BuildContext): PrismPiece[] {
  const size = ctx.settings.postSize;
  const spacing = Math.max(size, section.patio.postSpacing);
  const seen = new Set<string>();
  const pieces: PrismPiece[] = [];

  for (const run of runs.filter((r) => r.type === 'posts')) {
    for (const along of postPositions(run.from, run.to, size, spacing)) {
      const strip = stripAlongSide(section, run.side, along - size / 2, along + size / 2, size);
      const key = `${strip.x0.toFixed(3)},${strip.y0.toFixed(3)}`;
      if (seen.has(key)) continue; // corner posts are generated by both sides
      seen.add(key);
      pieces.push(prismUnderRoof('post', section, strip, (p) => roofHeightAt(section, p.x, p.y)));
    }
  }
  return pieces;
}

/**
 * Post center positions along [from, to]: one flush with each end and evenly spaced
 * between them, no further apart than `spacing` on center.
 */
export function postPositions(from: number, to: number, size: number, spacing: number): number[] {
  const len = to - from;
  if (len <= size) return [(from + to) / 2];
  const first = from + size / 2;
  const last = to - size / 2;
  const intervals = Math.max(1, Math.ceil((last - first) / spacing - 1e-9));
  return Array.from({ length: intervals + 1 }, (_, i) => first + ((last - first) * i) / intervals);
}

// ===================================================================== roof

function buildRoof(section: Section, ctx: BuildContext): RoofPiece {
  const r = section.rect;
  const o = ctx.settings.overhang;
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
    bottom: [0, 0, 0, 0],
    top: footprint.map(topAt) as PrismPiece['top'],
  };
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
    if (piece.kind === 'roof') {
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

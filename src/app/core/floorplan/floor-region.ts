import { STORY } from '../model/defaults';
import { Floor, ProjectSettings, Section } from '../model/types';
import { roofHeightAt, roofSlope } from '../geometry/roof';
import { CATALOG_BY_ID, stairOpeningLocal, toPlan } from './catalog';
import { x0, x1, y0, y1 } from '../geometry/rect';
import { boundary, Box, BoundarySeg, boxArea, cellsWhere, dilate, erode, pointIn, union, unionArea } from './region';

/** Narrower strips of headroom than this (ft) don't count as floor. */
const MIN_STRIP = 2;

/**
 * Everything the floor plan editor and the 3D builder need to know about where a
 * floor can have rooms. Section edges are wall centerlines, so:
 *  - lines: the floor's outline as drawn (wall centerlines);
 *  - footprint: that outline grown by half a wall (the walls' outside faces);
 *  - interior: shrunk by half a wall — the space inside the walls, where interior
 *    walls and doors go;
 *  - outer / faces: the straight faces outside and inside the walls.
 */
export interface FloorRegion {
  lines: Box[];
  footprint: Box[];
  interior: Box[];
  outer: BoundarySeg[];
  faces: BoundarySeg[];
  /** Exterior wall thickness. */
  t: number;
}

const rectBox = (s: Section): Box => ({ x0: x0(s.rect), y0: y0(s.rect), x1: x1(s.rect), y1: y1(s.rect) });

/** The enclosed (non-patio) part of the house: the ground floor's outline. */
export function houseBoxes(sections: readonly Section[]): Box[] {
  return sections.filter((s) => !s.patio.enabled).map(rectBox);
}

export function patioBoxes(sections: readonly Section[]): Box[] {
  return sections.filter((s) => s.patio.enabled).map(rectBox);
}

/**
 * Outline (wall centerlines) of a floor starting at `elevation`: the ground floor
 * (and a basement, which matches it) is the whole enclosed house; upper floors are the parts of it with at least 8' of headroom
 * under the roof. Every roof slopes one way, so that's always a strip of each
 * section running from its high wall toward its low wall, cut at whole inches.
 */
export function floorFootprint(sections: readonly Section[], elevation: number): Box[] {
  const enclosed = sections.filter((s) => !s.patio.enabled);
  if (elevation <= 0) return union(enclosed.map(rectBox));
  return union(
    enclosed
      .map((s) => headroomBox(s, elevation + STORY.minHeadroom))
      .filter((b): b is Box => !!b && b.x1 - b.x0 >= MIN_STRIP && b.y1 - b.y0 >= MIN_STRIP),
  );
}

function headroomBox(s: Section, need: number): Box | null {
  const b = rectBox(s);
  const k = roofSlope(s);
  const low = s.roof.lowWallHeight;
  if (k <= 0) return low >= need ? b : null;
  const run = Math.max(0, need - low) / k; // distance from the low wall where the roof reaches `need`
  const inch = (v: number, dir: 'up' | 'down') => (dir === 'up' ? Math.ceil(v * 12 - 1e-9) : Math.floor(v * 12 + 1e-9)) / 12;
  switch (s.roof.slopeDir) {
    case 'S':
      b.y1 = Math.min(b.y1, inch(y1(s.rect) - run, 'down'));
      break;
    case 'N':
      b.y0 = Math.max(b.y0, inch(y0(s.rect) + run, 'up'));
      break;
    case 'E':
      b.x1 = Math.min(b.x1, inch(x1(s.rect) - run, 'down'));
      break;
    case 'W':
      b.x0 = Math.max(b.x0, inch(x0(s.rect) + run, 'up'));
      break;
  }
  return b.x1 > b.x0 && b.y1 > b.y0 && roofHeightAt(s, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2) >= need - 1e-6 ? b : null;
}

/**
 * The region of a floor starting at `elevation`. `exclude` takes parts out of its
 * outline (a basement's undug areas), so walls run around them too.
 */
export function floorRegion(
  sections: readonly Section[],
  settings: ProjectSettings,
  elevation: number,
  exclude: readonly Box[] = [],
): FloorRegion {
  const outline = floorFootprint(sections, elevation);
  const lines = exclude.length
    ? cellsWhere([...outline, ...exclude], (x, y) => pointIn(outline, x, y) && !pointIn(exclude, x, y))
    : outline;
  const t = settings.wallThickness;
  const footprint = dilate(lines, t / 2);
  const interior = erode(lines, t / 2);
  return { lines, footprint, interior, outer: boundary(footprint), faces: boundary(interior), t };
}

/** A floor's region: a basement's leaves out its undug areas. */
export function regionOf(sections: readonly Section[], settings: ProjectSettings, floor: Floor): FloorRegion {
  return floorRegion(sections, settings, floor.elevation, isBasement(floor) ? floor.unexcavated : []);
}

export const isBasement = (floor: Pick<Floor, 'elevation'>) => floor.elevation < 0;

/**
 * Keeps a floor stack well formed: at most one basement (a first floor below 0, and
 * only with a floor above it), then the ground floor at exactly 0.
 */
export function normalizeLevels(floors: Floor[]): Floor[] {
  const basement = floors.length > 1 && floors[0].elevation < 0 ? 1 : 0;
  return floors.map((f, i) => (i === basement ? { ...f, elevation: 0 } : f));
}

/** Index of the ground floor (elevation 0): after the basement, if there is one. */
export function groundIndex(floors: readonly Pick<Floor, 'elevation'>[]): number {
  return Math.max(0, floors.findIndex((f) => f.elevation >= 0));
}

/**
 * Gross areas to the outside faces: the enclosed house (walls included), and the
 * covered patios beyond it (to the outside of their posts).
 */
export function grossAreas(sections: readonly Section[], settings: ProjectSettings): { enclosed: number; covered: number } {
  const house = dilate(houseBoxes(sections), settings.wallThickness / 2);
  const patios = dilate(patioBoxes(sections), settings.postSize / 2);
  const enclosed = unionArea(house);
  return { enclosed, covered: unionArea([...house, ...patios]) - enclosed };
}

/** The enclosed house's outside wall faces (patios excluded). */
export function wallFootprint(sections: readonly Section[], settings: ProjectSettings): Box[] {
  return dilate(houseBoxes(sections), settings.wallThickness / 2);
}

/**
 * The building's outside faces as one union: the house grown by half a wall and
 * patios by half a post. What the exterior dimensions measure.
 */
export function outsideFootprint(sections: readonly Section[], settings: ProjectSettings): Box[] {
  return union([...dilate(houseBoxes(sections), settings.wallThickness / 2), ...dilate(patioBoxes(sections), settings.postSize / 2)]);
}

/** Gross floor area of a floor: its outline minus openings to the floor below. */
export function floorArea(region: FloorRegion, openings: readonly Box[]): number {
  const gross = region.footprint.reduce((a, b) => a + boxArea(b), 0);
  const open = union(openings).reduce((a, b) => a + boxArea(b), 0);
  return Math.max(0, gross - open);
}

/**
 * Elevation for a new floor on top of `floors`: the default story height if the
 * roof leaves headroom there, else the minimum one; null if neither has any.
 */
export function nextFloorElevation(sections: readonly Section[], floors: readonly Floor[]): number | null {
  const top = floors.at(-1)?.elevation ?? 0;
  for (const rise of [STORY.defaultHeight, STORY.minHeight]) {
    if (floorFootprint(sections, top + rise).length > 0) return top + rise;
  }
  return null;
}

/** A stretch of an upper floor's outline that needs its own wall (or deliberately has none). */
export interface KneeStrip {
  side: BoundarySeg['side'];
  /** The wall's plan box, centered on the outline. */
  box: Box;
  /** Where the line runs along (x for N/S sides, y for E/W) and its fixed coordinate. */
  from: number;
  to: number;
  line: number;
}

/**
 * The walls an upper floor adds around itself: wherever its outline isn't already
 * the house's exterior wall (where headroom runs out under a sloped roof, or a lower
 * section's roof starts). Stretches that overlap or touch one of the floor's openings
 * to the floor below get no wall — there's nothing to wall off — and come back in
 * `open` instead, so the plan can show them as open.
 */
export function kneeStrips(
  region: FloorRegion,
  ground: FloorRegion,
  openings: readonly Box[],
): { walls: KneeStrip[]; open: KneeStrip[] } {
  const walls: KneeStrip[] = [];
  const open: KneeStrip[] = [];
  const t = region.t;
  for (const seg of region.outer) {
    const horizontal = seg.side === 'N' || seg.side === 'S';
    const [c0, c1] = seg.side === 'N' || seg.side === 'W' ? [seg.coord, seg.coord + t] : [seg.coord - t, seg.coord];
    const strip = (from: number, to: number): KneeStrip => ({
      side: seg.side,
      from,
      to,
      line: (c0 + c1) / 2,
      box: horizontal ? { x0: from, x1: to, y0: c0, y1: c1 } : { x0: c0, x1: c1, y0: from, y1: to },
    });
    // Openings reaching the wall's band (touching counts), as spans along the line.
    const gaps = openings
      .filter((o) => (horizontal ? o.y0 <= c1 + 1e-3 && o.y1 >= c0 - 1e-3 : o.x0 <= c1 + 1e-3 && o.x1 >= c0 - 1e-3))
      .map((o): [number, number] => (horizontal ? [o.x0, o.x1] : [o.y0, o.y1]));
    for (const [from, to] of subtractFaces(seg, ground.outer)) {
      for (const [a, b] of subtractSpans([[from, to]], gaps)) walls.push(strip(a, b));
      for (const [a, b] of intersectSpans([from, to], gaps)) open.push(strip(a, b));
    }
  }
  return { walls, open };
}

/** The parts of a face not covered by same-facing faces on the same line. */
function subtractFaces(seg: BoundarySeg, others: readonly BoundarySeg[]): [number, number][] {
  return subtractSpans(
    [[seg.from, seg.to]],
    others.filter((o) => o.side === seg.side && Math.abs(o.coord - seg.coord) <= 1e-6).map((o): [number, number] => [o.from, o.to]),
  );
}

function subtractSpans(spans: [number, number][], cuts: readonly [number, number][]): [number, number][] {
  let out = spans;
  for (const [lo, hi] of cuts) {
    out = out.flatMap(([a, b]): [number, number][] => {
      if (Math.min(b, hi) - Math.max(a, lo) <= 1e-6) return [[a, b]];
      return ([[a, Math.max(a, lo)], [Math.min(b, hi), b]] as [number, number][]).filter(([p, q]) => q - p > 1e-6);
    });
  }
  return out;
}

function intersectSpans([a, b]: [number, number], cuts: readonly [number, number][]): [number, number][] {
  return cuts
    .map(([lo, hi]): [number, number] => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([p, q]) => q - p > 1e-6);
}

/** Floor-to-floor height above floor `i`: to the next floor, or a typical story if it's the top one. */
export function floorRise(floors: readonly Floor[], i: number): number {
  const next = floors[i + 1];
  return next ? next.elevation - floors[i].elevation : STORY.defaultHeight;
}

/**
 * Openings floor `i` gets automatically from the stairs on the floor below (a
 * basement's stairs open the ground floor): each
 * stair's flight is opened from its top landing back until there's 8' of headroom
 * over every riser (see `stairOpeningLocal`).
 */
export function stairOpenings(floors: readonly Floor[], i: number): Box[] {
  if (i <= 0) return [];
  const below = floors[i - 1];
  const rise = floorRise(floors, i - 1);
  const out: Box[] = [];
  for (const it of below.items) {
    const cat = CATALOG_BY_ID.get(it.type);
    const local = cat && stairOpeningLocal(cat, rise, STORY.minHeadroom);
    if (!local) continue;
    const a = toPlan(local.x0, local.y0, it.x, it.y, it.rotation);
    const b = toPlan(local.x1, local.y1, it.x, it.y, it.rotation);
    out.push({ x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
  }
  return out;
}

/** Everything open to below on floor `i`: drawn openings plus the stair openings. */
export function openingsOf(floors: readonly Floor[], i: number): Box[] {
  return [...floors[i].openings, ...stairOpenings(floors, i)];
}

import { CATALOG_BY_ID, itemShape, toPlan } from '../../core/floorplan/catalog';
import { doorHeight, placeDoors } from '../../core/floorplan/doors';
import { FloorRegion, floorRise, groundIndex, isBasement, kneeStrips, openingsOf, regionOf } from '../../core/floorplan/floor-region';
import { Box, cellsWhere, pointIn, pointInBox } from '../../core/floorplan/region';
import { solidWalls, wallBoxes } from '../../core/floorplan/wall-graph';
import { roofHeightAt } from '../../core/geometry/roof';
import { x0, x1, y0, y1 } from '../../core/geometry/rect';
import { SLAB_THICKNESS, STORY } from '../../core/model/defaults';
import { Floor, ProjectSettings, Section } from '../../core/model/types';
import { BuildingPiece, BuildView, PlanRect, PrismPiece } from './building-model';
import { doorPieces } from './door-builder';
import { clampVertical, cutOpenings, Opening, rectPrism } from './prism-ops';

export interface InteriorInput {
  sections: readonly Section[];
  settings: ProjectSettings;
  floors: readonly Floor[];
}

/**
 * Adds the floors to the building shell for the given view.
 *
 * Exterior: the shell with exterior doors cut through it and hung in it, plus the
 * decks of upper floors (seen when the roof is hidden). Interior walls and furniture
 * are left out.
 *
 * Windows: as Exterior, plus every floor's interior walls (and upper floors' knee
 * walls) at full height, with their doors, so it's clear where they meet the
 * exterior walls when the roof is hidden. No furniture.
 *
 * Floorplan (one active floor): roofs removed and everything cut flat 9' above the
 * active floor (for a basement, at most at ground level); floors above it hidden.
 * Each floor up to the active one gets its deck, knee walls (where its outline
 * stops short of the exterior walls), interior walls with door openings, and
 * furniture. Floors below the active one have full-height interior walls; the
 * active floor's are kept low (5') so the layout is easy to see. Doors hang in
 * their openings (see door-builder.ts), the active floor's cut off with its walls.
 *
 * A basement, in every view, gets a slab and concrete foundation walls up to the
 * ground slab all around its outline (including where it borders undug ground),
 * and the ground floor over it becomes a framed deck instead of slab on grade.
 */
export function addFloors(shell: BuildingPiece[], input: InteriorInput, view: BuildView): BuildingPiece[] {
  const { sections, settings, floors } = input;
  if (floors.length === 0) return shell;
  const ti = settings.interiorWallThickness;
  const regions = floors.map((f) => regionOf(sections, settings, f));
  const g = groundIndex(floors);
  const ground = regions[g];
  const basement = g > 0 ? 0 : -1;

  const picked = view.mode === 'floorplan' ? floors.findIndex((f) => f.id === view.floorId) : -1;
  const active = view.mode === 'floorplan' ? (picked < 0 ? g : picked) : -1;
  const lastShown = view.mode === 'floorplan' ? active : floors.length - 1;

  // Doors in exterior walls (and upper floors' knee walls).
  const exteriorDoors: Opening[] = floors.flatMap((f, i) =>
    placeDoors(f, regions[i], ti)
      .filter((p) => p.exterior && p.valid)
      .map((p) => ({ box: p.box, bottom: f.elevation, top: f.elevation + doorHeight(p.door) })),
  );

  const shellWalls = shell.filter((p): p is PrismPiece => p.kind === 'wall');
  const open = floors.map((_, i) => openingsOf(floors, i));
  const upper = (i: number) => i > g;
  const knee =
    view.mode === 'exterior'
      ? []
      : floors.flatMap((f, i) => (upper(i) && i <= lastShown ? kneeWalls(f, regions[i], ground, sections, open[i]) : []));
  const foundation = basement >= 0 ? foundationWalls(floors[basement], regions[basement]) : [];
  const walls = cutOpenings([...shellWalls, ...knee, ...foundation], exteriorDoors);

  const decks = floors.flatMap((f, i) => (upper(i) && i <= lastShown ? deck(f, regions[i], ground, open[i]) : []));
  // Door leaves: only exterior doors in Exterior mode, since interior walls aren't
  // built there. The active floor's interior doors are cut off with its low walls.
  const leaves = floors.flatMap((f, i) =>
    i <= lastShown
      ? placeDoors(f, regions[i], ti)
          .filter((p) => p.valid && (p.exterior || view.mode !== 'exterior'))
          .flatMap((p) => {
            const pieces = doorPieces(p, f);
            if (i !== active || p.exterior) return pieces;
            return pieces.flatMap((q) => clampVertical(q, -Infinity, f.elevation + STORY.partitionPreviewHeight));
          })
      : [],
  );
  let others = shell.filter((p) => p.kind !== 'wall');
  if (basement >= 0) {
    // Over the dug part, the ground floor is framed rather than slab on grade.
    const dug = regions[basement].interior;
    const slabs = others.filter((p): p is PrismPiece => p.kind === 'slab');
    const dugOut = dug.map((box): Opening => ({ box, bottom: -Infinity, top: Infinity }));
    others = [...others.filter((p) => p.kind !== 'slab'), ...cutOpenings(slabs, dugOut), ...basementSlab(floors[basement], regions[basement])];
    if (lastShown >= g) decks.push(...groundDeck(floors[g], dug, open[g]));
  }

  if (view.mode === 'exterior') {
    return [...others, ...walls, ...decks, ...leaves];
  }

  // Interior walls on floors below the active one (every floor, in Windows mode) go
  // up to the ceiling; the active floor's stay low.
  const fullHeight = (j: number) => {
    const next = j + 1 < floors.length ? { floor: floors[j + 1], region: regions[j + 1], open: open[j + 1] } : null;
    return (box: PlanRect) => toCeiling(floors[j], box, sections, next);
  };
  const interior: PrismPiece[] = [];
  for (let j = 0; j <= lastShown; j++) {
    const f = floors[j];
    const preview = (box: PlanRect) => [
      rectPrism({ kind: 'partition', sectionId: f.id }, box, () => f.elevation, () => f.elevation + STORY.partitionPreviewHeight),
    ];
    interior.push(...partitions(f, regions[j], ti, j === active ? preview : fullHeight(j)));
    if (view.mode === 'floorplan') interior.push(...furniture(f, floorRise(floors, j), j + 1 < floors.length));
  }

  if (view.mode === 'windows') return [...others, ...walls, ...decks, ...interior, ...leaves];

  const cut = viewCut(floors, view);
  const capped = (pieces: PrismPiece[]) => pieces.flatMap((p) => clampVertical(p, -Infinity, cut));
  const rest = others.filter((p): p is PrismPiece => p.kind !== 'roof');
  return [...capped(rest), ...capped(walls), ...decks, ...capped(interior), ...capped(leaves)];
}

/**
 * Where a view cuts everything off: nowhere in Exterior; in Floorplan, 9' above the
 * active floor (for a basement, no higher than ground level).
 */
export function viewCut(floors: readonly Floor[], view: BuildView): number {
  if (view.mode !== 'floorplan' || floors.length === 0) return Infinity;
  const picked = floors.findIndex((f) => f.id === view.floorId);
  const floor = floors[picked < 0 ? groundIndex(floors) : picked];
  const top = floor.elevation + STORY.cutHeight;
  return isBasement(floor) ? Math.min(top, 0) : top;
}

/** Where the ground is dug out: a basement's footprint, to its foundation walls' outside faces. */
export function excavation(input: InteriorInput): PlanRect[] {
  const basement = input.floors[0];
  if (!basement || !isBasement(basement) || input.floors.length < 2) return [];
  return regionOf(input.sections, input.settings, basement).footprint;
}

// ===================================================================== pieces

/** The ground floor's deck over a basement: the dug area inside its walls, minus openings. */
function groundDeck(floor: Floor, dug: Box[], openings: Box[]): PrismPiece[] {
  const cells = cellsWhere([...dug, ...openings], (x, y) => pointIn(dug, x, y) && !pointIn(openings, x, y));
  return cells.map((c) => rectPrism({ kind: 'deck', sectionId: floor.id }, c, () => -STORY.deckThickness, () => 0));
}

/** A basement's concrete floor, out under its foundation walls. */
function basementSlab(floor: Floor, region: FloorRegion): PrismPiece[] {
  const top = floor.elevation;
  return region.footprint.map((c) => rectPrism({ kind: 'slab', sectionId: floor.id }, c, () => top - SLAB_THICKNESS, () => top));
}

/**
 * A basement's foundation walls: the band between its outline's outside and inside
 * faces, from its floor up to the underside of the ground slab.
 */
function foundationWalls(floor: Floor, region: FloorRegion): PrismPiece[] {
  const cells = cellsWhere(
    [...region.footprint, ...region.interior],
    (x, y) => pointIn(region.footprint, x, y) && !pointIn(region.interior, x, y),
  );
  return cells.map((c) => rectPrism({ kind: 'foundation', sectionId: floor.id }, c, () => floor.elevation, () => -SLAB_THICKNESS));
}

/** An upper floor's deck: its outline inside the exterior walls, minus openings. */
function deck(floor: Floor, region: FloorRegion, ground: FloorRegion, openings: Box[]): PrismPiece[] {
  const cells = cellsWhere(
    [...region.footprint, ...ground.interior, ...openings],
    (x, y) => pointIn(region.footprint, x, y) && pointIn(ground.interior, x, y) && !pointIn(openings, x, y),
  );
  const top = floor.elevation;
  const bottom = top - STORY.deckThickness;
  return cells.map((c) => rectPrism({ kind: 'deck', sectionId: floor.id }, c, () => bottom, () => top));
}

/**
 * Walls around an upper floor where its outline isn't the house's exterior wall
 * (see `kneeStrips`; none where the floor is open to below): centered on the
 * outline like every wall, from the floor up to the roof of the section on the
 * floor's side of the line.
 */
function kneeWalls(
  floor: Floor,
  region: FloorRegion,
  ground: FloorRegion,
  sections: readonly Section[],
  openings: Box[],
): PrismPiece[] {
  const enclosed = sections.filter((s) => !s.patio.enabled);
  const out: PrismPiece[] = [];
  for (const k of kneeStrips(region, ground, openings).walls) {
    const horizontal = k.side === 'N' || k.side === 'S';
    const inward = k.side === 'N' || k.side === 'W' ? 1 : -1;
    // Split where the section on the floor's side changes, for its roof height.
    const cuts = [k.from, k.to, ...enclosed.flatMap((s) => (horizontal ? [x0(s.rect), x1(s.rect)] : [y0(s.rect), y1(s.rect)]))]
      .filter((v) => v >= k.from && v <= k.to)
      .sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      if (cuts[i + 1] - cuts[i] <= 1e-6) continue;
      const mid = (cuts[i] + cuts[i + 1]) / 2;
      const probe = horizontal ? { x: mid, y: k.line + inward * 1e-3 } : { x: k.line + inward * 1e-3, y: mid };
      const s = enclosed.find((e) => probe.x > x0(e.rect) && probe.x < x1(e.rect) && probe.y > y0(e.rect) && probe.y < y1(e.rect));
      if (!s) continue;
      const strip: PlanRect = horizontal
        ? { x0: cuts[i], x1: cuts[i + 1], y0: k.box.y0, y1: k.box.y1 }
        : { x0: k.box.x0, x1: k.box.x1, y0: cuts[i], y1: cuts[i + 1] };
      const piece = rectPrism({ kind: 'wall', sectionId: s.id }, strip, () => floor.elevation, (p) => roofHeightAt(s, p.x, p.y));
      if (piece.top.every((h) => h > floor.elevation)) out.push(piece);
    }
  }
  return out;
}

/**
 * Interior walls (room dividers aren't built), each raised from its plan box by
 * `raise`, with door openings cut through.
 */
function partitions(floor: Floor, region: FloorRegion, ti: number, raise: (box: PlanRect) => PrismPiece[]): PrismPiece[] {
  const walls = [...wallBoxes(solidWalls(floor), ti).values()].flatMap(raise);
  const bottom = floor.elevation;
  const doors: Opening[] = placeDoors(floor, region, ti)
    .filter((p) => !p.exterior && p.valid)
    .map((p) => ({ box: p.box, bottom, top: bottom + doorHeight(p.door) }));
  return cutOpenings(walls, doors);
}

/**
 * An interior wall from its floor to the ceiling: the underside of the next floor's
 * deck where that floor is over it, else the roof of the section it's in (split where
 * either changes, e.g. a one-story wing beside a two-story part).
 */
function toCeiling(
  floor: Floor,
  box: PlanRect,
  sections: readonly Section[],
  next: { floor: Floor; region: FloorRegion; open: Box[] } | null,
): PrismPiece[] {
  const enclosed = sections.filter((s) => !s.patio.enabled);
  const rects = enclosed.map((s) => ({ x0: x0(s.rect), x1: x1(s.rect), y0: y0(s.rect), y1: y1(s.rect) }));
  const edges = [...rects, ...(next ? [...next.region.footprint, ...next.open] : [])];
  const splits = (lo: number, hi: number, vs: number[]) =>
    [lo, hi, ...vs.filter((v) => v > lo + 1e-6 && v < hi - 1e-6)].sort((a, b) => a - b);
  const xs = splits(box.x0, box.x1, edges.flatMap((e) => [e.x0, e.x1]));
  const ys = splits(box.y0, box.y1, edges.flatMap((e) => [e.y0, e.y1]));
  const base = { kind: 'partition' as const, sectionId: floor.id };
  const out: PrismPiece[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cell = { x0: xs[i], x1: xs[i + 1], y0: ys[j], y1: ys[j + 1] };
      if (cell.x1 - cell.x0 <= 1e-6 || cell.y1 - cell.y0 <= 1e-6) continue;
      const mx = (cell.x0 + cell.x1) / 2;
      const my = (cell.y0 + cell.y1) / 2;
      if (next && pointIn(next.region.footprint, mx, my) && !pointIn(next.open, mx, my)) {
        const top = next.floor.elevation - STORY.deckThickness;
        out.push(rectPrism(base, cell, () => floor.elevation, () => top));
        continue;
      }
      const k = rects.findIndex((r) => pointInBox(r, mx, my));
      if (k >= 0) out.push(rectPrism(base, cell, () => floor.elevation, (p) => roofHeightAt(enclosed[k], p.x, p.y)));
    }
  }
  return out;
}

function furniture(floor: Floor, rise: number, floorAbove: boolean): PrismPiece[] {
  const out: PrismPiece[] = [];
  for (const item of floor.items) {
    const cat = CATALOG_BY_ID.get(item.type);
    if (!cat) continue;
    const parts = itemShape(cat, rise, floorAbove).parts;
    for (const part of parts) {
      const a = toPlan(part.x0, part.y0, item.x, item.y, item.rotation);
      const b = toPlan(part.x1, part.y1, item.x, item.y, item.rotation);
      const r = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
      out.push(
        rectPrism(
          { kind: 'furniture', sectionId: floor.id, color: part.color ?? cat.color },
          r,
          () => floor.elevation + part.z0,
          () => floor.elevation + part.z1,
        ),
      );
    }
  }
  return out;
}

/**
 * Renderer-agnostic description of the building. The builder turns a Project into
 * these plain-data pieces, and the three.js layer turns pieces into meshes. Keeping
 * this intermediate representation lets us test the geometry rules without WebGL
 * and add new piece kinds (doors, windows, trim…) without touching the project model.
 *
 * 3D convention: plan (x, y) maps to world (X, Z); world Y is up. Units are feet.
 */

/** 2D point in plan space (x east, y south). */
export interface PlanPoint {
  x: number;
  y: number;
}

/**
 * A vertical prism over a convex quad footprint, with independent bottom and top
 * heights per corner. This covers walls with sloped tops, posts and floor slabs,
 * a basement's foundation walls, garage doors, and the interior: partitions
 * (interior walls), framed floor decks and furniture.
 */
export interface PrismPiece {
  kind: 'wall' | 'post' | 'slab' | 'foundation' | 'door' | 'partition' | 'deck' | 'furniture';
  /** The section (or, for interior pieces, the floor) the piece belongs to. */
  sectionId: string;
  footprint: [PlanPoint, PlanPoint, PlanPoint, PlanPoint];
  bottom: [number, number, number, number];
  top: [number, number, number, number];
  /** Furniture and doors only: surface color. */
  color?: string;
  /**
   * Doors only: drawn turned about the vertical axis through plan point (x, y) by
   * `angle` radians (from +x toward +y), like a leaf swung open on its hinges. The
   * footprint is the unturned (closed) position, so the piece merges like any box.
   */
  turn?: { x: number; y: number; angle: number };
}

/** Rectangle in plan space used to describe roof footprints. */
export interface PlanRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A planar roof slab. Its footprint is a union of axis-aligned rectangles (the core
 * plus whichever overhang strips apply), and every point's underside height comes
 * from a single plane: z = base + gx * x + gy * y.
 */
export interface RoofPiece {
  kind: 'roof';
  sectionId: string;
  footprint: PlanRect[];
  plane: { base: number; gx: number; gy: number };
  /** Vertical thickness of the slab (perpendicular thickness / cos(angle)). */
  verticalThickness: number;
}

/**
 * A window's glass: its outline on the wall face, extruded straight through the
 * wall and a little proud of both sides (no hole is cut; the glass is opaque).
 * Outline points are [u, z]: along the face in plan (x for walls running E/W, y for
 * N/S) and height.
 */
export interface WindowPiece {
  kind: 'window';
  /** Which plan axis the wall runs along. */
  axis: 'x' | 'y';
  /** The plan coordinate across the wall of the glass's middle (the wall's centerline). */
  across: number;
  /** Total thickness of the glass slab. */
  depth: number;
  outline: [number, number][];
  /** Sash and grille lines drawn on both faces of the glass. */
  bars: [[number, number], [number, number]][];
}

/** A skylight: glass in the roof plane, a little proud of the roof slab above and below. */
export interface SkylightPiece extends Omit<RoofPiece, 'kind'> {
  kind: 'skylight';
}

export type BuildingPiece = PrismPiece | RoofPiece | WindowPiece | SkylightPiece;
export type PieceKind = BuildingPiece['kind'];

/**
 * What the 3D view shows: the whole building (Exterior); the whole building with
 * every floor's interior walls at full height (Windows); or one floor being laid
 * out (Floorplan) — roof off, walls cut flat above that floor, floors above hidden.
 */
export type BuildView = { mode: 'exterior' } | { mode: 'windows' } | { mode: 'floorplan'; floorId: string };

export const EXTERIOR_VIEW: BuildView = { mode: 'exterior' };

export interface BuildingModel {
  pieces: BuildingPiece[];
  /** Plan area dug out below grade (a basement, to its foundation walls' outside faces). */
  excavation: PlanRect[];
  /** Plan bounds of everything, for camera framing and shadow setup. */
  bounds: PlanRect & { maxHeight: number };
}

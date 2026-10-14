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
 * heights per corner. This covers walls with sloped tops, posts and floor slabs.
 */
export interface PrismPiece {
  kind: 'wall' | 'post' | 'slab';
  sectionId: string;
  footprint: [PlanPoint, PlanPoint, PlanPoint, PlanPoint];
  bottom: [number, number, number, number];
  top: [number, number, number, number];
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

export type BuildingPiece = PrismPiece | RoofPiece;
export type PieceKind = BuildingPiece['kind'];

export interface BuildingModel {
  pieces: BuildingPiece[];
  /** Plan bounds of everything, for camera framing and shadow setup. */
  bounds: PlanRect & { maxHeight: number };
}

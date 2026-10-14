/**
 * Core domain model. All plan-space units are feet.
 *
 * Plan coordinate system (2D):
 *   +x → east, +y → south (screen-down is south, so north is "up" in the editor).
 * A section rectangle is anchored at its north-west corner (x, y) with width `w`
 * along x and depth `d` along y. Layout coordinates are always integers.
 */

/** Cardinal side of a rectangle / compass direction. */
export type Side = 'N' | 'E' | 'S' | 'W';

export const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];

export interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface RoofSpec {
  /** Direction the roof slopes *down* toward. The low wall is on this side. */
  slopeDir: Side;
  /** Rise per 12 units of run. */
  pitch: number;
  /** Height (ft) of the top of the lowest wall, i.e. the bottom of the roof at the low side. */
  lowWallHeight: number;
}

export interface PatioSpec {
  enabled: boolean;
  /** Maximum on-center spacing (ft) between posts. */
  postSpacing: number;
}

export interface Section {
  id: string;
  rect: Rect;
  roof: RoofSpec;
  /** Enclosed but not conditioned (garage, shop, storage). Required for `patio`. */
  unheated: boolean;
  /** Open-sided covered patio. Only valid when `unheated` is set. */
  patio: PatioSpec;
}

export interface ProjectSettings {
  /** Roof slab thickness, measured perpendicular to the roof plane (ft). */
  roofThickness: number;
  /** Roof overhang past the wall line (ft). */
  overhang: number;
  /** Wall thickness (ft). */
  wallThickness: number;
  /** Square post size (ft). */
  postSize: number;
  /** Preferred depth (ft) for newly added sections. */
  defaultSectionDepth: number;
}

/** 3D camera pose (world coordinates, feet). */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

/** The parts of a project that make up a design iteration. */
export interface DesignSnapshot {
  rootId: string;
  sections: Section[];
  settings: ProjectSettings;
  camera: CameraState | null;
}

export interface Checkpoint {
  id: string;
  name: string;
  createdAt: number;
  snapshot: DesignSnapshot;
}

export interface Project extends DesignSnapshot {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Saved iterations of this project's design, oldest first. */
  checkpoints: Checkpoint[];
  /** The checkpoint last saved or restored, if any. */
  activeCheckpointId: string | null;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

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
  /**
   * Enclosed but not conditioned (garage, shop, storage). Not currently editable in
   * the UI (it will return with room definitions); kept for area accounting.
   */
  unheated: boolean;
  /** Open-sided covered patio. */
  patio: PatioSpec;
}

// ===================================================================== floor plans

/** A corner or end point of interior walls on one floor. */
export interface PlanNode {
  id: string;
  x: number;
  y: number;
}

/** A straight interior wall between two nodes. Always runs N/S or E/W. */
export interface InteriorWall {
  id: string;
  a: string;
  b: string;
  /**
   * A room divider: a line that splits rooms (so each part can be named) without
   * being built. Drawn dashed; holds no doors.
   */
  divider?: boolean;
}

export type DoorKind = 'single' | 'double' | 'pocket' | 'barn' | 'opening' | 'garage';

/**
 * The wall a door sits in: an interior wall (by id), or an exterior wall — identified
 * by the outward direction of the face and the coordinate of its outer face line
 * (y for N/S faces, x for E/W faces), since exterior walls are derived from sections.
 */
export type DoorHost = { wallId: string } | { side: Side; coord: number };

export interface Door {
  id: string;
  host: DoorHost;
  /** Center of the door along the wall's line (x for E/W-running walls, y for N/S). */
  at: number;
  width: number;
  kind: DoorKind;
  /** Side the leaf swings toward: +1 = toward +y (or +x) of the wall line, -1 = the other. */
  swing: 1 | -1;
  /** Hinge end: +1 = the end with the larger coordinate along the wall, -1 = the smaller. */
  hinge: 1 | -1;
  /** Garage doors only: the opening's height (ft). Other doors are a standard 6'8". */
  height?: number;
}

export type Rotation = 0 | 90 | 180 | 270;

/** A piece of furniture or a fixture, placed by its center. */
export interface FurnitureItem {
  id: string;
  /** Catalog id (see core/floorplan/catalog.ts). */
  type: string;
  x: number;
  y: number;
  /** Clockwise, in plan view. */
  rotation: Rotation;
}

/**
 * A plan rectangle on a floor: on floors above the lowest, a part left open to the
 * floor below (stairs, lofts, great rooms); on a basement, a part not dug out.
 */
export interface FloorOpening {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A room's name. Rooms are worked out from the walls, so a name is pinned to a
 * point: the room containing that point shows it, and it stays with the room as
 * walls move around it.
 */
export interface RoomName {
  id: string;
  x: number;
  y: number;
  name: string;
}

/**
 * Furniture that selects, moves and rotates as one. Members are item ids or other
 * groups' ids (groups nest); each item or group belongs to at most one group.
 */
export interface ItemGroup {
  id: string;
  members: string[];
}

/**
 * One story. Floors are kept lowest first: an optional basement (negative
 * elevation), then the ground floor at elevation 0, then the floors above it.
 */
export interface Floor {
  id: string;
  /** Height (ft) of the finished floor above the ground floor (negative for a basement). */
  elevation: number;
  nodes: PlanNode[];
  walls: InteriorWall[];
  doors: Door[];
  items: FurnitureItem[];
  /** Parts open to the floor below. Only meaningful on floors with a floor below. */
  openings: FloorOpening[];
  /** Basement only: parts of the house's footprint left undug (slab on grade above). */
  unexcavated: FloorOpening[];
  roomNames: RoomName[];
  groups: ItemGroup[];
}

// ===================================================================== windows

/**
 * A window's shape on its wall face, in face coordinates: u runs along the face in
 * plan (x for N/S faces, y for E/W faces) and z is the height above the ground floor.
 */
export type WindowShape =
  /** Lower-left corner (smallest u), width and height. */
  | { t: 'rect'; u: number; z: number; w: number; h: number }
  /** Center and radius. */
  | { t: 'circle'; u: number; z: number; r: number }
  /** A rectangle with a half-round top: lower-left corner, width, and overall height (at least w/2). */
  | { t: 'arch'; u: number; z: number; w: number; h: number }
  /** Any outline, as [u, z] points. */
  | { t: 'poly'; pts: [number, number][] }
  /**
   * A rectangle whose top runs at the pitch of the roof above it (and, if `lower`,
   * whose bottom runs at the pitch of a lower roof below it). From its left edge at
   * u: the bottom is at z there and rises `bottom` per foot; the top is h above
   * that and rises `top` per foot. The slopes are kept matched to the roofs.
   */
  | { t: 'roofline'; u: number; z: number; w: number; h: number; top: number; bottom: number; lower: boolean };

/**
 * How a window opens, as drawn: fixed glass, double-hung (an upper and a lower
 * sash), a horizontal slider, or casement/awning (hinged at a side / the top).
 */
export type WindowStyle = 'fixed' | 'double-hung' | 'slider' | 'casement' | 'awning';

/** A window in an exterior wall. */
export interface HouseWindow {
  id: string;
  /** The wall face it's in: the outward direction and the outer face's line, like an exterior door. */
  host: { side: Side; coord: number };
  shape: WindowShape;
  style: WindowStyle;
  /** Grille (muntin) grid: panes across and down; 1 × 1 is none. */
  grille: { cols: number; rows: number };
}

/** A rectangular skylight in a roof, by its plan rectangle. */
export interface Skylight {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ProjectSettings {
  /** Roof slab thickness, measured perpendicular to the roof plane (ft). */
  roofThickness: number;
  /** Roof overhang past the wall line (ft). */
  overhang: number;
  /** Exterior wall thickness (ft). */
  wallThickness: number;
  /** Interior wall thickness (ft). */
  interiorWallThickness: number;
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
  /** Stories, lowest first: an optional basement, the ground floor, then upper floors. */
  floors: Floor[];
  settings: ProjectSettings;
  camera: CameraState | null;
  /** Windows in the exterior walls (not per floor: a window can span floors). */
  windows: HouseWindow[];
  skylights: Skylight[];
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

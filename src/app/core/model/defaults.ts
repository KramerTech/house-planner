import { Floor, PatioSpec, Project, ProjectSettings, RoofSpec, Section } from './types';

export const SCHEMA_VERSION = 7;

/** Layout limits (ft). */
export const MIN_SECTION_SIZE = 1;
/** Sections must stay within ±WORLD_LIMIT ft of the origin. */
export const WORLD_LIMIT = 500;

export const ROOF_LIMITS = {
  pitch: { min: 0, max: 12, step: 0.5 },
  lowWallHeight: { min: 9, max: 26 },
} as const;

export const PATIO_LIMITS = {
  postSpacing: { min: 4, max: 16, step: 0.5 },
} as const;

/** Story rules (ft). */
export const STORY = {
  /** Each floor starts at least this far above the one below (so 9, 18, 27…). */
  minHeight: 9,
  /** Default rise for a newly added floor: a 9' ceiling plus the floor structure. */
  defaultHeight: 10,
  /** Clear height needed under the roof for an upper floor to extend somewhere. */
  minHeadroom: 8,
  /** Thickness of an upper floor's deck (joists + subfloor), below its elevation. */
  deckThickness: 1,
  /** Height the active floor's exterior walls are cut at in Floorplan mode. */
  cutHeight: 9,
  /** Height of the active floor's interior walls in Floorplan mode. */
  partitionPreviewHeight: 5,
  /** Height of door openings. */
  doorHeight: 6 + 8 / 12,
} as const;

/** Concrete slab thickness (ft): the ground slab sits just below 0, a basement's below its floor. */
export const SLAB_THICKNESS = 4 / 12;

/**
 * Basement rules (ft). Depth is from the ground floor down to the basement floor,
 * so the clear height is that less the ground floor's deck.
 */
export const BASEMENT = {
  defaultDepth: 9,
  /** A 7' ceiling (the code minimum) under the deck. */
  minDepth: 7 + STORY.deckThickness,
  maxDepth: 13 + STORY.deckThickness,
} as const;

export const DEFAULT_ROOF: RoofSpec = { slopeDir: 'S', pitch: 3, lowWallHeight: 9 };
export const DEFAULT_PATIO: PatioSpec = { enabled: false, postSpacing: 8 };

export const DEFAULT_SETTINGS: ProjectSettings = {
  roofThickness: 0.5,
  overhang: 2,
  wallThickness: 0.5,
  interiorWallThickness: 4.5 / 12,
  postSize: 0.5,
  defaultSectionDepth: 12,
};

export function newId(): string {
  return crypto.randomUUID();
}

export function createSection(rect: Section['rect'], roof: Partial<RoofSpec> = {}): Section {
  return {
    id: newId(),
    rect: { ...rect },
    roof: { ...DEFAULT_ROOF, ...roof },
    unheated: false,
    patio: { ...DEFAULT_PATIO },
  };
}

export function createFloor(elevation = 0): Floor {
  return { id: newId(), elevation, nodes: [], walls: [], doors: [], items: [], openings: [], unexcavated: [], roomNames: [], groups: [] };
}

export function createProject(name: string): Project {
  const root = createSection({ x: 0, y: 0, w: 16, d: 12 });
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    rootId: root.id,
    sections: [root],
    floors: [createFloor()],
    settings: { ...DEFAULT_SETTINGS },
    camera: null,
    windows: [],
    skylights: [],
    checkpoints: [],
    activeCheckpointId: null,
  };
}

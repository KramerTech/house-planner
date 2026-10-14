import { PatioSpec, Project, ProjectSettings, RoofSpec, Section } from './types';

export const SCHEMA_VERSION = 3;

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

export const DEFAULT_ROOF: RoofSpec = { slopeDir: 'S', pitch: 3, lowWallHeight: 9 };
export const DEFAULT_PATIO: PatioSpec = { enabled: false, postSpacing: 8 };

export const DEFAULT_SETTINGS: ProjectSettings = {
  roofThickness: 0.5,
  overhang: 2,
  wallThickness: 0.5,
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
    settings: { ...DEFAULT_SETTINGS },
    camera: null,
    checkpoints: [],
    activeCheckpointId: null,
  };
}

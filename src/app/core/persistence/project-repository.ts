import { Injectable } from '@angular/core';
import { createFloor, DEFAULT_PATIO, DEFAULT_ROOF, DEFAULT_SETTINGS, newId, SCHEMA_VERSION } from '../model/defaults';
import { Checkpoint, DesignSnapshot, Floor, Project, ProjectMeta, ProjectSettings, Section } from '../model/types';
import { floorFootprint, normalizeLevels, regionOf } from '../floorplan/floor-region';
import { boundary, erode } from '../floorplan/region';
import { followOutline } from '../floorplan/wall-graph';

const PREFIX = 'home-designer';
/** Storage prefix used before the app was renamed; migrated once on startup. */
const LEGACY_PREFIX = 'shed-designer';
const INDEX_KEY = `${PREFIX}:index`;
const LAST_OPEN_KEY = `${PREFIX}:last-open`;
/** Set once the example projects have been loaded here; they're never loaded again. */
const EXAMPLES_KEY = `${PREFIX}:examples-loaded`;
const projectKey = (id: string) => `${PREFIX}:project:${id}`;

/**
 * localStorage-backed persistence. Each project is stored under its own key, with a
 * small index of metadata for the project picker. All access is guarded so that a
 * full or unavailable storage never breaks the app.
 */
@Injectable({ providedIn: 'root' })
export class ProjectRepository {
  constructor() {
    migrateLegacyKeys();
  }

  listProjects(): ProjectMeta[] {
    const index = this.read<ProjectMeta[]>(INDEX_KEY);
    return Array.isArray(index) ? [...index].sort((a, b) => b.updatedAt - a.updatedAt) : [];
  }

  loadProject(id: string): Project | null {
    const raw = this.read<unknown>(projectKey(id));
    return raw ? migrateProject(raw) : null;
  }

  saveProject(project: Project): void {
    this.write(projectKey(project.id), project);
    const meta: ProjectMeta = {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    const index = this.listProjects().filter((p) => p.id !== project.id);
    this.write(INDEX_KEY, [meta, ...index]);
  }

  renameProject(id: string, name: string): void {
    const project = this.loadProject(id);
    if (project) this.saveProject({ ...project, name, updatedAt: Date.now() });
  }

  deleteProject(id: string): void {
    try {
      localStorage.removeItem(projectKey(id));
    } catch {
      /* storage unavailable */
    }
    this.write(
      INDEX_KEY,
      this.listProjects().filter((p) => p.id !== id),
    );
    if (this.lastOpenId() === id) this.setLastOpenId(null);
  }

  /** True once this browser has been given the example projects. */
  examplesLoaded(): boolean {
    return this.read<boolean>(EXAMPLES_KEY) === true;
  }

  markExamplesLoaded(): void {
    this.write(EXAMPLES_KEY, true);
  }

  lastOpenId(): string | null {
    return this.read<string>(LAST_OPEN_KEY);
  }

  setLastOpenId(id: string | null): void {
    if (id === null) {
      try {
        localStorage.removeItem(LAST_OPEN_KEY);
      } catch {
        /* storage unavailable */
      }
    } else {
      this.write(LAST_OPEN_KEY, id);
    }
  }

  private read<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.error(`Failed to persist ${key}`, err);
    }
  }
}

/** Copies data saved under the pre-rename storage prefix, once. */
function migrateLegacyKeys(): void {
  try {
    if (localStorage.getItem(INDEX_KEY) !== null) return;
    const legacy: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(`${LEGACY_PREFIX}:`)) legacy.push(key);
    }
    for (const key of legacy) {
      localStorage.setItem(PREFIX + key.slice(LEGACY_PREFIX.length), localStorage.getItem(key)!);
      localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable */
  }
}

/**
 * Normalizes a stored project to the current schema. Add per-version upgrade steps
 * here as the model grows; missing fields are filled from defaults.
 *   v1 → v2: added camera, checkpoints, activeCheckpointId.
 *   v2 → v3: added section.unheated (patios, which require it, are unheated).
 *   v3 → v4: added floors (interior walls, doors, furniture, stories).
 *   v4 → v5: section edges became wall centerlines (walls used to sit inside them);
 *            interior walls and exterior doors move with the faces they were on.
 *   v5 → v6: added basements (a first floor below 0), floor.unexcavated,
 *            floor.groups and wall.divider.
 *   v6 → v7: added windows and skylights.
 */
export function migrateProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<Project>;
  if (!p.id || !p.rootId || !Array.isArray(p.sections)) return null;
  const checkpoints: Checkpoint[] = Array.isArray(p.checkpoints)
    ? p.checkpoints.map((c) => ({ ...c, snapshot: migrateSnapshot(c.snapshot, p.schemaVersion ?? 1) }))
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: p.id,
    name: p.name ?? 'Untitled',
    createdAt: p.createdAt ?? Date.now(),
    updatedAt: p.updatedAt ?? Date.now(),
    ...migrateSnapshot(p as DesignSnapshot, p.schemaVersion ?? 1),
    checkpoints,
    activeCheckpointId: checkpoints.some((c) => c.id === p.activeCheckpointId) ? p.activeCheckpointId! : null,
  };
}

function migrateSnapshot(s: Partial<DesignSnapshot>, version: number): DesignSnapshot {
  let floors = normalizeLevels(Array.isArray(s.floors) && s.floors.length > 0 ? s.floors.map(migrateFloor) : [createFloor()]);
  const settings = { ...DEFAULT_SETTINGS, ...s.settings };
  const sections = (s.sections ?? []).map(
      (sec: Section): Section => {
        const patio = { ...DEFAULT_PATIO, ...sec.patio };
        return {
          ...sec,
          roof: { ...DEFAULT_ROOF, ...sec.roof },
          unheated: (sec.unheated ?? false) || patio.enabled,
          patio,
        };
      },
    );
  if (version < 5) floors = floors.map((f) => toCenterlineWalls(f, sections, settings));
  return {
    rootId: s.rootId!,
    settings,
    camera: s.camera ?? null,
    floors,
    sections,
    windows: Array.isArray(s.windows) ? s.windows : [],
    skylights: Array.isArray(s.skylights) ? s.skylights : [],
  };
}

/** v4 floors were laid out inside walls that sat within the section edges. */
function toCenterlineWalls(floor: Floor, sections: Section[], settings: ProjectSettings): Floor {
  const lines = floorFootprint(sections, floor.elevation);
  const before = { faces: boundary(erode(lines, settings.wallThickness)), outer: boundary(lines) };
  return followOutline(floor, before, regionOf(sections, settings, floor));
}

function migrateFloor(f: Partial<Floor>): Floor {
  return {
    id: f.id ?? newId(),
    elevation: f.elevation ?? 0,
    nodes: f.nodes ?? [],
    walls: f.walls ?? [],
    doors: f.doors ?? [],
    items: f.items ?? [],
    openings: f.openings ?? [],
    unexcavated: f.unexcavated ?? [],
    roomNames: f.roomNames ?? [],
    groups: f.groups ?? [],
  };
}

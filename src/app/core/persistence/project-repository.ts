import { Injectable } from '@angular/core';
import { DEFAULT_PATIO, DEFAULT_ROOF, DEFAULT_SETTINGS, SCHEMA_VERSION } from '../model/defaults';
import { Checkpoint, DesignSnapshot, Project, ProjectMeta, Section } from '../model/types';

const PREFIX = 'home-designer';
/** Storage prefix used before the app was renamed; migrated once on startup. */
const LEGACY_PREFIX = 'shed-designer';
const INDEX_KEY = `${PREFIX}:index`;
const LAST_OPEN_KEY = `${PREFIX}:last-open`;
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
 */
export function migrateProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<Project>;
  if (!p.id || !p.rootId || !Array.isArray(p.sections)) return null;
  const checkpoints: Checkpoint[] = Array.isArray(p.checkpoints)
    ? p.checkpoints.map((c) => ({ ...c, snapshot: migrateSnapshot(c.snapshot) }))
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: p.id,
    name: p.name ?? 'Untitled',
    createdAt: p.createdAt ?? Date.now(),
    updatedAt: p.updatedAt ?? Date.now(),
    ...migrateSnapshot(p as DesignSnapshot),
    checkpoints,
    activeCheckpointId: checkpoints.some((c) => c.id === p.activeCheckpointId) ? p.activeCheckpointId! : null,
  };
}

function migrateSnapshot(s: Partial<DesignSnapshot>): DesignSnapshot {
  return {
    rootId: s.rootId!,
    settings: { ...DEFAULT_SETTINGS, ...s.settings },
    camera: s.camera ?? null,
    sections: (s.sections ?? []).map(
      (sec: Section): Section => {
        const patio = { ...DEFAULT_PATIO, ...sec.patio };
        return {
          ...sec,
          roof: { ...DEFAULT_ROOF, ...sec.roof },
          unheated: (sec.unheated ?? false) || patio.enabled,
          patio,
        };
      },
    ),
  };
}

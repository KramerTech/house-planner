import { computed, inject, Injectable, signal } from '@angular/core';
import { canDeleteSection, planSectionFromSegment, validateLayout } from '../geometry/constraints';
import { SideSegment } from '../geometry/edges';
import { resolveSideResize, SideRange, sideResizeRange, SideRef } from '../geometry/side-resize';
import { createProject, createSection, newId } from '../model/defaults';
import {
  CameraState,
  Checkpoint,
  DesignSnapshot,
  PatioSpec,
  Project,
  ProjectMeta,
  ProjectSettings,
  RoofSpec,
  Section,
} from '../model/types';
import { ProjectRepository } from '../persistence/project-repository';
import { decodeShareCode, encodeShareCode } from '../persistence/share-code';

const SAVE_DEBOUNCE_MS = 250;
const DEFAULT_PROJECT_NAME = 'My Home';

/** Identity of a design for change detection (camera excluded). */
function designKey(d: Pick<DesignSnapshot, 'rootId' | 'sections' | 'settings'>): string {
  return JSON.stringify([d.rootId, d.sections, d.settings]);
}

/**
 * Single source of truth for the open project. All mutations go through here; layout
 * mutations are validated against the layout invariants before being committed, and
 * every change is persisted (debounced) to localStorage.
 */
@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly repo = inject(ProjectRepository);

  private readonly _project = signal<Project>(this.loadInitialProject());
  private readonly _projects = signal<ProjectMeta[]>(this.repo.listProjects());
  private readonly _viewEpoch = signal(0);
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  readonly project = this._project.asReadonly();
  readonly projects = this._projects.asReadonly();
  readonly sections = computed(() => this._project().sections);
  readonly settings = computed(() => this._project().settings);
  readonly rootId = computed(() => this._project().rootId);
  readonly checkpoints = computed(() => this._project().checkpoints);
  readonly activeCheckpointId = computed(() => this._project().activeCheckpointId);

  /**
   * Incremented whenever the design is replaced wholesale (project opened, checkpoint
   * restored). Views use it to re-apply the saved camera / re-fit, rather than doing
   * so on every edit.
   */
  readonly viewEpoch = this._viewEpoch.asReadonly();

  /** True if the current design differs from the active checkpoint (or there is none). */
  readonly modifiedSinceCheckpoint = computed(() => {
    const p = this._project();
    const active = p.checkpoints.find((c) => c.id === p.activeCheckpointId);
    return !active || designKey(active.snapshot) !== designKey(p);
  });

  /** True if the current design isn't captured by any checkpoint. */
  readonly hasUncheckpointedChanges = computed(() => {
    const p = this._project();
    const key = designKey(p);
    return !p.checkpoints.some((c) => designKey(c.snapshot) === key);
  });

  constructor() {
    window.addEventListener('pagehide', () => this.flush());
  }

  // ---------------------------------------------------------------- projects

  openProject(id: string): void {
    if (id === this._project().id) return;
    const loaded = this.repo.loadProject(id);
    if (!loaded) return;
    this.flush();
    this._project.set(loaded);
    this.repo.setLastOpenId(id);
    this.bumpViewEpoch();
  }

  newProject(name: string): void {
    this.flush();
    const project = createProject(name.trim() || 'Untitled');
    this._project.set(project);
    this.repo.saveProject(project);
    this.repo.setLastOpenId(project.id);
    this.refreshIndex();
    this.bumpViewEpoch();
  }

  deleteProject(id: string): void {
    const isCurrent = id === this._project().id;
    if (isCurrent && this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.repo.deleteProject(id);
    this.refreshIndex();
    if (isCurrent) {
      const next = this._projects()[0];
      if (next) this.openProjectForce(next.id);
      else this.newProject(DEFAULT_PROJECT_NAME);
    }
  }

  renameProject(id: string, name: string): void {
    const clean = name.trim() || 'Untitled';
    if (id === this._project().id) {
      this.update((p) => ({ ...p, name: clean }));
      this.flush();
    } else {
      this.repo.renameProject(id, clean);
      this.refreshIndex();
    }
  }

  /** A compact share code for a saved project's current design (no checkpoints). */
  async shareCode(id: string): Promise<string> {
    if (id === this._project().id) this.flush();
    const p = id === this._project().id ? this._project() : this.repo.loadProject(id);
    if (!p) throw new Error('Project not found');
    return encodeShareCode({ name: p.name, ...snapshotOf(p) });
  }

  /** Creates and opens a new project from a share code. Throws with a readable message if invalid. */
  async importShareCode(code: string): Promise<void> {
    const design = await decodeShareCode(code);
    const { name, ...snapshot } = design;
    this.flush();
    const project: Project = { ...createProject(name), ...snapshot };
    this._project.set(project);
    this.repo.saveProject(project);
    this.repo.setLastOpenId(project.id);
    this.refreshIndex();
    this.bumpViewEpoch();
  }

  // ---------------------------------------------------------------- checkpoints

  /** Captures the current design and camera as a new checkpoint. */
  saveCheckpoint(name?: string): Checkpoint {
    const p = this._project();
    const checkpoint: Checkpoint = {
      id: newId(),
      name: name?.trim() || `Checkpoint ${p.checkpoints.length + 1}`,
      createdAt: Date.now(),
      snapshot: structuredClone(snapshotOf(p)),
    };
    this.update((proj) => ({
      ...proj,
      checkpoints: [...proj.checkpoints, checkpoint],
      activeCheckpointId: checkpoint.id,
    }));
    this.flush();
    return checkpoint;
  }

  /** Replaces the current design and camera with a checkpoint's. */
  restoreCheckpoint(id: string): boolean {
    const checkpoint = this._project().checkpoints.find((c) => c.id === id);
    if (!checkpoint) return false;
    const snap = structuredClone(checkpoint.snapshot);
    const violation = validateLayout(snap.sections, snap.rootId);
    if (violation) {
      console.warn(`Checkpoint ${id} has an invalid layout: ${violation}`);
      return false;
    }
    this.update((p) => ({ ...p, ...snap, activeCheckpointId: id }));
    this.flush();
    this.bumpViewEpoch();
    return true;
  }

  renameCheckpoint(id: string, name: string): void {
    this.update(
      (p) => ({
        ...p,
        checkpoints: p.checkpoints.map((c) => (c.id === id ? { ...c, name: name.trim() || c.name } : c)),
      }),
      false,
    );
  }

  deleteCheckpoint(id: string): void {
    this.update(
      (p) => ({
        ...p,
        checkpoints: p.checkpoints.filter((c) => c.id !== id),
        activeCheckpointId: p.activeCheckpointId === id ? null : p.activeCheckpointId,
      }),
      false,
    );
  }

  // ---------------------------------------------------------------- camera

  /** Records the 3D camera pose. Not a design change, so it doesn't touch `updatedAt`. */
  setCamera(camera: CameraState): void {
    this.update((p) => ({ ...p, camera }), false);
  }

  // ---------------------------------------------------------------- settings & specs

  updateSettings(patch: Partial<ProjectSettings>): void {
    this.update((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  }

  updateRoof(sectionId: string, patch: Partial<RoofSpec>): void {
    this.updateSection(sectionId, (s) => ({ ...s, roof: { ...s.roof, ...patch } }));
  }

  /** Marks a section unheated or heated. A heated section can't be a patio, so this also clears patio. */
  setUnheated(sectionId: string, unheated: boolean): void {
    this.updateSection(sectionId, (s) => ({
      ...s,
      unheated,
      patio: unheated ? s.patio : { ...s.patio, enabled: false },
    }));
  }

  /** Patio can only be enabled on an unheated section. */
  updatePatio(sectionId: string, patch: Partial<PatioSpec>): void {
    this.updateSection(sectionId, (s) => {
      const patio = { ...s.patio, ...patch };
      return { ...s, patio: { ...patio, enabled: patio.enabled && s.unheated } };
    });
  }

  // ---------------------------------------------------------------- layout

  /** Where `seed` can be dragged to, given the current layout. */
  sideRange(seed: SideRef): SideRange {
    const p = this._project();
    return sideResizeRange(p.sections, p.rootId, seed);
  }

  /**
   * Sets a dragged side to `v`, with any pushes/pulls of other sections computed from
   * `original` (the layout when the drag began), so secondary changes spring back.
   * Returns false (and changes nothing) if no valid layout exists for `v`.
   */
  resizeSide(original: readonly Section[], seed: SideRef, v: number): boolean {
    const layout = resolveSideResize(original, this._project().rootId, seed, v);
    return !!layout && this.commitLayout(layout);
  }

  /** Previews the section that would be created from a free segment, without adding it. */
  previewSectionFromSegment(seg: SideSegment) {
    const p = this._project();
    return planSectionFromSegment(p.sections, seg, p.settings.defaultSectionDepth);
  }

  /** Adds a section against a free segment. Returns the new section id, or null if there is no room. */
  addSectionFromSegment(seg: SideSegment): string | null {
    const p = this._project();
    const rect = this.previewSectionFromSegment(seg);
    const source = p.sections.find((s) => s.id === seg.sectionId);
    if (!rect || !source) return null;
    const { slopeDir, pitch, lowWallHeight } = source.roof;
    const section = createSection(rect, { slopeDir, pitch, lowWallHeight });
    return this.commitLayout([...p.sections, section]) ? section.id : null;
  }

  canDelete(sectionId: string): boolean {
    const p = this._project();
    return canDeleteSection(p.sections, p.rootId, sectionId);
  }

  deleteSection(sectionId: string): boolean {
    if (!this.canDelete(sectionId)) return false;
    return this.commitLayout(this._project().sections.filter((s) => s.id !== sectionId));
  }

  // ---------------------------------------------------------------- internals

  private commitLayout(sections: Section[]): boolean {
    const violation = validateLayout(sections, this._project().rootId);
    if (violation) {
      console.warn(`Rejected layout change: ${violation}`);
      return false;
    }
    this.update((p) => ({ ...p, sections }));
    return true;
  }

  private updateSection(id: string, fn: (s: Section) => Section): void {
    this.update((p) => ({ ...p, sections: p.sections.map((s) => (s.id === id ? fn(s) : s)) }));
  }

  private update(fn: (p: Project) => Project, touch = true): void {
    this._project.update((p) => (touch ? { ...fn(p), updatedAt: Date.now() } : fn(p)));
    this.scheduleSave();
  }

  private bumpViewEpoch(): void {
    this._viewEpoch.update((n) => n + 1);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  /** Writes any pending change immediately. */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.repo.saveProject(this._project());
    this.refreshIndex();
  }

  private openProjectForce(id: string): void {
    const loaded = this.repo.loadProject(id);
    if (!loaded) return this.newProject(DEFAULT_PROJECT_NAME);
    this._project.set(loaded);
    this.repo.setLastOpenId(id);
    this.bumpViewEpoch();
  }

  private refreshIndex(): void {
    this._projects.set(this.repo.listProjects());
  }

  private loadInitialProject(): Project {
    const lastId = this.repo.lastOpenId();
    const candidates = [lastId, ...this.repo.listProjects().map((p) => p.id)].filter(
      (id): id is string => !!id,
    );
    for (const id of candidates) {
      const p = this.repo.loadProject(id);
      if (p) {
        this.repo.setLastOpenId(p.id);
        return p;
      }
    }
    const fresh = createProject(DEFAULT_PROJECT_NAME);
    this.repo.saveProject(fresh);
    this.repo.setLastOpenId(fresh.id);
    return fresh;
  }
}

function snapshotOf(p: Project): DesignSnapshot {
  return { rootId: p.rootId, sections: p.sections, settings: p.settings, camera: p.camera };
}

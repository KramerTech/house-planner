import { computed, inject, Injectable, signal } from '@angular/core';
import { exteriorFaces, followWindows, syncRooflines } from '../floorplan/faces';
import { groundIndex, isBasement, nextFloorElevation, regionOf } from '../floorplan/floor-region';
import { shapeCenterU } from '../floorplan/windows';
import { followOutline } from '../floorplan/wall-graph';
import { canDeleteSection, planSectionFromSegment, validateLayout } from '../geometry/constraints';
import { SideSegment } from '../geometry/edges';
import { layoutStep } from '../geometry/rect';
import { resolveSideResize, SideRange, sideResizeRange, SideRef } from '../geometry/side-resize';
import { BASEMENT, createFloor, createProject, createSection, newId, STORY } from '../model/defaults';
import {
  CameraState,
  Checkpoint,
  DesignSnapshot,
  Floor,
  HouseWindow,
  PatioSpec,
  Project,
  ProjectMeta,
  ProjectSettings,
  RoofSpec,
  Section,
  Skylight,
} from '../model/types';
import { ProjectRepository } from '../persistence/project-repository';
import { decodeShareCode, encodeShareCode } from '../persistence/share-code';

const SAVE_DEBOUNCE_MS = 250;
/** Edits closer together than this (outside a gesture) undo as one step. */
const HISTORY_DEBOUNCE_MS = 400;
const HISTORY_LIMIT = 200;
const DEFAULT_PROJECT_NAME = 'My Home';

/** The parts of a project that undo/redo and checkpoints track (camera excluded). */
type DesignState = Pick<DesignSnapshot, 'rootId' | 'sections' | 'floors' | 'settings' | 'windows' | 'skylights'>;

/** Identity of a design for change detection (camera excluded). */
function designKey(d: DesignState): string {
  return JSON.stringify([d.rootId, d.sections, d.floors, d.settings, d.windows, d.skylights]);
}

const stateOf = (p: DesignState): DesignState => ({
  rootId: p.rootId,
  sections: p.sections,
  floors: p.floors,
  settings: p.settings,
  windows: p.windows,
  skylights: p.skylights,
});

const sameState = (a: DesignState, b: DesignState) =>
  a.rootId === b.rootId &&
  a.sections === b.sections &&
  a.floors === b.floors &&
  a.settings === b.settings &&
  a.windows === b.windows &&
  a.skylights === b.skylights;

/**
 * Single source of truth for the open project. All mutations go through here; layout
 * mutations are validated against the layout invariants before being committed, and
 * every change is persisted (debounced) to localStorage. Design changes are recorded
 * for undo/redo: everything between `beginGesture` and `endGesture` (a drag) is one
 * step, and other edits in quick succession coalesce.
 */
@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly repo = inject(ProjectRepository);

  private readonly _project = signal<Project>(this.loadInitialProject());
  private readonly _projects = signal<ProjectMeta[]>(this.repo.listProjects());
  private readonly _viewEpoch = signal(0);
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private undoStack: DesignState[] = [];
  private redoStack: DesignState[] = [];
  private readonly _historyVersion = signal(0);
  /** The design before the edits not yet recorded as an undo step. */
  private pendingBase: DesignState | null = null;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  private gestureDepth = 0;

  readonly project = this._project.asReadonly();
  readonly projects = this._projects.asReadonly();
  readonly sections = computed(() => this._project().sections);
  readonly floors = computed(() => this._project().floors);
  readonly windows = computed(() => this._project().windows);
  readonly skylights = computed(() => this._project().skylights);
  readonly settings = computed(() => this._project().settings);
  readonly rootId = computed(() => this._project().rootId);
  readonly checkpoints = computed(() => this._project().checkpoints);
  readonly activeCheckpointId = computed(() => this._project().activeCheckpointId);
  readonly canUndo = computed(() => (this._historyVersion(), this.undoStack.length > 0 || this.pendingBase !== null));
  readonly canRedo = computed(() => (this._historyVersion(), this.redoStack.length > 0));

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
    this.replaceProject(loaded);
    this.repo.setLastOpenId(id);
  }

  newProject(name: string): void {
    this.flush();
    const project = createProject(name.trim() || 'Untitled');
    this.replaceProject(project);
    this.repo.saveProject(project);
    this.repo.setLastOpenId(project.id);
    this.refreshIndex();
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
    this.replaceProject(project);
    this.repo.saveProject(project);
    this.repo.setLastOpenId(project.id);
    this.refreshIndex();
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
    this.update((p) => ({ ...p, ...snap, activeCheckpointId: id }), { follow: false });
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
      { touch: false },
    );
  }

  deleteCheckpoint(id: string): void {
    this.update(
      (p) => ({
        ...p,
        checkpoints: p.checkpoints.filter((c) => c.id !== id),
        activeCheckpointId: p.activeCheckpointId === id ? null : p.activeCheckpointId,
      }),
      { touch: false },
    );
  }

  // ---------------------------------------------------------------- undo / redo

  /** Marks the start of a continuous edit (a drag); it undoes as one step. */
  beginGesture(): void {
    this.gestureDepth++;
  }

  endGesture(): void {
    this.gestureDepth = Math.max(0, this.gestureDepth - 1);
    if (this.gestureDepth === 0) this.commitHistory();
  }

  undo(): void {
    this.commitHistory();
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(stateOf(this._project()));
    this.applyHistory(prev);
  }

  redo(): void {
    this.commitHistory();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(stateOf(this._project()));
    this.applyHistory(next);
  }

  // ---------------------------------------------------------------- camera

  /** Records the 3D camera pose. Not a design change, so it doesn't touch `updatedAt`. */
  setCamera(camera: CameraState): void {
    this.update((p) => ({ ...p, camera }), { touch: false });
  }

  // ---------------------------------------------------------------- settings & specs

  updateSettings(patch: Partial<ProjectSettings>): void {
    this.update((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  }

  updateRoof(sectionId: string, patch: Partial<RoofSpec>): void {
    this.updateSection(sectionId, (s) => ({ ...s, roof: { ...s.roof, ...patch } }));
  }

  /** Marks a section unheated or heated. Not exposed in the UI for now. */
  setUnheated(sectionId: string, unheated: boolean): void {
    this.updateSection(sectionId, (s) => ({ ...s, unheated }));
  }

  updatePatio(sectionId: string, patch: Partial<PatioSpec>): void {
    this.updateSection(sectionId, (s) => ({ ...s, patio: { ...s.patio, ...patch } }));
  }

  // ---------------------------------------------------------------- layout

  /** Drag snap step for section sides: half a wall thickness. */
  readonly layoutStep = computed(() => layoutStep(this.settings().wallThickness));

  /** Where `seed` can be dragged to, given the current layout. */
  sideRange(seed: SideRef): SideRange {
    const p = this._project();
    return sideResizeRange(p.sections, p.rootId, seed, this.layoutStep());
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

  // ---------------------------------------------------------------- floors

  /** Applies an edit to one floor's interior layout. */
  updateFloor(floorId: string, fn: (f: Floor) => Floor): void {
    this.update((p) => ({ ...p, floors: p.floors.map((f) => (f.id === floorId ? fn(f) : f)) }));
  }

  /** Elevation a new top floor would get, or null if the roof leaves no headroom for one. */
  readonly nextFloorElevation = computed(() => nextFloorElevation(this.sections(), this.floors()));

  /** Adds a floor on top. Returns its id, or null if there's no headroom for it. */
  addFloor(): string | null {
    const elevation = this.nextFloorElevation();
    if (elevation === null) return null;
    const floor = createFloor(elevation);
    this.update((p) => ({ ...p, floors: [...p.floors, floor] }));
    return floor.id;
  }

  /** Adds a basement under the ground floor, matching it. Returns its id, or null if there already is one. */
  addBasement(): string | null {
    if (this.floors().some(isBasement)) return null;
    const floor = createFloor(-BASEMENT.defaultDepth);
    this.update((p) => ({ ...p, floors: [floor, ...p.floors] }));
    return floor.id;
  }

  /** Deletes a basement or upper floor (never the ground floor). */
  deleteFloor(floorId: string): void {
    this.update((p) => {
      const g = groundIndex(p.floors);
      return { ...p, floors: p.floors.filter((f, i) => i === g || f.id !== floorId) };
    });
  }

  /**
   * Sets a floor's starting height. An upper floor stays at least a story above the
   * floor below, and floors above are pushed up as needed to keep a story between
   * each; a basement stays within its depth limits. The ground floor stays at 0.
   */
  setFloorElevation(floorId: string, elevation: number): void {
    this.update((p) => {
      const i = p.floors.findIndex((f) => f.id === floorId);
      const g = groundIndex(p.floors);
      if (i < 0 || i === g) return p;
      const floors = [...p.floors];
      if (i < g) {
        floors[i] = { ...floors[i], elevation: Math.min(-BASEMENT.minDepth, Math.max(-BASEMENT.maxDepth, elevation)) };
        return { ...p, floors };
      }
      floors[i] = { ...floors[i], elevation: Math.max(floors[i - 1].elevation + STORY.minHeight, elevation) };
      for (let j = i + 1; j < floors.length; j++) {
        const min = floors[j - 1].elevation + STORY.minHeight;
        if (floors[j].elevation < min) floors[j] = { ...floors[j], elevation: min };
      }
      return { ...p, floors };
    });
  }

  // ---------------------------------------------------------------- windows

  /** Applies an edit to the windows. */
  updateWindows(fn: (windows: HouseWindow[]) => HouseWindow[]): void {
    this.update((p) => ({ ...p, windows: fn(p.windows) }));
  }

  /** Applies an edit to the skylights. */
  updateSkylights(fn: (skylights: Skylight[]) => Skylight[]): void {
    this.update((p) => ({ ...p, skylights: fn(p.skylights) }));
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

  /**
   * Applies a change. `touch` marks it as a design edit (updatedAt, undo history);
   * `follow` carries interior walls along when the outline changes.
   */
  private update(fn: (p: Project) => Project, opts: { touch?: boolean; follow?: boolean } = {}): void {
    const { touch = true, follow = true } = opts;
    const before = this._project();
    let next = fn(before);
    if (next === before) return;
    if (follow && (next.sections !== before.sections || next.settings !== before.settings)) {
      const faces = exteriorFaces(next.sections, next.settings);
      const followed = followWindows(next.windows, exteriorFaces(before.sections, before.settings), faces, (w) => shapeCenterU(w.shape));
      const windows = syncRooflines(followed, faces);
      next = { ...next, floors: followFloors(before, next), windows };
    }
    if (touch) {
      next = { ...next, updatedAt: Date.now() };
      if (!sameState(before, next)) this.recordHistory(before);
    }
    this._project.set(next);
    this.scheduleSave();
  }

  private recordHistory(before: DesignState): void {
    if (!this.pendingBase) this.pendingBase = stateOf(before);
    if (this.redoStack.length) {
      this.redoStack = [];
      this._historyVersion.update((v) => v + 1);
    }
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    if (this.gestureDepth === 0) this.historyTimer = setTimeout(() => this.commitHistory(), HISTORY_DEBOUNCE_MS);
    this._historyVersion.update((v) => v + 1);
  }

  private commitHistory(): void {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    const base = this.pendingBase;
    this.pendingBase = null;
    if (base && designKey(base) !== designKey(this._project())) {
      this.undoStack.push(base);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }
    this._historyVersion.update((v) => v + 1);
  }

  private applyHistory(state: DesignState): void {
    this._project.update((p) => ({ ...p, ...state, updatedAt: Date.now() }));
    this.scheduleSave();
    this._historyVersion.update((v) => v + 1);
  }

  private clearHistory(): void {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.pendingBase = null;
    this.undoStack = [];
    this.redoStack = [];
    this._historyVersion.update((v) => v + 1);
  }

  private replaceProject(project: Project): void {
    this._project.set(project);
    this.clearHistory();
    this.bumpViewEpoch();
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
    this.replaceProject(loaded);
    this.repo.setLastOpenId(id);
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
  return {
    rootId: p.rootId,
    sections: p.sections,
    floors: p.floors,
    settings: p.settings,
    camera: p.camera,
    windows: p.windows,
    skylights: p.skylights,
  };
}

/** Carries every floor's interior walls and exterior doors along with an outline change. */
function followFloors(before: Project, after: Project): Floor[] {
  return after.floors.map((f) => {
    const old = regionOf(before.sections, before.settings, f);
    const now = regionOf(after.sections, after.settings, f);
    return followOutline(f, old, now);
  });
}

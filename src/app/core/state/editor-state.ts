import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { groundIndex } from '../floorplan/floor-region';
import { Floor } from '../model/types';
import { BuildView } from '../../render3d/build/building-model';
import { Viewport } from '../../editor/viewport';
import { ProjectStore } from './project-store';

export type EditorMode = 'exterior' | 'floorplan' | 'windows';

const MODE_KEY = 'home-designer:mode';

/**
 * UI state shared between the plan editors and the 3D view: which editor is open,
 * which floor is being laid out, and the plan camera (shared so switching tabs
 * keeps the same framing). Not part of the design, so not saved with it.
 */
@Injectable({ providedIn: 'root' })
export class EditorState {
  private readonly store = inject(ProjectStore);

  readonly mode = signal<EditorMode>(readMode());
  private readonly floorId = signal<string | null>(null);

  /** Windows mode: the wall face being edited (its key), 'roof' for skylights, or null for the default. */
  readonly windowFace = signal<string | 'roof' | null>(null);

  /** The plan editors' viewport; null until first fitted. */
  readonly planView = signal<Viewport | null>(null);

  /** Index of the ground floor in the store's floors (1 when there's a basement). */
  readonly groundIndex = computed(() => groundIndex(this.store.floors()));

  /** The floor being edited; falls back to the ground floor if the selected one is gone. */
  readonly activeFloor = computed<Floor>(() => {
    const floors = this.store.floors();
    return floors.find((f) => f.id === this.floorId()) ?? floors[this.groundIndex()];
  });
  readonly activeFloorIndex = computed(() => this.store.floors().indexOf(this.activeFloor()));
  /** The active floor relative to the ground floor: −1 for the basement, 0 ground, 1 the next up… */
  readonly activeLevel = computed(() => this.activeFloorIndex() - this.groundIndex());

  readonly buildView = computed<BuildView>(() => {
    const mode = this.mode();
    return mode === 'floorplan' ? { mode, floorId: this.activeFloor().id } : { mode };
  });

  constructor() {
    effect(() => {
      const mode = this.mode();
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        /* storage unavailable */
      }
    });
    // A different project starts on the ground floor.
    effect(() => {
      this.store.viewEpoch();
      this.floorId.set(null);
    });
  }

  selectFloor(id: string): void {
    this.floorId.set(id);
  }
}

function readMode(): EditorMode {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return mode === 'floorplan' || mode === 'windows' ? mode : 'exterior';
  } catch {
    return 'exterior';
  }
}

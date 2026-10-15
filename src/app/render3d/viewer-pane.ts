import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ButtonModule } from '@openng/optimus-ui/button';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { edgeAt, exteriorFaces, facePoint, faceView, pickFace } from '../core/floorplan/faces';
import { EditorState } from '../core/state/editor-state';
import { ProjectStore } from '../core/state/project-store';
import { buildBuildingModel } from './build/building-builder';
import { BuildingModel } from './build/building-model';
import { Viewer3D } from './three/viewer';

/** Minimum downward camera tilt in Floorplan mode. */
const FLOORPLAN_MIN_TILT_DEG = 58;

/** Right pane: hosts the 3D viewer and keeps it in sync with the project. */
@Component({
  selector: 'app-viewer-pane',
  imports: [ButtonModule, TooltipModule],
  template: `
    <div class="canvas-host" #host></div>
    <div class="overlay">
      <button
        type="button"
        class="compass"
        pTooltip="Reset to north"
        tooltipPosition="left"
        (click)="viewer?.resetToNorth()"
      >
        <svg viewBox="0 0 40 40" [style.transform]="'rotate(' + dialRotation() + 'deg)'">
          <circle cx="20" cy="20" r="18" />
          <path class="needle-n" d="M20 5 L24.5 20 L20 18 L15.5 20 Z" />
          <path class="needle-s" d="M20 35 L24.5 20 L20 22 L15.5 20 Z" />
        </svg>
      </button>
      @if (editor.mode() !== 'floorplan') {
      <p-button
        [icon]="roofVisible() ? 'pi pi-eye' : 'pi pi-eye-slash'"
        [rounded]="true"
        severity="secondary"
        size="small"
        [pTooltip]="roofVisible() ? 'Hide roof' : 'Show roof'"
        tooltipPosition="left"
        (onClick)="toggleRoof()"
      />
      }
      <p-button
        icon="pi pi-expand"
        [rounded]="true"
        severity="secondary"
        size="small"
        pTooltip="Fit view"
        tooltipPosition="left"
        (onClick)="viewer?.frameModel()"
      />
    </div>
    <div class="hint">Drag or middle-drag to orbit · Wheel to zoom · Shift+drag to pan</div>
  `,
  styles: `
    :host { position: relative; display: block; width: 100%; height: 100%; overflow: hidden; }
    .canvas-host { position: absolute; inset: 0; }
    .overlay { position: absolute; top: 12px; right: 12px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .compass {
      width: 40px; height: 40px; padding: 0; border: none; border-radius: 50%; cursor: pointer;
      background: transparent; display: block;
    }
    .compass svg { width: 100%; height: 100%; transition: transform 0.15s ease-out; }
    .compass circle { fill: rgb(255 255 255 / 0.85); stroke: #4b5560; stroke-width: 1.5; }
    .compass .needle-n { fill: #c0392b; }
    .compass .needle-s { fill: #9aa3ab; }
    .hint {
      position: absolute; left: 12px; bottom: 10px; font-size: 12px; color: #4b5560;
      background: rgb(255 255 255 / 0.7); padding: 2px 8px; border-radius: 4px; pointer-events: none;
    }
  `,
})
export class ViewerPane {
  private readonly store = inject(ProjectStore);
  protected readonly editor = inject(EditorState);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  protected viewer: Viewer3D | null = null;
  /**
   * Compass dial rotation in degrees. Unwrapped (not clamped to ±180) so the CSS
   * transition always turns the short way when the heading crosses due south.
   */
  protected readonly dialRotation = signal(0);
  protected readonly roofVisible = signal(true);
  private lastHeading: number | null = null;
  private appliedEpoch = -1;

  /**
   * Pure model derived from the design and what's being edited (Exterior, or one
   * floor in Floorplan mode); camera and metadata changes don't rebuild it.
   */
  private readonly model = computed(() =>
    buildBuildingModel(
      {
        sections: this.store.sections(),
        settings: this.store.settings(),
        floors: this.store.floors(),
        windows: this.store.windows(),
        skylights: this.store.skylights(),
      },
      this.editor.buildView(),
    ),
  );

  constructor() {
    afterNextRender(() => {
      this.viewer = new Viewer3D(this.host().nativeElement, {
        onCameraChange: (camera) => this.store.setCamera(camera),
        onHeadingChange: (degrees) => this.trackHeading(degrees),
      });
      this.viewer.setRoofVisible(this.roofVisible());
      this.trackHeading(this.viewer.getHeadingDegrees());
      this.sync(untracked(this.model), untracked(this.store.viewEpoch));
    });

    effect(() => {
      const model = this.model();
      const epoch = this.store.viewEpoch();
      if (this.viewer) untracked(() => this.sync(model, epoch));
    });

    // Entering Floorplan mode: look down into the rooms over the cut-off walls.
    effect(() => {
      if (this.editor.mode() === 'floorplan') untracked(() => this.viewer?.ensureLookingDown(FLOORPLAN_MIN_TILT_DEG));
    });

    // Windows mode: swing round to look at the wall being edited (or down at the roof).
    effect(() => {
      if (this.editor.mode() !== 'windows') return;
      const key = this.editor.windowFace();
      untracked(() => this.focusFace(key));
    });

    inject(DestroyRef).onDestroy(() => this.viewer?.dispose());
  }

  private focusFace(key: string | null): void {
    if (!this.viewer) return;
    if (key === 'roof') {
      this.viewer.ensureLookingDown(60);
      return;
    }
    const face = pickFace(exteriorFaces(this.store.sections(), this.store.settings()), key);
    if (!face) return;
    const u = (face.from + face.to) / 2;
    const p = facePoint(face.side, face.coord, u);
    const z = (edgeAt(face.bottom, u) + edgeAt(face.top, u)) / 2;
    const { normal } = faceView(face.side);
    this.viewer.lookAtFace([p.x, z, p.y], [normal.x, normal.y], face.to - face.from);
  }

  protected toggleRoof(): void {
    this.roofVisible.update((v) => !v);
    this.viewer?.setRoofVisible(this.roofVisible());
  }

  private trackHeading(degrees: number): void {
    if (this.lastHeading !== null) {
      const delta = ((degrees - this.lastHeading + 540) % 360) - 180;
      this.dialRotation.update((r) => r - delta);
    } else {
      this.dialRotation.set(-degrees);
    }
    this.lastHeading = degrees;
  }

  /**
   * Pushes the model to the viewer. When the design was replaced wholesale (new view
   * epoch), also restores the saved camera, or frames the model if there is none.
   */
  private sync(model: BuildingModel, epoch: number): void {
    const viewer = this.viewer!;
    viewer.setModel(model);
    if (epoch === this.appliedEpoch) return;
    this.appliedEpoch = epoch;
    const camera = this.store.project().camera;
    if (camera) viewer.setCamera(camera);
    else viewer.requestFrame();
  }
}

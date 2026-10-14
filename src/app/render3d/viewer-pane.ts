import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { ButtonModule } from '@openng/optimus-ui/button';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { ProjectStore } from '../core/state/project-store';
import { buildBuildingModel } from './build/building-builder';
import { BuildingModel } from './build/building-model';
import { Viewer3D } from './three/viewer';

/** Right pane: hosts the 3D viewer and keeps it in sync with the project. */
@Component({
  selector: 'app-viewer-pane',
  imports: [ButtonModule, TooltipModule],
  template: `
    <div class="canvas-host" #host></div>
    <div class="overlay">
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
    <div class="hint">Drag to orbit · Wheel to zoom · Shift+drag to pan</div>
  `,
  styles: `
    :host { position: relative; display: block; width: 100%; height: 100%; overflow: hidden; }
    .canvas-host { position: absolute; inset: 0; }
    .overlay { position: absolute; top: 12px; right: 12px; }
    .hint {
      position: absolute; left: 12px; bottom: 10px; font-size: 12px; color: #4b5560;
      background: rgb(255 255 255 / 0.7); padding: 2px 8px; border-radius: 4px; pointer-events: none;
    }
  `,
})
export class ViewerPane {
  private readonly store = inject(ProjectStore);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  protected viewer: Viewer3D | null = null;
  private appliedEpoch = -1;

  /** Pure model derived from the design; camera and metadata changes don't rebuild it. */
  private readonly model = computed(() =>
    buildBuildingModel({ sections: this.store.sections(), settings: this.store.settings() }),
  );

  constructor() {
    afterNextRender(() => {
      this.viewer = new Viewer3D(this.host().nativeElement, {
        onCameraChange: (camera) => this.store.setCamera(camera),
      });
      this.sync(untracked(this.model), untracked(this.store.viewEpoch));
    });

    effect(() => {
      const model = this.model();
      const epoch = this.store.viewEpoch();
      if (this.viewer) untracked(() => this.sync(model, epoch));
    });

    inject(DestroyRef).onDestroy(() => this.viewer?.dispose());
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

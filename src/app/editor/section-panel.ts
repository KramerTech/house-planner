import { Component, computed, inject, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from '@openng/optimus-ui/button';
import { SliderModule } from '@openng/optimus-ui/slider';
import { ToggleSwitchModule } from '@openng/optimus-ui/toggleswitch';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { highWallHeight } from '../core/geometry/roof';
import { PATIO_LIMITS, ROOF_LIMITS } from '../core/model/defaults';
import { formatFeet, formatPitch } from '../core/model/format';
import { Section, Side } from '../core/model/types';
import { ProjectStore } from '../core/state/project-store';
import { WallHeightSlider } from './wall-height-slider';

const NEXT_DIR: Record<Side, Side> = { N: 'E', E: 'S', S: 'W', W: 'N' };
const DIR_ROTATION: Record<Side, number> = { N: 0, E: 90, S: 180, W: 270 };
const DIR_NAME: Record<Side, string> = { N: 'north', E: 'east', S: 'south', W: 'west' };

/**
 * Roof definition UI shown at the center of each section: slope direction arrow,
 * pitch slider, linked low/high wall slider, patio toggle and post spacing, and
 * delete. (Heated/unheated is kept in the model but not offered here for now.)
 * In compact mode (section too small on screen) only the arrow and an expand
 * button are shown.
 */
@Component({
  selector: 'app-section-panel',
  imports: [NgTemplateOutlet, FormsModule, ButtonModule, SliderModule, ToggleSwitchModule, TooltipModule, WallHeightSlider],
  templateUrl: './section-panel.html',
  styleUrl: './section-panel.scss',
  host: {
    class: 'section-panel',
    '[class.compact]': 'compact()',
  },
})
export class SectionPanel {
  private readonly store = inject(ProjectStore);

  readonly section = input.required<Section>();
  readonly isRoot = input(false);
  readonly compact = input(false);
  readonly expand = output<void>();

  protected readonly roofLimits = ROOF_LIMITS;
  protected readonly patioLimits = PATIO_LIMITS;
  protected readonly formatFeet = formatFeet;
  protected readonly formatPitch = formatPitch;

  protected readonly arrowRotation = computed(() => DIR_ROTATION[this.section().roof.slopeDir]);
  protected readonly slopeLabel = computed(() => `Slopes down to the ${DIR_NAME[this.section().roof.slopeDir]} (click to rotate)`);
  protected readonly highWall = computed(() => highWallHeight(this.section()));
  protected readonly rise = computed(() => this.highWall() - this.section().roof.lowWallHeight);
  protected readonly canDelete = computed(() => {
    this.store.sections(); // re-evaluate when layout changes
    return this.store.canDelete(this.section().id);
  });

  protected rotateSlope(event: MouseEvent): void {
    const dir = this.section().roof.slopeDir;
    const next = event.shiftKey ? (Object.keys(NEXT_DIR) as Side[]).find((k) => NEXT_DIR[k] === dir)! : NEXT_DIR[dir];
    this.store.updateRoof(this.section().id, { slopeDir: next });
  }

  protected setPitch(pitch: number): void {
    this.store.updateRoof(this.section().id, { pitch });
  }

  protected setLowWall(lowWallHeight: number): void {
    this.store.updateRoof(this.section().id, { lowWallHeight });
  }

  protected setPatio(enabled: boolean): void {
    this.store.updatePatio(this.section().id, { enabled });
  }

  protected setPostSpacing(postSpacing: number): void {
    this.store.updatePatio(this.section().id, { postSpacing });
  }

  protected remove(): void {
    this.store.deleteSection(this.section().id);
  }
}

import { Component, computed, ElementRef, inject, signal } from '@angular/core';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { groundIndex, isBasement } from '../core/floorplan/floor-region';
import { BASEMENT, STORY } from '../core/model/defaults';
import { formatFeet } from '../core/model/format';
import { Floor } from '../core/model/types';
import { EditorState } from '../core/state/editor-state';
import { ProjectStore } from '../core/state/project-store';

/**
 * Elevator-style floor buttons: one per story (top floor at the top), "+" to add a
 * story on top and "−" to dig a basement under the ground floor. Clicking the
 * active floor opens its settings (starting height or depth, delete).
 */
@Component({
  selector: 'app-floor-stack',
  imports: [TooltipModule],
  template: `
    <button
      type="button"
      class="add"
      [disabled]="store.nextFloorElevation() === null"
      [pTooltip]="addTip()"
      tooltipPosition="right"
      (click)="add()"
      aria-label="Add story"
    >
      <i class="pi pi-plus"></i>
    </button>
    @for (f of floorsTopDown(); track f.floor.id) {
      <button
        type="button"
        class="floor"
        [class.basement]="f.level < 0"
        [class.active]="f.floor.id === editor.activeFloor().id"
        [pTooltip]="f.label + (f.level < 0 ? ' · ' + feet(-f.floor.elevation) + ' deep' : ' · starts at ' + feet(f.floor.elevation))"
        tooltipPosition="right"
        (click)="choose(f.floor)"
      >
        {{ f.number }}
      </button>
    }
    @if (!hasBasement()) {
      <button type="button" class="add dig" pTooltip="Add a basement under the ground floor" tooltipPosition="right" (click)="addBasement()" aria-label="Add basement">
        <i class="pi pi-minus"></i>
      </button>
    }
    @if (editing(); as e) {
      <div class="pop" (pointerdown)="$event.stopPropagation()">
        <div class="title">{{ e.label }}</div>
        @if (e.level === 0) {
          <div class="note">The ground floor starts at 0′.</div>
        } @else if (e.level < 0) {
          <div class="row">
            <span>Ceiling</span>
            <button type="button" class="step" (click)="nudge(e.floor, 0.5)" [disabled]="-e.floor.elevation <= basement.minDepth" aria-label="Lower ceiling">−</button>
            <b>{{ feet(-e.floor.elevation - deck) }}</b>
            <button type="button" class="step" (click)="nudge(e.floor, -0.5)" [disabled]="-e.floor.elevation >= basement.maxDepth" aria-label="Raise ceiling">+</button>
          </div>
          <div class="note">
            Floor {{ feet(-e.floor.elevation) }} below the ground floor, under its {{ feet(deck) }} deck. Use <b>Not dug out</b> for parts left
            on a slab.
          </div>
          <button type="button" class="delete" (click)="remove(e.floor)"><i class="pi pi-trash"></i> Delete basement</button>
        } @else {
          <div class="row">
            <span>Starts at</span>
            <button type="button" class="step" (click)="nudge(e.floor, -0.5)" [disabled]="e.floor.elevation <= e.min" aria-label="Lower">−</button>
            <b>{{ feet(e.floor.elevation) }}</b>
            <button type="button" class="step" (click)="nudge(e.floor, 0.5)" aria-label="Raise">+</button>
          </div>
          <div class="note">At least {{ feet(minHeight) }} above the floor below ({{ feet(e.min) }}).</div>
          <button type="button" class="delete" (click)="remove(e.floor)"><i class="pi pi-trash"></i> Delete this floor</button>
        }
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 22px;
      background: rgb(255 255 255 / 0.94); box-shadow: 0 1px 4px rgb(0 0 0 / 0.18); }
    button.floor, button.add {
      width: 32px; height: 32px; border-radius: 50%; border: 1.5px solid #9aa4ad; background: #fff; cursor: pointer;
      font: inherit; font-weight: 700; font-size: 14px; color: #3b4a57; display: grid; place-items: center; padding: 0;
    }
    button.floor:hover { border-color: #b45309; color: #b45309; }
    button.floor.basement { background: #f1ede6; }
    button.floor.active { background: #b45309; border-color: #b45309; color: #fff; box-shadow: 0 0 0 3px rgb(180 83 9 / 0.2); }
    button.add { border-style: dashed; color: #5b6670; font-size: 12px; }
    button.add:hover:not(:disabled) { border-color: #16a34a; color: #16a34a; }
    button.add.dig:hover { border-color: #92633a; color: #92633a; }
    button.add:disabled { opacity: 0.4; cursor: not-allowed; }
    .pop {
      position: absolute; left: calc(100% + 10px); top: 0; width: 230px; padding: 10px 12px; border-radius: 8px;
      background: #fff; box-shadow: 0 6px 24px rgb(0 0 0 / 0.2); font-size: 13px; color: #1f2933; z-index: 30;
    }
    .title { font-weight: 700; margin-bottom: 8px; }
    .row { display: flex; align-items: center; gap: 8px; }
    .row span { flex: 1; color: #51606c; }
    .row b { min-width: 46px; text-align: center; font-variant-numeric: tabular-nums; }
    .step { width: 26px; height: 26px; border-radius: 6px; border: 1px solid #d5dade; background: #fff; cursor: pointer; font-size: 15px; }
    .step:disabled { opacity: 0.4; cursor: default; }
    .note { font-size: 11px; color: #7a858f; margin-top: 6px; }
    .note b { color: #51606c; }
    .delete { margin-top: 10px; width: 100%; padding: 6px; border: 1px solid #f3c4c4; border-radius: 6px; background: #fff;
      color: #b91c1c; cursor: pointer; font: inherit; font-size: 12px; display: flex; gap: 6px; justify-content: center; align-items: center; }
    .delete:hover { background: #fef2f2; }
  `,
  host: { '(document:pointerdown)': 'onDocPointer($event)' },
})
export class FloorStack {
  protected readonly store = inject(ProjectStore);
  protected readonly editor = inject(EditorState);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly minHeight = STORY.minHeight;
  protected readonly deck = STORY.deckThickness;
  protected readonly basement = BASEMENT;
  protected readonly feet = formatFeet;

  private readonly editingId = signal<string | null>(null);

  protected readonly hasBasement = computed(() => this.store.floors().some(isBasement));

  protected readonly floorsTopDown = computed(() => {
    const floors = this.store.floors();
    const g = groundIndex(floors);
    return floors.map((floor, i) => ({ floor, level: i - g, number: floorNumber(i - g), label: floorLabel(i - g) })).reverse();
  });

  protected readonly editing = computed(() => {
    const floors = this.store.floors();
    const index = floors.findIndex((f) => f.id === this.editingId());
    if (index < 0) return null;
    const level = index - groundIndex(floors);
    return {
      floor: floors[index],
      level,
      label: floorLabel(level),
      min: level > 0 ? floors[index - 1].elevation + STORY.minHeight : 0,
    };
  });

  protected readonly addTip = computed(() => {
    const e = this.store.nextFloorElevation();
    return e === null
      ? `No room for another story: the roof needs ${formatFeet(STORY.minHeadroom)} of headroom above it. Raise the walls in Footprint / Rooflines.`
      : `Add a story (starts at ${formatFeet(e)})`;
  });

  protected choose(f: Floor): void {
    if (this.editor.activeFloor().id === f.id) this.editingId.set(this.editingId() === f.id ? null : f.id);
    else {
      this.editor.selectFloor(f.id);
      this.editingId.set(null);
    }
  }

  protected add(): void {
    const id = this.store.addFloor();
    if (id) this.editor.selectFloor(id);
  }

  protected addBasement(): void {
    const id = this.store.addBasement();
    if (id) this.editor.selectFloor(id);
  }

  protected nudge(f: Floor, by: number): void {
    this.store.setFloorElevation(f.id, f.elevation + by);
  }

  /** Deletes a floor and moves to the one next to it toward the ground floor. */
  protected remove(f: Floor): void {
    const floors = this.store.floors();
    const i = floors.indexOf(f);
    const toward = floors[i < groundIndex(floors) ? i + 1 : i - 1];
    this.store.deleteFloor(f.id);
    this.editingId.set(null);
    if (toward) this.editor.selectFloor(toward.id);
  }

  protected onDocPointer(e: PointerEvent): void {
    if (this.editingId() && !this.host.nativeElement.contains(e.target as Node)) this.editingId.set(null);
  }
}

/** A floor's name by level: −1 the basement, 0 the ground floor, 1 the floor above it… */
export function floorLabel(level: number): string {
  return level < 0 ? 'Basement' : level === 0 ? 'Ground floor' : `Floor ${level + 1}`;
}

/** The short label on a floor's button. */
export function floorNumber(level: number): string {
  return level < 0 ? 'B' : `${level + 1}`;
}

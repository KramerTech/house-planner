import { Component, computed, input, output } from '@angular/core';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { DOOR_KINDS, doorWidths, GARAGE_DOOR_HEIGHTS } from '../core/floorplan/doors';
import { formatFeet } from '../core/model/format';
import { DoorKind } from '../core/model/types';

/** Small 16×16 plan-style icons for each kind of door. */
const KIND_ICONS: Record<DoorKind, string> = {
  single: 'M1 14.5 H15 M2.5 14.5 V2.5 M2.5 2.5 A12 12 0 0 1 14.5 14.5',
  double: 'M1 14.5 H15 M2 14.5 V8.5 M14 14.5 V8.5 M2 8.5 A6 6 0 0 1 8 14.5 M14 8.5 A6 6 0 0 0 8 14.5',
  pocket: 'M1 8 H4 M12 8 H15 M4 6 V10 M4 8 H8 M12 6.8 H15.5 M12 9.2 H15.5',
  barn: 'M1 6.5 H15 M3 8 H13 V10.5 H3 Z M1 12.5 H5 M11 12.5 H15',
  opening: 'M1 8 H5 M11 8 H15 M5 5 V11 M11 5 V11',
  garage: 'M2 14 V5.5 L8 2 L14 5.5 V14 M4.5 14 V7.5 H11.5 V14 M4.5 9.7 H11.5 M4.5 11.9 H11.5',
};

/** Door kind buttons and a width picker, for the Door tool and a selected door. */
@Component({
  selector: 'app-door-options',
  imports: [TooltipModule],
  template: `
    @for (k of kinds; track k.kind) {
      <button type="button" [class.active]="kind() === k.kind" (click)="kindChange.emit(k.kind)" [pTooltip]="k.label" tooltipPosition="bottom">
        <svg viewBox="0 0 16 16"><path [attr.d]="icons[k.kind]" /></svg>
      </button>
    }
    <select [value]="width()" (change)="pick($event)" aria-label="Door width" title="Width">
      @for (w of widths(); track w) {
        <option [value]="w" [selected]="Math.abs(w - width()) < 1e-6">{{ size(w) }}</option>
      }
    </select>
    @if (kind() === 'garage') {
      <select (change)="pickHeight($event)" aria-label="Door height" title="Height">
        @for (h of heights; track h) {
          <option [value]="h" [selected]="h === height()">{{ feet(h) }} high</option>
        }
      </select>
    }
  `,
  styles: `
    :host { display: flex; align-items: center; gap: 2px; }
    button { display: grid; place-items: center; border: none; border-radius: 6px; background: none; cursor: pointer; padding: 6px 7px; color: #3b4a57; }
    button:hover { background: #f1f3f4; }
    button.active { background: #fdf0e1; color: #b45309; }
    svg { width: 16px; height: 16px; }
    path { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
    select { font: inherit; font-size: 12px; padding: 4px; border: 1px solid #d5dade; border-radius: 6px; margin: 0 4px; }
  `,
})
export class DoorOptions {
  readonly kind = input.required<DoorKind>();
  readonly width = input.required<number>();
  /** Garage doors' height. */
  readonly height = input<number>(GARAGE_DOOR_HEIGHTS[0]);
  readonly kindChange = output<DoorKind>();
  readonly widthChange = output<number>();
  readonly heightChange = output<number>();
  protected readonly heights = GARAGE_DOOR_HEIGHTS;

  protected readonly kinds = DOOR_KINDS;
  /** The widths for this kind of door, plus the door's own if it's an older, unlisted size. */
  protected readonly widths = computed(() => {
    const list = doorWidths(this.kind());
    const w = this.width();
    return list.some((x) => Math.abs(x - w) < 1e-6) ? list : [...list, w].sort((a, b) => a - b);
  });
  protected readonly Math = Math;
  protected readonly icons = KIND_ICONS;
  protected readonly feet = formatFeet;

  /** A width as doors are sold: inches (32″), except garage doors, in feet (16′). */
  protected size(w: number): string {
    return this.kind() === 'garage' ? formatFeet(w) : `${Math.round(w * 12 * 10) / 10}″`;
  }

  /** Emits the new width and hands the keyboard back to the editor's shortcuts. */
  protected pick(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.widthChange.emit(+select.value);
    select.blur();
  }

  protected pickHeight(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.heightChange.emit(+select.value);
    select.blur();
  }
}

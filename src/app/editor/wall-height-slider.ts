import { Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';

type Handle = 'low' | 'high';

/** Rounds away floating-point noise from subtracting a fractional rise. */
const tidy = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Two-handle slider for a shed roof's low and high wall heights. The handles are
 * locked a fixed distance apart (the roof's rise), so they always move together.
 * The handle you grab snaps to whole feet and the other follows: drag low and the
 * low wall is an integer; drag high and the high wall is an integer.
 * Emits only the resulting low wall height, which is what the model stores.
 */
@Component({
  selector: 'app-wall-height-slider',
  template: `
    <div class="track" #track (pointerdown)="onTrackDown($event)">
      <div class="range" [style.left.%]="pct(low())" [style.width.%]="pct(high()) - pct(low())"></div>
      @for (h of handles; track h) {
        <span
          class="handle"
          [class.high]="h === 'high'"
          [class.active]="dragging() === h"
          [style.left.%]="pct(h === 'low' ? low() : high())"
          role="slider"
          tabindex="0"
          [attr.aria-label]="h === 'low' ? 'Low wall height' : 'High wall height'"
          [attr.aria-valuenow]="h === 'low' ? low() : high()"
          [attr.aria-valuemin]="h === 'low' ? lowBounds().min : highBounds().min"
          [attr.aria-valuemax]="h === 'low' ? lowBounds().max : highBounds().max"
          (pointerdown)="onHandleDown($event, h)"
          (keydown)="onKey($event, h)"
        ></span>
      }
    </div>
  `,
  styles: `
    :host { display: block; padding: 8px 8px 6px; touch-action: none; }
    .track {
      position: relative; height: 3px; border-radius: 3px; cursor: pointer;
      background: var(--p-slider-track-background, #e2e8f0);
    }
    .range {
      position: absolute; top: 0; bottom: 0; border-radius: 3px;
      background: var(--p-slider-range-background, var(--p-primary-color, #10b981));
    }
    .handle {
      position: absolute; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px;
      border-radius: 50%; background: #fff; cursor: grab; outline: none;
      border: 2px solid var(--p-primary-color, #10b981);
      box-shadow: 0 0.5px 0 0 rgb(0 0 0 / 0.08), 0 1px 1px 0 rgb(0 0 0 / 0.14);
    }
    .handle.high { z-index: 1; }
    .handle.active { cursor: grabbing; z-index: 2; }
    .handle:focus-visible { box-shadow: 0 0 0 3px rgb(16 185 129 / 0.3); }
  `,
})
export class WallHeightSlider {
  /** Current low wall height (ft). */
  readonly low = input.required<number>();
  /** Height difference between high and low walls (ft). */
  readonly rise = input.required<number>();
  /** Allowed range for the low wall (ft). */
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  readonly lowChange = output<number>();

  protected readonly handles: Handle[] = ['low', 'high'];
  protected readonly dragging = signal<Handle | null>(null);
  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');

  protected readonly high = computed(() => tidy(this.low() + this.rise()));
  /** Scale spans every position either handle can take. */
  private readonly scale = computed(() => ({ lo: this.min(), hi: this.max() + this.rise() }));
  protected readonly lowBounds = computed(() => ({ min: Math.ceil(this.min()), max: Math.floor(this.max()) }));
  protected readonly highBounds = computed(() => ({
    min: Math.ceil(this.min() + this.rise() - 1e-9),
    max: Math.floor(this.max() + this.rise() + 1e-9),
  }));

  protected pct(v: number): number {
    const { lo, hi } = this.scale();
    return hi > lo ? ((v - lo) / (hi - lo)) * 100 : 0;
  }

  protected onHandleDown(e: PointerEvent, h: Handle): void {
    e.stopPropagation();
    e.preventDefault();
    this.startDrag(e, h);
  }

  /** Clicking the bare track grabs the nearer handle and jumps it there. */
  protected onTrackDown(e: PointerEvent): void {
    e.preventDefault();
    const v = this.valueAt(e.clientX);
    const h: Handle = Math.abs(v - this.low()) <= Math.abs(v - this.high()) ? 'low' : 'high';
    this.startDrag(e, h);
    this.setFrom(h, v);
  }

  protected onKey(e: KeyboardEvent, h: Handle): void {
    const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const cur = h === 'low' ? this.low() : this.high();
    this.setFrom(h, delta > 0 ? Math.floor(cur + 1e-9) + 1 : Math.ceil(cur - 1e-9) - 1);
  }

  private startDrag(e: PointerEvent, h: Handle): void {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    this.dragging.set(h);
    const move = (ev: PointerEvent) => this.setFrom(h, this.valueAt(ev.clientX));
    const end = () => {
      this.dragging.set(null);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  private valueAt(clientX: number): number {
    const r = this.track().nativeElement.getBoundingClientRect();
    const { lo, hi } = this.scale();
    const frac = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return lo + Math.min(1, Math.max(0, frac)) * (hi - lo);
  }

  /** Snaps the grabbed handle to a whole foot within its bounds and emits the resulting low height. */
  private setFrom(h: Handle, raw: number): void {
    const b = h === 'low' ? this.lowBounds() : this.highBounds();
    const snapped = Math.min(b.max, Math.max(b.min, Math.round(raw)));
    const low = h === 'low' ? snapped : tidy(snapped - this.rise());
    if (low !== this.low()) this.lowChange.emit(low);
  }
}

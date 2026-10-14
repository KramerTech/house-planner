import { Component, ElementRef, inject, signal } from '@angular/core';

const STORAGE_KEY = 'home-designer:split';
const MIN_FRACTION = 0.2;

/** Two side-by-side panes with a draggable gutter; projects [left] and [right] content. */
@Component({
  selector: 'app-split-pane',
  template: `
    <div class="pane" [style.flex-basis.%]="fraction() * 100"><ng-content select="[left]" /></div>
    <div
      class="gutter"
      role="separator"
      aria-orientation="vertical"
      (pointerdown)="start($event)"
      (pointermove)="move($event)"
      (pointerup)="end($event)"
      (pointercancel)="end($event)"
    ></div>
    <div class="pane grow"><ng-content select="[right]" /></div>
  `,
  styles: `
    :host { display: flex; min-height: 0; min-width: 0; }
    .pane { position: relative; min-width: 0; overflow: hidden; flex-shrink: 0; }
    .pane.grow { flex: 1 1 0; }
    .gutter {
      flex: 0 0 6px; cursor: col-resize; background: #e2e5e8; touch-action: none;
      transition: background 120ms;
    }
    .gutter:hover, .gutter.active { background: #f59e0b; }
  `,
})
export class SplitPane {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly fraction = signal(readFraction());
  private dragging = false;

  protected start(e: PointerEvent): void {
    this.dragging = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  protected move(e: PointerEvent): void {
    if (!this.dragging) return;
    const r = this.host.nativeElement.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    this.fraction.set(Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, f)));
  }

  protected end(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    try {
      localStorage.setItem(STORAGE_KEY, String(this.fraction()));
    } catch {
      /* storage unavailable */
    }
  }
}

function readFraction(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    if (v >= MIN_FRACTION && v <= 1 - MIN_FRACTION) return v;
  } catch {
    /* storage unavailable */
  }
  return 0.5;
}

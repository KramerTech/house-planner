import { Component, computed, output, signal } from '@angular/core';
import { CATALOG, CatalogItem, CATEGORIES, CategoryId } from '../core/floorplan/catalog';
import { formatFeet } from '../core/model/format';
import { ItemSymbol } from './item-symbol';

/** Plan fill tint per category, so rooms read at a glance. */
export const CATEGORY_TINT: Record<CategoryId, string> = {
  bedroom: '#dbe5f2',
  bath: '#ddeef1',
  kitchen: '#ebe6dc',
  living: '#eee5d9',
  dining: '#efe3d2',
  laundry: '#e5e8ef',
  office: '#e9e1d6',
  other: '#e7e0d4',
};

/** A pointer press on a catalog tile: the start of a drag (or a click) to place it. */
export interface CatalogPick {
  item: CatalogItem;
  event: PointerEvent;
}

/**
 * Collapsible side panel (left of the plan) listing the furniture & fixtures catalog by category.
 * Press a tile and drag it onto the plan, or click it and then click the plan.
 */
@Component({
  selector: 'app-furniture-panel',
  imports: [ItemSymbol],
  template: `
    <button type="button" class="toggle" (click)="open.set(!open())" [attr.aria-expanded]="open()">
      <i class="pi pi-box"></i>
      @if (open()) {
        <span>Furniture & fixtures</span>
        <i class="pi pi-angle-left end"></i>
      }
    </button>
    @if (open()) {
      <input class="search" type="search" placeholder="Search…" [value]="query()" (input)="query.set($any($event.target).value)" />
      <div class="list">
        @for (group of groups(); track group.id) {
          <div class="cat">{{ group.label }}</div>
          <div class="grid">
            @for (item of group.items; track item.id) {
              <div class="tile" [title]="item.name" (pointerdown)="press($event, item)">
                <svg [attr.viewBox]="viewBox(item)">
                  <g [appItemSymbol]="item.symbol" [style.--tint]="tint(item)" />
                </svg>
                <span class="name">{{ item.name }}</span>
                <span class="dims">{{ dims(item) }}</span>
              </div>
            }
          </div>
        }
        @if (groups().length === 0) {
          <div class="empty">Nothing matches “{{ query() }}”</div>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: flex; flex-direction: column; background: rgb(255 255 255 / 0.97); border-right: 1px solid #dfe3e6;
      box-shadow: 2px 0 8px rgb(0 0 0 / 0.06); min-height: 0; position: relative; z-index: 1;
    }
    :host(.open) { width: 232px; }
    .toggle {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: none; background: none; cursor: pointer;
      font: inherit; font-size: 13px; font-weight: 600; color: #3b4a57; border-bottom: 1px solid #eef0f2;
    }
    .toggle:hover { background: #f4f6f7; }
    .toggle .end { margin-left: auto; }
    .search { margin: 8px 10px 4px; padding: 6px 8px; border: 1px solid #d5dade; border-radius: 6px; font: inherit; font-size: 12px; }
    .list { overflow-y: auto; padding: 0 10px 12px; flex: 1; }
    .cat { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #7a858f; margin: 12px 2px 6px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .tile {
      display: flex; flex-direction: column; align-items: center; padding: 6px 4px 5px; border: 1px solid #e3e7ea;
      border-radius: 6px; cursor: grab; user-select: none; touch-action: none; background: #fff;
    }
    .tile:hover { border-color: #b45309; background: #fffaf3; }
    .tile svg { width: 64px; height: 52px; overflow: visible; }
    .name { font-size: 11px; color: #1f2933; text-align: center; line-height: 1.2; margin-top: 3px; }
    .dims { font-size: 10px; color: #7a858f; font-variant-numeric: tabular-nums; }
    .empty { font-size: 12px; color: #7a858f; padding: 12px 2px; }
  `,
  host: { '[class.open]': 'open()' },
})
export class FurniturePanel {
  readonly pick = output<CatalogPick>();
  protected readonly open = signal(true);
  protected readonly query = signal('');

  protected readonly groups = computed(() => {
    const q = this.query().trim().toLowerCase();
    return CATEGORIES.map((c) => ({
      ...c,
      items: CATALOG.filter((i) => i.category === c.id && (!q || i.name.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))),
    })).filter((g) => g.items.length > 0);
  });

  protected press(event: PointerEvent, item: CatalogItem): void {
    if (event.button !== 0) return;
    event.preventDefault();
    // preventDefault keeps focus where it was; leave the search box so the plan's keys (R, G, Del) work.
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    this.pick.emit({ item, event });
  }

  protected viewBox(item: CatalogItem): string {
    const pad = Math.max(item.w, item.d) * 0.06;
    return `${-item.w / 2 - pad} ${-item.d / 2 - pad} ${item.w + 2 * pad} ${item.d + 2 * pad}`;
  }

  protected tint(item: CatalogItem): string {
    return CATEGORY_TINT[item.category];
  }

  protected dims(item: CatalogItem): string {
    return `${formatFeet(item.w)} × ${formatFeet(item.d)}`;
  }
}

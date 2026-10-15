import { Component, inject } from '@angular/core';
import { EditorMode, EditorState } from '../core/state/editor-state';
import { PlanView } from '../editor/plan-view';
import { FloorplanView } from '../floorplan/floorplan-view';
import { WindowsView } from '../windows/windows-view';

/** Left pane: Footprint / Rooflines, Floorplan and Windows tabs over the matching editor. */
@Component({
  selector: 'app-left-pane',
  imports: [PlanView, FloorplanView, WindowsView],
  template: `
    <div class="tabs" role="tablist">
      @for (t of tabs; track t.mode) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="editor.mode() === t.mode"
          [class.active]="editor.mode() === t.mode"
          (click)="editor.mode.set(t.mode)"
        >
          <i [class]="t.icon"></i> {{ t.label }}
        </button>
      }
    </div>
    <div class="body">
      @switch (editor.mode()) {
        @case ('exterior') {
          <app-plan-view />
        }
        @case ('floorplan') {
          <app-floorplan-view />
        }
        @case ('windows') {
          <app-windows-view />
        }
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; width: 100%; height: 100%; }
    .tabs { display: flex; gap: 2px; padding: 6px 8px 0; background: #eef0ee; border-bottom: 1px solid #d9ddd8; flex: none; }
    .tabs button {
      display: flex; align-items: center; gap: 6px; padding: 7px 16px; border: 1px solid transparent; border-bottom: none;
      border-radius: 6px 6px 0 0; background: transparent; font: inherit; font-size: 13px; font-weight: 600;
      color: #5b6670; cursor: pointer; margin-bottom: -1px;
    }
    .tabs button:hover { color: #1f2933; background: rgb(255 255 255 / 0.5); }
    .tabs button.active { background: #f7f8f6; border-color: #d9ddd8; color: #b45309; }
    .body { position: relative; flex: 1; min-height: 0; }
  `,
})
export class LeftPane {
  protected readonly editor = inject(EditorState);
  protected readonly tabs: { mode: EditorMode; label: string; icon: string }[] = [
    { mode: 'exterior', label: 'Footprint / Rooflines', icon: 'pi pi-home' },
    { mode: 'floorplan', label: 'Floorplan', icon: 'pi pi-objects-column' },
    { mode: 'windows', label: 'Windows', icon: 'pi pi-th-large' },
  ];
}

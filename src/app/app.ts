import { Component, inject } from '@angular/core';
import { ProjectStore } from './core/state/project-store';
import { ViewerPane } from './render3d/viewer-pane';
import { LeftPane } from './shell/left-pane';
import { isTyping } from './shell/keys';
import { SplitPane } from './shell/split-pane';
import { TopBar } from './shell/top-bar';

@Component({
  selector: 'app-root',
  imports: [TopBar, SplitPane, LeftPane, ViewerPane],
  template: `
    <app-top-bar />
    <app-split-pane class="panes">
      <app-left-pane left />
      <app-viewer-pane right />
    </app-split-pane>
  `,
  styleUrl: './app.scss',
  host: { '(window:keydown)': 'onKey($event)' },
})
export class App {
  private readonly store = inject(ProjectStore);

  /** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes — except while typing. */
  protected onKey(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || isTyping(e)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) this.store.undo();
    else if ((key === 'z' && e.shiftKey) || key === 'y') this.store.redo();
    else return;
    e.preventDefault();
  }
}

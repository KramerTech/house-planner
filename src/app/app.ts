import { Component } from '@angular/core';
import { PlanView } from './editor/plan-view';
import { ViewerPane } from './render3d/viewer-pane';
import { SplitPane } from './shell/split-pane';
import { TopBar } from './shell/top-bar';

@Component({
  selector: 'app-root',
  imports: [TopBar, SplitPane, PlanView, ViewerPane],
  template: `
    <app-top-bar />
    <app-split-pane class="panes">
      <app-plan-view left />
      <app-viewer-pane right />
    </app-split-pane>
  `,
  styleUrl: './app.scss',
})
export class App {}

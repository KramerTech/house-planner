import { Component, inject, signal } from '@angular/core';
import { ButtonModule } from '@openng/optimus-ui/button';
import { ProjectStore } from '../core/state/project-store';
import { CheckpointMenu } from './checkpoint-menu';
import { ProjectPicker } from './project-picker';
import { SettingsDialog } from './settings-dialog';

@Component({
  selector: 'app-top-bar',
  imports: [ButtonModule, CheckpointMenu, ProjectPicker, SettingsDialog],
  template: `
    <div class="brand"><i class="pi pi-home"></i> Home Designer</div>
    <span class="divider"></span>
    <span class="project-name" [title]="store.project().name">{{ store.project().name }}</span>
    <span class="spacer"></span>
    <app-checkpoint-menu />
    <p-button label="Projects" icon="pi pi-folder-open" severity="secondary" [text]="true" (onClick)="pickerOpen.set(true)" />
    <p-button label="Settings" icon="pi pi-cog" severity="secondary" [text]="true" (onClick)="settingsOpen.set(true)" />

    <app-project-picker [(visible)]="pickerOpen" />
    <app-settings-dialog [(visible)]="settingsOpen" />
  `,
  styles: `
    :host {
      display: flex; align-items: center; gap: 12px; height: 52px; padding: 0 12px;
      border-bottom: 1px solid #e2e5e8; background: #fff;
    }
    .brand { font-weight: 700; white-space: nowrap; color: #b45309; display: flex; align-items: center; gap: 6px; }
    .divider { width: 1px; height: 22px; background: #e2e5e8; }
    .project-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 30vw; }
    .spacer { flex: 1; }
  `,
})
export class TopBar {
  protected readonly store = inject(ProjectStore);
  protected readonly pickerOpen = signal(false);
  protected readonly settingsOpen = signal(false);
}

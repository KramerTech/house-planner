import { DatePipe } from '@angular/common';
import { Component, inject, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmationService } from '@openng/optimus-ui/api';
import { ButtonModule } from '@openng/optimus-ui/button';
import { ConfirmDialogModule } from '@openng/optimus-ui/confirmdialog';
import { DialogModule } from '@openng/optimus-ui/dialog';
import { InputTextModule } from '@openng/optimus-ui/inputtext';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { ProjectMeta } from '../core/model/types';
import { ProjectStore } from '../core/state/project-store';
import { InlineEdit } from './inline-edit';

/** Dialog for opening, creating and deleting saved projects. */
@Component({
  selector: 'app-project-picker',
  imports: [DatePipe, FormsModule, ButtonModule, ConfirmDialogModule, DialogModule, InputTextModule, TooltipModule, InlineEdit],
  providers: [ConfirmationService],
  template: `
    <p-dialog header="Projects" [(visible)]="visible" [modal]="true" [style]="{ width: '480px' }" [draggable]="false">
      <form class="new-row" (ngSubmit)="create()">
        <input pInputText name="name" placeholder="New project name" [(ngModel)]="newName" />
        <p-button type="submit" label="New" icon="pi pi-plus" />
      </form>

      <ul class="list">
        @for (p of store.projects(); track p.id) {
          <li [class.current]="p.id === store.project().id">
            @if (editingId() === p.id) {
              <app-inline-edit
                [value]="p.name"
                label="Project name"
                (committed)="rename(p, $event)"
                (cancelled)="editingId.set(null)"
              />
            } @else {
              <button type="button" class="open" (click)="open(p)">
                <span class="name">{{ p.name }}</span>
                <span class="date">Edited {{ p.updatedAt | date: 'medium' }}</span>
              </button>
              @if (p.id === store.project().id) {
                <span class="badge">Open</span>
              }
            }
            <p-button
              [icon]="copiedId() === p.id ? 'pi pi-check' : 'pi pi-share-alt'"
              severity="secondary"
              [text]="true"
              [rounded]="true"
              ariaLabel="Copy share code"
              pTooltip="Copy share code"
              tooltipPosition="top"
              (onClick)="copyShareCode(p)"
            />
            <p-button
              icon="pi pi-pencil"
              severity="secondary"
              [text]="true"
              [rounded]="true"
              ariaLabel="Rename project"
              (onClick)="editingId.set(p.id)"
            />
            <p-button
              icon="pi pi-trash"
              severity="danger"
              [text]="true"
              [rounded]="true"
              ariaLabel="Delete project"
              (onClick)="confirmDelete(p)"
            />
          </li>
        } @empty {
          <li class="empty">No saved projects yet.</li>
        }
      </ul>

      <form class="import" (ngSubmit)="importCode()">
        <label for="share-code">Load a shared design</label>
        <div class="import-row">
          <input
            pInputText
            id="share-code"
            name="code"
            placeholder="Paste share code"
            autocomplete="off"
            spellcheck="false"
            [ngModel]="code()"
            (ngModelChange)="code.set($event); importError.set(null)"
          />
          <p-button type="submit" label="Load" icon="pi pi-download" [disabled]="!code().trim()" />
        </div>
        @if (importError(); as err) {
          <small class="error">{{ err }}</small>
        }
      </form>
    </p-dialog>
    <p-confirmdialog />
  `,
  styles: `
    .new-row { display: flex; gap: 8px; margin-bottom: 12px; }
    .new-row input { flex: 1; }
    .list { list-style: none; margin: 0; padding: 0; max-height: 50vh; overflow: auto; }
    li { display: flex; align-items: center; gap: 8px; border-radius: 6px; padding: 2px 4px; }
    li:hover { background: var(--p-content-hover-background, #f3f4f6); }
    li.current .name { font-weight: 600; }
    .open {
      flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      background: none; border: 0; padding: 8px 4px; cursor: pointer; text-align: left; color: inherit; font: inherit;
    }
    .date { font-size: 12px; color: #6b7280; }
    .badge { font-size: 11px; color: #b45309; font-weight: 600; }
    .empty { color: #6b7280; padding: 8px; }
    .import { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
    .import label { font-size: 13px; font-weight: 600; }
    .import-row { display: flex; gap: 8px; }
    .import-row input { flex: 1; min-width: 0; font-family: ui-monospace, monospace; font-size: 12px; }
    .error { color: #dc2626; }
  `,
})
export class ProjectPicker {
  protected readonly store = inject(ProjectStore);
  private readonly confirm = inject(ConfirmationService);

  readonly visible = model(false);
  protected readonly newName = signal('');
  protected readonly editingId = signal<string | null>(null);
  protected readonly copiedId = signal<string | null>(null);
  protected readonly code = signal('');
  protected readonly importError = signal<string | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  protected open(p: ProjectMeta): void {
    this.store.openProject(p.id);
    this.visible.set(false);
  }

  protected rename(p: ProjectMeta, name: string): void {
    this.store.renameProject(p.id, name);
    this.editingId.set(null);
  }

  protected create(): void {
    this.store.newProject(this.newName() || `Project ${this.store.projects().length + 1}`);
    this.newName.set('');
    this.visible.set(false);
  }

  protected async copyShareCode(p: ProjectMeta): Promise<void> {
    try {
      await navigator.clipboard.writeText(await this.store.shareCode(p.id));
      this.copiedId.set(p.id);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copiedId.set(null), 1500);
    } catch (err) {
      console.error('Failed to copy share code', err);
    }
  }

  protected async importCode(): Promise<void> {
    try {
      await this.store.importShareCode(this.code());
      this.code.set('');
      this.importError.set(null);
      this.visible.set(false);
    } catch (err) {
      this.importError.set(err instanceof Error ? err.message : 'Could not load that share code.');
    }
  }

  protected confirmDelete(p: ProjectMeta): void {
    this.confirm.confirm({
      header: 'Delete project?',
      message: `“${p.name}” will be permanently deleted.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptButtonProps: { severity: 'danger' },
      rejectButtonProps: { severity: 'secondary', text: true },
      accept: () => this.store.deleteProject(p.id),
    });
  }
}

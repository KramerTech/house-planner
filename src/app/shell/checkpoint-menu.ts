import { DatePipe } from '@angular/common';
import { Component, inject, signal, viewChild } from '@angular/core';
import { ConfirmationService, ConfirmEventType } from '@openng/optimus-ui/api';
import { ButtonModule } from '@openng/optimus-ui/button';
import { ConfirmDialogModule } from '@openng/optimus-ui/confirmdialog';
import { Popover, PopoverModule } from '@openng/optimus-ui/popover';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { Checkpoint } from '../core/model/types';
import { ProjectStore } from '../core/state/project-store';
import { InlineEdit } from './inline-edit';

/**
 * "Save checkpoint" button plus a popover listing the project's checkpoints. Clicking
 * a checkpoint jumps to it (design + camera); checkpoints can be renamed or deleted.
 */
@Component({
  selector: 'app-checkpoint-menu',
  imports: [DatePipe, ButtonModule, ConfirmDialogModule, PopoverModule, TooltipModule, InlineEdit],
  providers: [ConfirmationService],
  template: `
    <p-button
      label="Save checkpoint"
      icon="pi pi-bookmark"
      severity="secondary"
      [outlined]="true"
      size="small"
      pTooltip="Save the current design and camera view"
      tooltipPosition="bottom"
      (onClick)="save()"
    />
    <p-button
      [label]="'Checkpoints (' + store.checkpoints().length + ')'"
      icon="pi pi-history"
      severity="secondary"
      [text]="true"
      (onClick)="cpPopover.toggle($event)"
    />

    <p-popover #cpPopover>
      <div class="cp-panel">
        @for (c of newestFirst(); track c.id) {
          <div class="cp-row" [class.active]="c.id === store.activeCheckpointId()">
            @if (editingId() === c.id) {
              <app-inline-edit
                [value]="c.name"
                label="Checkpoint name"
                (committed)="rename(c, $event)"
                (cancelled)="editingId.set(null)"
              />
            } @else {
              <button type="button" class="cp-open" (click)="jump(c)">
                <span class="cp-name">
                  {{ c.name }}
                  @if (c.id === store.activeCheckpointId()) {
                    <span class="cp-tag">{{ store.modifiedSinceCheckpoint() ? 'current · modified' : 'current' }}</span>
                  }
                </span>
                <span class="cp-date">{{ c.createdAt | date: 'MMM d, h:mm a' }}</span>
              </button>
            }
            <p-button icon="pi pi-pencil" severity="secondary" [text]="true" [rounded]="true" size="small" ariaLabel="Rename checkpoint" (onClick)="editingId.set(c.id)" />
            <p-button icon="pi pi-trash" severity="danger" [text]="true" [rounded]="true" size="small" ariaLabel="Delete checkpoint" (onClick)="confirmDelete(c)" />
          </div>
        } @empty {
          <div class="cp-empty">No checkpoints yet. Use <b>Save checkpoint</b> to capture this design.</div>
        }
      </div>
    </p-popover>
    <p-confirmdialog />
  `,
  styles: `
    :host { display: flex; align-items: center; gap: 4px; }
    .cp-panel { width: 340px; max-height: 60vh; overflow: auto; margin: -4px; }
    .cp-row { display: flex; align-items: center; gap: 2px; border-radius: 6px; padding: 0 2px 0 4px; }
    .cp-row:hover { background: var(--p-content-hover-background, #f3f4f6); }
    .cp-row.active .cp-name { font-weight: 600; }
    .cp-open {
      flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
      background: none; border: 0; padding: 7px 4px; cursor: pointer; text-align: left; color: inherit; font: inherit;
    }
    .cp-name { font-size: 14px; }
    .cp-tag { margin-left: 6px; font-size: 11px; font-weight: 600; color: #b45309; }
    .cp-date { font-size: 12px; color: #6b7280; }
    .cp-empty { padding: 8px; color: #6b7280; font-size: 13px; }
  `,
})
export class CheckpointMenu {
  protected readonly store = inject(ProjectStore);
  private readonly confirm = inject(ConfirmationService);
  protected readonly popover = viewChild.required<Popover>('cpPopover');
  protected readonly editingId = signal<string | null>(null);

  protected newestFirst(): Checkpoint[] {
    return [...this.store.checkpoints()].reverse();
  }

  protected save(): void {
    this.store.saveCheckpoint();
  }

  protected jump(c: Checkpoint): void {
    if (c.id === this.store.activeCheckpointId() && !this.store.modifiedSinceCheckpoint()) {
      this.store.restoreCheckpoint(c.id); // still re-applies the saved camera
      return;
    }
    if (!this.store.hasUncheckpointedChanges()) {
      this.store.restoreCheckpoint(c.id);
      return;
    }
    this.popover().hide();
    this.confirm.confirm({
      header: 'Discard current changes?',
      message: `Your current design isn’t saved in any checkpoint. Jumping to “${c.name}” will replace it.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Save, then jump',
      rejectLabel: 'Discard & jump',
      acceptButtonProps: { severity: 'primary' },
      rejectButtonProps: { severity: 'danger', outlined: true },
      closable: true,
      accept: () => {
        this.store.saveCheckpoint();
        this.store.restoreCheckpoint(c.id);
      },
      reject: (type: ConfirmEventType) => {
        // Closing the dialog (CANCEL) leaves everything as is.
        if (type === ConfirmEventType.REJECT) this.store.restoreCheckpoint(c.id);
      },
    });
  }

  protected rename(c: Checkpoint, name: string): void {
    this.store.renameCheckpoint(c.id, name);
    this.editingId.set(null);
  }

  protected confirmDelete(c: Checkpoint): void {
    this.popover().hide();
    this.confirm.confirm({
      header: 'Delete checkpoint?',
      message: `“${c.name}” will be permanently deleted. Your current design is not affected.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptButtonProps: { severity: 'danger' },
      rejectButtonProps: { severity: 'secondary', text: true },
      accept: () => this.store.deleteCheckpoint(c.id),
    });
  }
}

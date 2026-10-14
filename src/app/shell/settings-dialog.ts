import { Component, inject, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from '@openng/optimus-ui/button';
import { DialogModule } from '@openng/optimus-ui/dialog';
import { InputNumberModule } from '@openng/optimus-ui/inputnumber';
import { DEFAULT_SETTINGS } from '../core/model/defaults';
import { ProjectSettings } from '../core/model/types';
import { ProjectStore } from '../core/state/project-store';

interface SettingField {
  key: keyof ProjectSettings;
  label: string;
  unit: 'in' | 'ft';
  min: number;
  max: number;
  step: number;
}

/** Fields are stored in feet; `unit` controls how they are displayed and edited. */
const FIELDS: SettingField[] = [
  { key: 'overhang', label: 'Roof overhang', unit: 'ft', min: 0, max: 6, step: 0.5 },
  { key: 'roofThickness', label: 'Roof thickness', unit: 'in', min: 1, max: 24, step: 1 },
  { key: 'wallThickness', label: 'Wall thickness', unit: 'in', min: 2, max: 18, step: 0.5 },
  { key: 'postSize', label: 'Patio post size', unit: 'in', min: 3, max: 12, step: 0.5 },
  { key: 'defaultSectionDepth', label: 'New section depth', unit: 'ft', min: 1, max: 60, step: 1 },
];

/** Per-project building settings. */
@Component({
  selector: 'app-settings-dialog',
  imports: [FormsModule, ButtonModule, DialogModule, InputNumberModule],
  template: `
    <p-dialog header="Settings" [(visible)]="visible" [modal]="true" [style]="{ width: '380px' }" [draggable]="false">
      <div class="fields">
        @for (f of fields; track f.key) {
          <label [for]="f.key">{{ f.label }}</label>
          <p-inputnumber
            [inputId]="f.key"
            [ngModel]="display(f)"
            (ngModelChange)="set(f, $event)"
            [min]="f.min"
            [max]="f.max"
            [step]="f.step"
            [showButtons]="true"
            [minFractionDigits]="0"
            [maxFractionDigits]="2"
            [suffix]="f.unit === 'ft' ? ' ft' : ' in'"
            size="small"
            [fluid]="true"
          />
        }
      </div>
      <ng-template #footer>
        <p-button label="Reset to defaults" severity="secondary" [text]="true" (onClick)="reset()" />
        <p-button label="Done" (onClick)="visible.set(false)" />
      </ng-template>
    </p-dialog>
  `,
  styles: `
    .fields { display: grid; grid-template-columns: 1fr 150px; gap: 10px 12px; align-items: center; }
    label { font-size: 14px; }
  `,
})
export class SettingsDialog {
  private readonly store = inject(ProjectStore);
  readonly visible = model(false);
  protected readonly fields = FIELDS;

  protected display(f: SettingField): number {
    const ft = this.store.settings()[f.key];
    return f.unit === 'in' ? Math.round(ft * 12 * 100) / 100 : ft;
  }

  protected set(f: SettingField, value: number | null): void {
    if (value === null || !Number.isFinite(value)) return;
    const clamped = Math.min(f.max, Math.max(f.min, value));
    this.store.updateSettings({ [f.key]: f.unit === 'in' ? clamped / 12 : clamped });
  }

  protected reset(): void {
    this.store.updateSettings({ ...DEFAULT_SETTINGS });
  }
}

import { afterNextRender, Component, ElementRef, input, output, viewChild } from '@angular/core';
import { InputTextModule } from '@openng/optimus-ui/inputtext';

/**
 * Text input for renaming in place. Focuses and selects on creation; Enter or blur
 * commits, Escape cancels. The parent decides when to show it.
 */
@Component({
  selector: 'app-inline-edit',
  imports: [InputTextModule],
  template: `
    <input
      #field
      pInputText
      pSize="small"
      [value]="value()"
      [attr.aria-label]="label()"
      (keydown.enter)="commit()"
      (keydown.escape)="cancel()"
      (blur)="commit()"
      (click)="$event.stopPropagation()"
    />
  `,
  styles: `
    :host { display: block; flex: 1; min-width: 0; }
    input { width: 100%; }
  `,
})
export class InlineEdit {
  readonly value = input.required<string>();
  readonly label = input('Name');
  readonly committed = output<string>();
  readonly cancelled = output<void>();

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private done = false;

  constructor() {
    afterNextRender(() => {
      const el = this.field().nativeElement;
      el.focus();
      el.select();
    });
  }

  protected commit(): void {
    if (this.done) return;
    this.done = true;
    const text = this.field().nativeElement.value.trim();
    if (text && text !== this.value()) this.committed.emit(text);
    else this.cancelled.emit();
  }

  protected cancel(): void {
    if (this.done) return;
    this.done = true;
    this.cancelled.emit();
  }
}

import { Component, input } from '@angular/core';
import { Prim } from '../core/floorplan/catalog';

/**
 * Draws a furniture symbol (in feet, centered on the origin) inside an SVG group.
 * Used both on the plan, where the parent group places and scales it, and in the
 * furniture panel's thumbnails.
 */
@Component({
  selector: 'g[appItemSymbol]',
  template: `
    @for (p of prims(); track $index) {
      @switch (p.t) {
        @case ('rect') {
          <svg:rect [attr.class]="p.s" [attr.x]="p.x" [attr.y]="p.y" [attr.width]="p.w" [attr.height]="p.h" [attr.rx]="p.r ?? 0" />
        }
        @case ('circle') {
          <svg:circle [attr.class]="p.s" [attr.cx]="p.cx" [attr.cy]="p.cy" [attr.r]="p.r" />
        }
        @case ('ellipse') {
          <svg:ellipse [attr.class]="p.s" [attr.cx]="p.cx" [attr.cy]="p.cy" [attr.rx]="p.rx" [attr.ry]="p.ry" />
        }
        @case ('line') {
          <svg:line [attr.class]="p.s" [attr.x1]="p.x1" [attr.y1]="p.y1" [attr.x2]="p.x2" [attr.y2]="p.y2" />
        }
        @case ('path') {
          <svg:path [attr.class]="p.s" [attr.d]="p.d" />
        }
        @case ('text') {
          <svg:text class="label" [attr.x]="p.x" [attr.y]="p.y" [attr.font-size]="p.size" text-anchor="middle" dominant-baseline="central">
            {{ p.text }}
          </svg:text>
        }
      }
    }
  `,
  styles: `
    :host { --tint: #dfe5ea; }
    * { vector-effect: non-scaling-stroke; stroke-linejoin: round; }
    .body { fill: var(--tint); stroke: #4b5560; stroke-width: 1.2; }
    .soft { fill: #fbfbfa; stroke: #7d8790; stroke-width: 0.8; }
    .solid { fill: #6f7a84; stroke: #4b5560; stroke-width: 0.8; }
    .line { fill: none; stroke: #6f7a84; stroke-width: 0.9; }
    .dash { fill: none; stroke: #6f7a84; stroke-width: 0.9; stroke-dasharray: 3 3; }
    .label { fill: #4b5560; font-weight: 700; font-family: system-ui, sans-serif; }
  `,
})
export class ItemSymbol {
  readonly prims = input.required<readonly Prim[]>({ alias: 'appItemSymbol' });
}

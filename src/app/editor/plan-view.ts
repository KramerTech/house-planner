import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ButtonModule } from '@openng/optimus-ui/button';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { buildBuildingModel } from '../render3d/build/building-builder';
import { roofSurfaceArea } from '../render3d/build/roof-area';
import { freeSegments, SideSegment, sideSegments } from '../core/geometry/edges';
import { boundsOf, sideAxis, sideCoord, sideSpan } from '../core/geometry/rect';
import { Rect, Section, Side } from '../core/model/types';
import { EditorState } from '../core/state/editor-state';
import { ProjectStore } from '../core/state/project-store';
import { exteriorDims } from '../core/floorplan/exterior-dims';
import { floorArea, grossAreas, openingsOf, outsideFootprint, regionOf, wallFootprint } from '../core/floorplan/floor-region';
import { formatFeet } from '../core/model/format';
import { freeSegmentNear, SideHandle, sidesNear } from './hit-test';
import { SectionPanel } from './section-panel';
import { ActiveSideDrag, beginSideDrag, DRAG_START_THRESHOLD_PX, dragValue, resolveHandle } from './side-drag';
import { clampPan, fitViewport, Point, screenToWorld, Viewport, worldToScreen, zoomAt } from './viewport';

/** Panels need roughly this much screen space inside a section to show in full. */
const FULL_PANEL_MIN = { w: 200, h: 220 };
const WHEEL_ZOOM_SPEED = 0.0015;
/** Below this zoom level (percent) section panels are hidden to keep the plan legible. */
const PANEL_MIN_ZOOM_PERCENT = 60;
/** Exterior dimension strings: distance (px) of the first string from the building, and between strings. */
const DIM_FIRST_PX = 30;
const DIM_GAP_PX = 26;

type Interaction =
  | { mode: 'idle' }
  | { mode: 'pan'; pointerId: number; start: Point; startView: Viewport }
  | { mode: 'pending-side'; pointerId: number; start: Point; candidates: SideHandle[] }
  | { mode: 'side'; pointerId: number; drag: ActiveSideDrag };

type Hover =
  | { kind: 'side'; handle: SideHandle }
  | { kind: 'free'; segment: SideSegment; preview: Rect | null }
  | null;

interface ScreenLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface DimLabel {
  x: number;
  y: number;
  text: string;
  vertical: boolean;
}

/**
 * Left pane: 2D plan editor. Sections are drawn in screen space (so strokes and
 * labels stay crisp at any zoom). Pointer input drives a small state machine:
 * dragging a side resizes the section the pointer is on (other sections are pushed
 * or pulled only when they must give way or would be cut off, and spring back),
 * within a precomputed valid range. Shift+click
 * on an open segment adds a section, and dragging anywhere else pans.
 */
@Component({
  selector: 'app-plan-view',
  imports: [SectionPanel, ButtonModule, TooltipModule],
  templateUrl: './plan-view.html',
  styleUrl: './plan-view.scss',
  host: {
    '[style.cursor]': 'cursor()',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerUp($event)',
    '(pointerleave)': 'onPointerLeave()',
    '(wheel)': 'onWheel($event)',
    '(window:keydown)': 'onKey($event)',
    '(window:keyup)': 'onKey($event)',
    '(window:blur)': 'onBlur()',
  },
})
export class PlanView {
  private readonly store = inject(ProjectStore);
  private readonly editor = inject(EditorState);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly size = signal<Point>({ x: 0, y: 0 });
  protected readonly view = computed<Viewport>(() => this.editor.planView() ?? { scale: 12, tx: 0, ty: 0 });
  protected readonly shiftHeld = signal(false);
  protected readonly hover = signal<Hover>(null);
  protected readonly expandedId = signal<string | null>(null);
  private readonly interaction = signal<Interaction>({ mode: 'idle' });

  protected readonly sections = this.store.sections;
  protected readonly rootId = this.store.rootId;
  private readonly freeSegs = computed(() => freeSegments(this.sections()));
  private readonly contentBounds = computed(() => boundsOf(this.sections().map((s) => s.rect)));

  // ------------------------------------------------------------------ view models

  protected readonly grid = computed(() => {
    const { scale, tx, ty } = this.view();
    const minorFt = scale >= 8 ? 1 : 5;
    const majorFt = scale >= 4 ? 10 : 50;
    return {
      minor: minorFt * scale,
      major: majorFt * scale,
      offsetX: tx,
      offsetY: ty,
    };
  });

  protected readonly sectionViews = computed(() => {
    const v = this.view();
    const rootId = this.rootId();
    const clear = this.clearSizes();
    return this.sections().map((s) => {
      const tl = worldToScreen(v, { x: s.rect.x, y: s.rect.y });
      const w = s.rect.w * v.scale;
      const h = s.rect.d * v.scale;
      return {
        section: s,
        x: tl.x,
        y: tl.y,
        w,
        h,
        cx: tl.x + w / 2,
        cy: tl.y + h / 2,
        isRoot: s.id === rootId,
        compact: w < FULL_PANEL_MIN.w || h < FULL_PANEL_MIN.h,
        lowEdge: this.sideLine(s, s.roof.slopeDir, 4),
        showDims: w > 50 && h > 30,
        clearW: formatFeet(clear.get(s.id)!.w),
        clearD: formatFeet(clear.get(s.id)!.d),
      };
    });
  });

  /** The side being dragged, or that a drag would grab, drawn as a highlight. */
  protected readonly activeSideLine = computed<ScreenLine | null>(() => {
    const it = this.interaction();
    const h = this.hover();
    const handle = it.mode === 'side' ? it.drag.seed : it.mode === 'idle' && h?.kind === 'side' ? h.handle : null;
    if (!handle) return null;
    const section = this.sections().find((s) => s.id === handle.sectionId);
    return section ? this.sideLine(section, handle.side, 0) : null;
  });

  /** Live dimension readout while dragging. */
  protected readonly dragLabel = computed(() => {
    const it = this.interaction();
    if (it.mode !== 'side') return null;
    const { seed } = it.drag;
    const section = this.sections().find((s) => s.id === seed.sectionId);
    if (!section) return null;
    const line = this.sideLine(section, seed.side, 0);
    const clear = this.clearSizes().get(section.id)!;
    const len = sideAxis(seed.side) === 'x' ? clear.w : clear.d;
    return { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2, text: formatFeet(len) };
  });

  protected readonly freeSegLines = computed(() => {
    if (!this.shiftHeld()) return [];
    const v = this.view();
    return this.freeSegs().map((seg) => segmentLine(v, seg));
  });

  protected readonly hoverFree = computed(() => {
    const h = this.hover();
    if (h?.kind !== 'free' || !this.shiftHeld()) return null;
    const v = this.view();
    const preview = h.preview ? this.screenRect(h.preview) : null;
    return { line: segmentLine(v, h.segment), preview, dims: h.preview ? `${h.preview.w}' × ${h.preview.d}'` : null };
  });

  protected readonly cursor = computed(() => {
    const it = this.interaction();
    if (it.mode === 'pan') return 'grabbing';
    if (it.mode === 'side') return it.drag.axis === 'x' ? 'ew-resize' : 'ns-resize';
    const h = this.hover();
    if (h?.kind === 'free') return h.preview ? 'copy' : 'not-allowed';
    if (h?.kind === 'side') return sideAxis(h.handle.side) === 'x' ? 'ew-resize' : 'ns-resize';
    return 'grab';
  });

  /** Gross areas to the outside faces of the walls (and patio posts). */
  protected readonly area = computed(() => {
    const settings = this.store.settings();
    const a = grossAreas(this.sections(), settings);
    const floors = this.store.floors();
    const areaOf = (pick: (elevation: number) => boolean) =>
      Math.round(
        floors.reduce((sum, f, i) => (pick(f.elevation) ? sum + floorArea(regionOf(this.sections(), settings, f), openingsOf(floors, i)) : sum), 0),
      );
    const [upper, basement] = [areaOf((e) => e > 0), areaOf((e) => e < 0)];
    const [enclosed, covered] = [Math.round(a.enclosed), Math.round(a.covered)];
    return { enclosed, upper, basement, covered, total: enclosed + covered + upper + basement };
  });

  /**
   * Each section's clear inside size: its centerline size less half a wall (or post)
   * on every side that has one. Sides shared with another enclosed section are open.
   */
  private readonly clearSizes = computed(() => {
    const sections = this.sections();
    const settings = this.store.settings();
    const byId = new Map(sections.map((s) => [s.id, s]));
    const out = new Map<string, { w: number; d: number }>();
    for (const s of sections) {
      const half = (s.patio.enabled ? settings.postSize : settings.wallThickness) / 2;
      const built = (side: Side) =>
        sideSegments(s, side, sections).some((seg) => {
          const n = seg.neighborId ? byId.get(seg.neighborId) : undefined;
          return !n || n.patio.enabled;
        });
      const cut = (side: Side) => (built(side) ? half : 0);
      out.set(s.id, { w: s.rect.w - cut('W') - cut('E'), d: s.rect.d - cut('N') - cut('S') });
    }
    return out;
  });

  /**
   * Exterior dimensions, outside the whole building: on every side, a string with
   * one dimension per outside face of the house's walls — patios don't count, so a
   * patio never hides the wall behind it — and, on the north and west, the overall
   * size of everything (patios included) further out, unless that would just repeat
   * a single wall dimension.
   */
  protected readonly dims = computed(() => {
    const v = this.view();
    const lines: ScreenLine[] = [];
    const ext: ScreenLine[] = [];
    const ticks: ScreenLine[] = [];
    const labels: DimLabel[] = [];
    const settings = this.store.settings();
    const walls = new Map(exteriorDims(wallFootprint(this.sections(), settings)).map((d) => [d.side, d]));
    for (const whole of exteriorDims(outsideFootprint(this.sections(), settings))) {
      const sd = walls.get(whole.side) ?? whole;
      const horizontal = sd.side === 'N' || sd.side === 'S';
      const out = sd.side === 'N' || sd.side === 'W' ? -1 : 1;
      const along = (a: number) => (horizontal ? worldToScreen(v, { x: a, y: 0 }).x : worldToScreen(v, { x: 0, y: a }).y);
      const across = (c: number) => (horizontal ? worldToScreen(v, { x: 0, y: c }).y : worldToScreen(v, { x: c, y: 0 }).x);
      const pt = (a: number, c: number) => (horizontal ? { x: a, y: c } : { x: c, y: a });
      const seg = (a1: number, c1: number, a2: number, c2: number): ScreenLine => {
        const p = pt(a1, c1);
        const q = pt(a2, c2);
        return { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
      };
      const nearer = (f1: number, f2: number) => (out < 0 ? Math.min(f1, f2) : Math.max(f1, f2));

      /** A dimension string through `stops` (along, face) at screen distance `at` across. */
      const string = (stops: { a: number; face: number }[], at: number) => {
        lines.push(seg(along(stops[0].a), at, along(stops.at(-1)!.a), at));
        stops.forEach((st, i) => {
          const a = along(st.a);
          ext.push(seg(a, across(st.face) + out * 4, a, at + out * 6));
          const slant = horizontal ? 4 : -4;
          ticks.push(seg(a - 4, at + slant, a + 4, at - slant));
          const next = stops[i + 1];
          if (!next || Math.abs(along(next.a) - a) < 26) return;
          const p = pt((a + along(next.a)) / 2, at - 5);
          labels.push({ x: p.x, y: p.y, text: formatFeet(next.a - st.a), vertical: !horizontal });
        });
      };

      const base = across(whole.extreme);
      const stops = [{ a: sd.from, face: sd.pieces[0].face }];
      sd.pieces.forEach((p, i) => {
        const next = sd.pieces[i + 1];
        stops.push({ a: p.to, face: next ? nearer(p.face, next.face) : p.face });
      });
      string(stops, base + out * DIM_FIRST_PX);
      const repeats = sd.pieces.length === 1 && sd.from === whole.from && sd.to === whole.to;
      if ((sd.side === 'N' || sd.side === 'W') && !repeats) {
        const ends = [
          { a: whole.from, face: whole.pieces[0].face },
          { a: whole.to, face: whole.pieces.at(-1)!.face },
        ];
        string(ends, base + out * (DIM_FIRST_PX + DIM_GAP_PX));
      }
    }
    return { lines, ext, ticks, labels };
  });
  protected readonly roofArea = computed(() =>
    Math.round(roofSurfaceArea(buildBuildingModel({ sections: this.sections(), settings: this.store.settings() }))),
  );

  protected readonly zoomPercent = computed(() => Math.round((this.view().scale / 12) * 100));
  protected readonly showPanels = computed(() => this.zoomPercent() >= PANEL_MIN_ZOOM_PERCENT);

  constructor() {
    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const first = this.size().x === 0;
      this.size.set({ x: width, y: height });
      if (first && !this.editor.planView()) this.fit();
    });
    afterNextRender(() => resize.observe(this.host.nativeElement));
    inject(DestroyRef).onDestroy(() => resize.disconnect());

    // Re-fit whenever the design is replaced (project opened, checkpoint restored).
    let lastEpoch = untracked(this.store.viewEpoch);
    effect(() => {
      const epoch = this.store.viewEpoch();
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        this.expandedId.set(null);
        untracked(() => this.fit());
      }
    });
  }

  // ------------------------------------------------------------------ commands

  fit(): void {
    if (this.size().x === 0) return;
    this.editor.planView.set(fitViewport(this.size(), this.contentBounds()));
  }

  zoomBy(factor: number): void {
    const s = this.size();
    this.setView(zoomAt(this.view(), { x: s.x / 2, y: s.y / 2 }, factor));
  }

  // ------------------------------------------------------------------ pointer input

  protected onPointerDown(e: PointerEvent): void {
    if (isFromPanel(e)) return;
    if (e.button !== 0 && e.button !== 1) return;
    this.expandedId.set(null);
    const p = this.localPoint(e);

    if (e.button === 0 && e.shiftKey) {
      const seg = freeSegmentNear(this.freeSegs(), this.view(), p);
      if (seg) {
        this.store.addSectionFromSegment(seg);
        this.updateHover(p, true);
        e.preventDefault();
        return;
      }
    }

    const candidates = e.button === 0 ? sidesNear(this.sections(), this.view(), p) : [];
    this.capture(e);
    if (candidates.length) {
      this.store.beginGesture();
      this.interaction.set({ mode: 'pending-side', pointerId: e.pointerId, start: p, candidates });
    } else {
      this.interaction.set({ mode: 'pan', pointerId: e.pointerId, start: p, startView: this.view() });
    }
    e.preventDefault();
  }

  protected onPointerMove(e: PointerEvent): void {
    const p = this.localPoint(e);
    const it = this.interaction();
    this.shiftHeld.set(e.shiftKey);

    switch (it.mode) {
      case 'idle':
        if (!isFromPanel(e)) this.updateHover(p, e.shiftKey);
        else this.hover.set(null);
        return;

      case 'pan': {
        const v = it.startView;
        this.setView({ ...v, tx: v.tx + p.x - it.start.x, ty: v.ty + p.y - it.start.y });
        return;
      }

      case 'pending-side': {
        const delta = { x: p.x - it.start.x, y: p.y - it.start.y };
        if (Math.hypot(delta.x, delta.y) < DRAG_START_THRESHOLD_PX) return;
        const handle = resolveHandle(it.candidates, delta);
        const drag = beginSideDrag(
          handle,
          this.sections(),
          this.store.sideRange(handle),
          screenToWorld(this.view(), it.start),
          this.store.layoutStep(),
        );
        this.interaction.set({ mode: 'side', pointerId: it.pointerId, drag });
        this.applySideDrag(drag, p);
        return;
      }

      case 'side':
        this.applySideDrag(it.drag, p);
        return;
    }
  }

  protected onPointerUp(e: PointerEvent): void {
    const it = this.interaction();
    if (it.mode === 'idle' || it.pointerId !== e.pointerId) return;
    this.interaction.set({ mode: 'idle' });
    if (it.mode === 'side' || it.mode === 'pending-side') this.store.endGesture();
    this.store.flush();
    this.updateHover(this.localPoint(e), e.shiftKey);
  }

  protected onPointerLeave(): void {
    if (this.interaction().mode === 'idle') this.hover.set(null);
  }

  protected onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED * (e.deltaMode === 1 ? 16 : 1));
    this.setView(zoomAt(this.view(), this.localPoint(e), factor));
  }

  protected onKey(e: KeyboardEvent): void {
    this.shiftHeld.set(e.shiftKey);
    if (e.key === 'Shift' && this.lastPointer && this.interaction().mode === 'idle') {
      this.updateHover(this.lastPointer, e.shiftKey);
    }
  }

  protected onBlur(): void {
    this.shiftHeld.set(false);
  }

  // ------------------------------------------------------------------ internals

  private lastPointer: Point | null = null;

  private applySideDrag(drag: ActiveSideDrag, p: Point): void {
    const value = dragValue(drag, screenToWorld(this.view(), p));
    if (value === drag.lastValue) return;
    if (this.store.resizeSide(drag.original, drag.seed, value)) drag.lastValue = value;
  }

  private updateHover(p: Point, shift: boolean): void {
    this.lastPointer = p;
    if (shift) {
      const seg = freeSegmentNear(this.freeSegs(), this.view(), p);
      if (seg) {
        this.hover.set({ kind: 'free', segment: seg, preview: this.store.previewSectionFromSegment(seg) });
        return;
      }
    }
    const [handle] = sidesNear(this.sections(), this.view(), p);
    this.hover.set(handle ? { kind: 'side', handle } : null);
  }

  private setView(v: Viewport): void {
    this.editor.planView.set(clampPan(v, this.size(), this.contentBounds()));
  }

  private capture(e: PointerEvent): void {
    try {
      this.host.nativeElement.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  private localPoint(e: MouseEvent): Point {
    const r = this.host.nativeElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private screenRect(r: Rect) {
    const v = this.view();
    const tl = worldToScreen(v, { x: r.x, y: r.y });
    return { x: tl.x, y: tl.y, w: r.w * v.scale, h: r.d * v.scale };
  }

  /** Screen line for a section side, optionally inset (px) toward the section interior. */
  private sideLine(section: Section, side: Side, insetPx: number): ScreenLine {
    const v = this.view();
    const coord = sideCoord(section.rect, side);
    const span = sideSpan(section.rect, side);
    const inset = (side === 'E' || side === 'S' ? -insetPx : insetPx) / v.scale;
    const line = segmentLine(v, { side, coord: coord + inset, from: span.lo, to: span.hi });
    return line;
  }
}

function segmentLine(v: Viewport, seg: Pick<SideSegment, 'side' | 'coord' | 'from' | 'to'>): ScreenLine {
  const vertical = seg.side === 'E' || seg.side === 'W';
  const a = worldToScreen(v, vertical ? { x: seg.coord, y: seg.from } : { x: seg.from, y: seg.coord });
  const b = worldToScreen(v, vertical ? { x: seg.coord, y: seg.to } : { x: seg.to, y: seg.coord });
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

function isFromPanel(e: Event): boolean {
  return e.target instanceof Element && !!e.target.closest('.section-panel, .view-controls, .p-tooltip');
}

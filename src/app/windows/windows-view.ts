import { afterNextRender, Component, computed, DestroyRef, effect, ElementRef, inject, signal, untracked, viewChild } from '@angular/core';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { doorHeight, placeDoors } from '../core/floorplan/doors';
import { edgeAt, exteriorFaces, Face, faceAt, faceOutline, facePoint, faceView, lowerRoofAt, pickFace, slopeAt, syncRooflines } from '../core/floorplan/faces';
import { outsideFootprint, regionOf } from '../core/floorplan/floor-region';
import { pointIn, segsAt } from '../core/floorplan/region';
import { findRooms } from '../core/floorplan/rooms';
import { clampAlong, wallGeoms } from '../core/floorplan/wall-graph';
import {
  Bounds,
  MIN_WINDOW,
  moveShape,
  rooflineEdges,
  shapeBounds,
  shapeOutline,
  UZ,
  WINDOW_PRESETS,
  WINDOW_STYLES,
  windowFits,
  windowLines,
} from '../core/floorplan/windows';
import { x0, x1, y0, y1 } from '../core/geometry/rect';
import { newId, STORY } from '../core/model/defaults';
import { formatFeet } from '../core/model/format';
import { DoorKind, HouseWindow, Skylight, WindowShape, WindowStyle } from '../core/model/types';
import { EditorState } from '../core/state/editor-state';
import { ProjectStore } from '../core/state/project-store';
import { DRAG_START_THRESHOLD_PX } from '../editor/side-drag';
import { fitViewport, Point, screenToWorld, Viewport, worldToScreen, zoomAt } from '../editor/viewport';
import { isTyping } from '../shell/keys';
import { buildScene, Edge, Guide, roofClearance, SceneItem, snapEdge, snapMove, SnapScene, snapSlide } from './window-snap';
import { floorLabel } from '../floorplan/floor-stack';

const WHEEL_ZOOM_SPEED = 0.0015;
const HIT_PX = 7;
const SNAP_PX = 9;
/** Windows snap to whole inches; Alt turns off lining up with other things. */
const GRID = 1 / 12;
/** Polygon edges snap to multiples of this angle. */
const ANGLE_STEP = Math.PI / 12;
const IN = 1 / 12;

export type WindowTool = 'select' | 'rect' | 'circle' | 'arch' | 'roofline' | 'poly';

const TOOLS: { id: WindowTool; label: string; key: string; tip: string; icon: string }[] = [
  { id: 'select', label: 'Select', key: 'M', tip: 'Select, move and resize (M, or Space)', icon: 'M5 2.5 V15.5 L8.6 12.2 L11 17.5 L13.2 16.5 L10.8 11.3 H15.5 Z' },
  { id: 'rect', label: 'Rectangle', key: 'R', tip: 'Drag a rectangular window, or click to place a preset size (R)', icon: 'M3.5 4.5 H16.5 V15.5 H3.5 Z M10 4.5 V15.5' },
  { id: 'circle', label: 'Circle', key: 'C', tip: 'Drag out a round window from its center (C)', icon: 'M10 3.5 A6.5 6.5 0 1 1 9.99 3.5 Z' },
  { id: 'arch', label: 'Arch', key: 'A', tip: 'Drag a window with a half-round top (A)', icon: 'M4 16 V9.5 A6 6 0 0 1 16 9.5 V16 Z' },
  { id: 'roofline', label: 'Roofline', key: 'L', tip: 'Drag a window whose top follows the roof’s pitch (L)', icon: 'M3.5 16 V8 L16.5 4.5 V16 Z' },
  { id: 'poly', label: 'Shape', key: 'P', tip: 'Click corners for any shape; angles snap to 15° (Alt: free). Click the first corner, Enter or double-click to finish (P)', icon: 'M3 15.5 L6 4 L16.5 7.5 L14 16 Z' },
];

/**
 * What the selection is: windows on the face, skylights on the roof, or an exterior
 * door on the face (doors only slide along it here; they're added in Floorplan).
 */
type Picked = { kind: 'window' | 'skylight' | 'door'; ids: string[] };

/** An exterior door in the face being edited, where it can slide to, and its box on the face. */
interface FaceDoor {
  id: string;
  floorId: string;
  kind: DoorKind;
  width: number;
  /** The clear run of wall it can slide along (its center stays width/2 inside). */
  lo: number;
  hi: number;
  b: Bounds;
}

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'r' | number;

type Interaction =
  | { mode: 'idle' }
  | { mode: 'pan'; pointerId: number; start: Point; startView: Viewport; moved: boolean }
  | { mode: 'press'; pointerId: number; start: Point; id: string; handle: Handle | null }
  | { mode: 'move'; pointerId: number; start: UZ; ids: string[]; base: Map<string, WindowShape | Skylight> }
  | { mode: 'resize'; pointerId: number; id: string; handle: Handle; base: WindowShape | Skylight }
  | { mode: 'slide'; pointerId: number; start: UZ; door: FaceDoor }
  | { mode: 'draw'; pointerId: number; from: UZ; to: UZ };

/**
 * Left pane in Windows mode: one exterior wall face at a time, seen straight on
 * from outside (or the roof, from above, for skylights). Windows are drawn as
 * rectangles, circles, arches or free shapes, and edited in place; each has its own
 * opening style and grille. Exterior doors show on their faces and can be slid
 * along them, snapping like windows. The 3D view swings round to the face being edited.
 */
@Component({
  selector: 'app-windows-view',
  imports: [TooltipModule],
  templateUrl: './windows-view.html',
  styleUrl: './windows-view.scss',
  host: {
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerUp($event)',
    '(dblclick)': 'onDoubleClick($event)',
    '(window:keydown)': 'onKeyDown($event)',
    '(window:keyup)': 'alt.set($event.altKey); shift.set($event.shiftKey)',
    '(window:blur)': 'alt.set(false); shift.set(false)',
  },
})
export class WindowsView {
  private readonly store = inject(ProjectStore);
  private readonly editor = inject(EditorState);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly canvas = viewChild.required<ElementRef<HTMLElement>>('canvas');

  protected readonly feet = formatFeet;
  protected readonly inches = (ft: number) => `${Math.round(ft * 12)}″`;
  protected readonly styles = WINDOW_STYLES;
  protected readonly presets = WINDOW_PRESETS;

  protected readonly size = signal<Point>({ x: 0, y: 0 });
  protected readonly view = signal<Viewport>({ scale: 12, tx: 0, ty: 0 });
  protected readonly tool = signal<WindowTool>('select');
  /** Rectangle tool: a preset size to click in, or null to drag. */
  protected readonly preset = signal<[number, number] | null>(null);
  protected readonly pick = signal<Picked | null>(null);
  protected readonly interaction = signal<Interaction>({ mode: 'idle' });
  protected readonly cursor = signal<UZ | null>(null);
  protected readonly alt = signal(false);
  protected readonly shift = signal(false);
  /** Shape tool: the corners clicked so far. */
  protected readonly polyPts = signal<UZ[]>([]);
  /** What the current drag snapped to, to show. */
  protected readonly guides = signal<Guide[]>([]);

  // ------------------------------------------------------------------ faces

  private readonly sections = this.store.sections;
  protected readonly faces = computed(() => exteriorFaces(this.sections(), this.store.settings()));

  /** The face (or the roof) being edited: the one picked, else a south wall. */
  protected readonly roof = computed(() => this.editor.windowFace() === 'roof');
  protected readonly face = computed<Face | null>(() => {
    return this.roof() ? null : pickFace(this.faces(), this.editor.windowFace());
  });
  protected readonly faceIndex = computed(() => {
    const f = this.face();
    return f ? this.faces().indexOf(f) : -1;
  });
  protected readonly faceLabel = computed(() => {
    if (this.roof()) return 'Roof · skylights';
    const f = this.face();
    return f ? this.faceName(f) : 'No walls';
  });

  /** e.g. "South wall 2 · 14′" — numbered when several walls face the same way. */
  private faceName(f: Face): string {
    const same = this.faces().filter((o) => o.side === f.side && o.clerestory === f.clerestory);
    const n = same.length > 1 ? ` ${same.indexOf(f) + 1}` : '';
    return `${SIDE_NAME[f.side]}${f.clerestory ? ' clerestory' : ' wall'}${n} · ${formatFeet(f.to - f.from)}`;
  }

  /** The house from above, with every face as a line to click (plan units). */
  protected readonly minimap = computed(() => {
    const house = outsideFootprint(this.sections(), this.store.settings());
    const active = this.face()?.key;
    const faces = this.faces().map((f) => {
      const [a, b] = [facePoint(f.side, f.coord, f.from), facePoint(f.side, f.coord, f.to)];
      return { key: f.key, x1: a.x, y1: a.y, x2: b.x, y2: b.y, clerestory: f.clerestory, active: f.key === active, title: this.faceName(f) };
    });
    const xs = house.flatMap((r) => [r.x0, r.x1]);
    const ys = house.flatMap((r) => [r.y0, r.y1]);
    const pad = 3;
    const viewBox = xs.length
      ? `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${Math.max(...xs) - Math.min(...xs) + 2 * pad} ${Math.max(...ys) - Math.min(...ys) + 2 * pad}`
      : '0 0 10 10';
    return { house, faces, viewBox };
  });
  /** Which way u runs on screen: looking at a north face from outside, east is on the left. */
  private readonly flip = computed(() => {
    const f = this.face();
    return f ? faceView(f.side).flip : false;
  });

  // ------------------------------------------------------------------ what's on the face

  /** Windows on the face being edited. */
  protected readonly faceWindows = computed(() => {
    const f = this.face();
    if (!f) return [];
    return this.store.windows().filter((w) => {
      const b = shapeBounds(w.shape);
      return faceAt([f], w.host, (b.u0 + b.u1) / 2) === f;
    });
  });

  /** Exterior doors in this face (they're drawn, windows stay clear of them, and they slide along it). */
  private readonly faceDoors = computed<FaceDoor[]>(() => {
    const f = this.face();
    if (!f) return [];
    const settings = this.store.settings();
    const ti = settings.interiorWallThickness;
    return this.store.floors().flatMap((fl) =>
      placeDoors(fl, regionOf(this.sections(), settings, fl), ti)
        .filter((p) => p.exterior && 'side' in p.door.host && faceAt([f], p.door.host, p.at) === f)
        .map((p) => ({
          id: p.door.id,
          floorId: fl.id,
          kind: p.door.kind,
          width: p.door.width,
          lo: p.lo,
          hi: p.hi,
          b: { u0: p.at - p.door.width / 2, u1: p.at + p.door.width / 2, z0: fl.elevation, z1: fl.elevation + doorHeight(p.door) },
        })),
    );
  });
  private readonly doorBounds = computed(() => this.faceDoors().map((d) => d.b));

  /** Doors as drawn: brown leaves (matching the 3D view), garage doors and cased openings as themselves. */
  protected readonly doors = computed(() => {
    const sel = this.pick();
    const ids = sel?.kind === 'door' ? new Set(sel.ids) : new Set<string>();
    const blocked = [...this.faceWindows().map((w) => shapeBounds(w.shape)), ...this.partitions().filter((p) => !p.divider)];
    return this.faceDoors().map(({ id, kind, b }) => ({
      id,
      ...b,
      w: b.u1 - b.u0,
      h: b.z1 - b.z0,
      garage: kind === 'garage',
      opening: kind === 'opening',
      selected: ids.has(id),
      valid: !blocked.some((o) => overlap(o, b)),
    }));
  });

  /**
   * Interior walls meeting this face from inside, on each floor from the ground up:
   * as wide as the wall, from its floor to its ceiling (the roof, on the top floor).
   * Room dividers come too, marked: they bound named rooms but aren't built.
   */
  protected readonly partitions = computed(() => {
    const f = this.face();
    if (!f || f.clerestory) return [];
    const settings = this.store.settings();
    const ti = settings.interiorWallThickness;
    const floors = this.store.floors();
    const along = f.side === 'N' || f.side === 'S';
    const inside = f.coord + (f.side === 'N' || f.side === 'W' ? 1 : -1) * settings.wallThickness;
    const out: { key: string; u0: number; u1: number; z0: number; z1: number; divider: boolean; floor: number }[] = [];
    floors.forEach((fl, i) => {
      if (fl.elevation < 0) return;
      const region = regionOf(this.sections(), settings, fl);
      const next = floors[i + 1];
      for (const g of wallGeoms(fl)) {
        // Walls running into the face (square to it), ending on its inside face on this floor.
        if ((g.axis === 'y') !== along) continue;
        for (const n of [g.a, g.b]) {
          const [u, across] = along ? [n.x, n.y] : [n.y, n.x];
          if (Math.abs(across - inside) > 1e-3 || u < f.from || u > f.to) continue;
          if (!segsAt(region.faces, n.x, n.y).some((seg) => seg.side === f.side)) continue;
          const z1 = next ? next.elevation - STORY.deckThickness : edgeAt(f.top, u);
          out.push({ key: `${fl.id}:${g.wall.id}:${n.id}`, u0: u - ti / 2, u1: u + ti / 2, z0: fl.elevation, z1, divider: !!g.wall.divider, floor: i });
        }
      }
    });
    return out;
  });

  /** Named rooms behind the face, labeled along each floor between the interior walls (screen px). */
  protected readonly roomLabels = computed(() => {
    const f = this.face();
    if (!f || f.clerestory) return [];
    const settings = this.store.settings();
    const t = settings.wallThickness;
    const ti = settings.interiorWallThickness;
    const v = this.view();
    const along = f.side === 'N' || f.side === 'S';
    const probeAcross = f.coord + (f.side === 'N' || f.side === 'W' ? 1 : -1) * (t + 0.75);
    const parts = this.partitions();
    const out: { x: number; y: number; name: string }[] = [];
    this.store.floors().forEach((fl, i) => {
      if (fl.elevation < 0 || !fl.roomNames.length) return;
      const region = regionOf(this.sections(), settings, fl);
      const rooms = findRooms(fl, region, ti);
      const cuts = [f.from + t, ...parts.filter((p) => p.floor === i).map((p) => (p.u0 + p.u1) / 2), f.to - t].sort((a, b) => a - b);
      for (let k = 0; k + 1 < cuts.length; k++) {
        const u = (cuts[k] + cuts[k + 1]) / 2;
        const p = along ? { x: u, y: probeAcross } : { x: probeAcross, y: u };
        const room = rooms.find((r) => pointIn(r.cells, p.x, p.y));
        const name = room && fl.roomNames.find((nm) => pointIn(room.cells, nm.x, nm.y))?.name;
        if (!name) continue;
        const at = worldToScreen(v, this.toWorld([u, fl.elevation + 0.5]));
        out.push({ x: at.x, y: at.y, name });
      }
    });
    return out;
  });

  /** Where each floor's deck crosses the face. */
  /**
   * Levels crossing the face: each upper floor, and the ceiling under it (its deck
   * below it) — the top floor's ceiling is the roof itself.
   */
  protected readonly floorLines = computed(() => {
    const f = this.face();
    if (!f) return [];
    const v = this.view();
    const at = (z: number) => worldToScreen(v, this.toWorld([this.flip() ? f.to : f.from, z]));
    const above = this.store.floors().filter((fl) => fl.elevation >= 0);
    return above.flatMap((fl, i) => {
      const next = above[i + 1];
      const lines: { z: number; label: string; ceiling: boolean; at: Point }[] = [];
      if (i > 0) lines.push({ z: fl.elevation, label: floorLabel(i), ceiling: false, at: at(fl.elevation) });
      if (next) {
        const z = next.elevation - STORY.deckThickness;
        lines.push({ z, label: 'Ceiling', ceiling: true, at: at(z) });
      }
      return lines;
    });
  });

  protected readonly windowViews = computed(() => {
    const f = this.face();
    const sel = this.pick();
    const ids = sel?.kind === 'window' ? new Set(sel.ids) : new Set<string>();
    const all = this.faceWindows();
    return all.map((w) => {
      const lines = windowLines(w);
      return {
        id: w.id,
        points: pathOf(shapeOutline(w.shape)),
        bars: lines.bars.map(([a, b]) => ({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] })),
        hinge: lines.hinge.map(([a, b]) => ({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] })),
        sash: w.style === 'double-hung' ? sashOf(w.shape) : null,
        selected: ids.has(w.id),
        valid: windowFits(w.shape, f, this.blockedFor(w.id)),
      };
    });
  });

  // ------------------------------------------------------------------ snapping

  /**
   * What windows on this face snap to, leaving out the ones being edited (`skip`):
   * the other windows and doors here, floor levels, sill and door-head heights,
   * windows' heights on other faces, the roof clearances and sizes in use.
   */
  private snapScene(skip: ReadonlySet<string>): SnapScene | null {
    const f = this.face();
    if (!f) return null;
    const faces = this.faces();
    const others = this.store.windows().filter((w) => !skip.has(w.id));
    const here = this.faceWindows().filter((w) => !skip.has(w.id));
    const items: SceneItem[] = [
      ...here.map((w): SceneItem => ({ kind: 'window', b: shapeBounds(w.shape) })),
      ...this.faceDoors()
        .filter((d) => !skip.has(d.id))
        .map((d): SceneItem => ({ kind: 'door', b: d.b })),
      ...this.partitions().map((p): SceneItem => ({ kind: 'partition', b: p })),
    ];
    const levels = this.store.floors().filter((fl) => fl.elevation >= 0);
    const floors = levels.map((fl) => fl.elevation);
    const ceilings = levels.slice(1).map((fl) => fl.elevation - STORY.deckThickness);
    const heights = [
      ...floors.flatMap((z) => [z + 2, z + 3].map((h) => ({ z: h, weight: 0.85 }))),
      ...floors.map((z) => ({ z: z + 6 + 8 / 12, weight: 0.9 })),
      ...others.filter((w) => !here.includes(w)).flatMap((w) => {
        const b = shapeBounds(w.shape);
        return [b.z0, b.z1].map((z) => ({ z, weight: 0.85 }));
      }),
    ];
    const clearances = others.flatMap((w) => {
      const wf = faceAt(faces, w.host, (shapeBounds(w.shape).u0 + shapeBounds(w.shape).u1) / 2);
      const c = wf ? roofClearance(wf, shapeOutline(w.shape)) : NaN;
      return c > 1e-3 && c < 6 ? [c] : [];
    });
    const sizes = { w: others.map((w) => shapeBounds(w.shape)).map((b) => b.u1 - b.u0), h: others.map((w) => shapeBounds(w.shape)).map((b) => b.z1 - b.z0) };
    const wall = this.store.settings().wallThickness;
    return buildScene(f, items, { wall, floors, ceilings, heights, clearances: uniq(clearances), sizes: { w: uniq(sizes.w), h: uniq(sizes.h) } });
  }

  /** One edge of a window being resized or drawn, snapped (or on whole inches, with Alt). */
  private snapEdgeTo(skip: ReadonlySet<string>, b: Bounds, edge: Edge, v: number, roof?: number): { v: number; guides: Guide[] } {
    const scene = this.alt() ? null : this.snapScene(skip);
    return scene ? snapEdge(scene, b, edge, v, SNAP_PX / this.view().scale, roof) : { v: snapTo(v, GRID), guides: [] };
  }

  /** Roof height a window's top edge is measured against: over its middle, or its lower top corner. */
  private roofOver(b: Bounds, middle: boolean): number | undefined {
    const f = this.face();
    if (!f) return undefined;
    return middle ? edgeAt(f.top, (b.u0 + b.u1) / 2) : Math.min(edgeAt(f.top, b.u0), edgeAt(f.top, b.u1));
  }

  /** The snap guides on screen: lines across the view, and dimensions with their lengths. */
  protected readonly guideViews = computed(() => {
    const v = this.view();
    const size = this.size();
    const at = (u: number, z: number) => worldToScreen(v, this.toWorld([u, z]));
    const seen = new Set<string>();
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const dims: { x1: number; y1: number; x2: number; y2: number; ticks: { x1: number; y1: number; x2: number; y2: number }[]; label: { x: number; y: number; text: string } }[] = [];
    for (const g of this.guides()) {
      if (g.t === 'line') {
        const key = `${g.axis}${g.at.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (g.axis === 'u') {
          const x = at(g.at, 0).x;
          lines.push({ x1: x, y1: 0, x2: x, y2: size.y });
        } else {
          const y = at(0, g.at).y;
          lines.push({ x1: 0, y1: y, x2: size.x, y2: y });
        }
        continue;
      }
      if (g.to - g.from < 1e-4) continue;
      const [a, b] = g.axis === 'u' ? [at(g.from, g.at), at(g.to, g.at)] : [at(g.at, g.from), at(g.at, g.to)];
      const tick = (p: Point) => (g.axis === 'u' ? { x1: p.x, y1: p.y - 5, x2: p.x, y2: p.y + 5 } : { x1: p.x - 5, y1: p.y, x2: p.x + 5, y2: p.y });
      dims.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, ticks: [tick(a), tick(b)], label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: this.inches(g.to - g.from) } });
    }
    return { lines, dims };
  });

  // ------------------------------------------------------------------ the roof

  protected readonly roofSections = computed(() =>
    this.sections().map((s) => ({
      id: s.id,
      x: x0(s.rect),
      y: y0(s.rect),
      w: s.rect.w,
      d: s.rect.d,
      patio: s.patio.enabled,
      arrow: slopeArrow(s.roof.slopeDir, x0(s.rect), y0(s.rect), x1(s.rect), y1(s.rect)),
    })),
  );

  protected readonly skylightViews = computed(() => {
    const sel = this.pick();
    const ids = sel?.kind === 'skylight' ? new Set(sel.ids) : new Set<string>();
    return this.store.skylights().map((k) => ({ ...k, selected: ids.has(k.id), valid: this.skylightFits(k) }));
  });

  // ------------------------------------------------------------------ view

  /** World (the viewport's plane) ↔ face [u, z]: x = ±u, y = −z. On the roof, plan x, y. */
  private toWorld([u, z]: UZ): Point {
    return this.roof() ? { x: u, y: z } : { x: this.flip() ? -u : u, y: -z };
  }
  private fromWorld(p: Point): UZ {
    return this.roof() ? [p.x, p.y] : [this.flip() ? -p.x : p.x, -p.y];
  }

  protected readonly worldTransform = computed(() => {
    const v = this.view();
    const base = `translate(${v.tx} ${v.ty}) scale(${v.scale})`;
    return this.roof() ? base : `${base} scale(${this.flip() ? -1 : 1} -1)`;
  });

  protected readonly grid = computed(() => {
    const { scale, tx, ty } = this.view();
    const minorFt = scale >= 8 ? 1 : 5;
    const majorFt = scale >= 4 ? 10 : 50;
    return { minor: minorFt * scale, major: majorFt * scale, offsetX: tx, offsetY: ty };
  });

  protected readonly faceShape = computed(() => {
    const f = this.face();
    return f ? pathOf(faceOutline(f)) : '';
  });
  /**
   * Roofs meeting the face from below (a patio's, or the lower roof under a
   * clerestory), drawn as their slab where it meets the wall: top surface to underside.
   */
  protected readonly lowerRoofs = computed(
    () => this.face()?.lower.map(({ line, thickness }) => pathOf([...line, ...[...line].reverse().map(([u, z]): UZ => [u, z - thickness])])) ?? [],
  );

  protected readonly groundBand = computed(() => {
    const f = this.face();
    return f && !f.clerestory ? { u: f.from - 200, w: f.to - f.from + 400 } : null;
  });
  protected readonly hatch = computed(() => ({ size: 9 / this.view().scale, stroke: 1.4 / this.view().scale }));

  /** Content bounds in world units, for fitting. */
  private readonly contentBounds = computed(() => {
    if (this.roof()) {
      const s = this.sections();
      if (!s.length) return null;
      const xs = s.flatMap((e) => [x0(e.rect), x1(e.rect)]);
      const ys = s.flatMap((e) => [y0(e.rect), y1(e.rect)]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) };
    }
    const f = this.face();
    if (!f) return null;
    const zs = [...f.top, ...f.bottom].map((p) => p[1]);
    const a = this.toWorld([f.from, Math.max(...zs)]);
    const b = this.toWorld([f.to, Math.min(...zs)]);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), d: Math.abs(b.y - a.y) };
  });

  // ------------------------------------------------------------------ previews

  protected readonly draft = computed(() => {
    const it = this.interaction();
    const c = this.cursor();
    if (this.tool() === 'poly') {
      const pts = this.polyPts();
      if (!pts.length) return null;
      const end = c ? this.polyPoint(c) : null;
      return { kind: 'poly' as const, path: pathOf(end ? [...pts, end] : pts, false), pts, valid: true };
    }
    let shape: WindowShape | null = null;
    if (it.mode === 'draw') shape = this.shapeFromDrag(it.from, it.to);
    else if (it.mode === 'idle' && this.tool() === 'rect' && this.preset() && c && !this.roof()) shape = this.presetAt(c);
    if (!shape) return null;
    if (this.roof()) {
      const b = shapeBounds(shape);
      const k = { id: '', x0: b.u0, x1: b.u1, y0: b.z0, y1: b.z1 };
      return { kind: 'shape' as const, path: pathOf(shapeOutline(shape)), pts: [], valid: this.skylightFits(k) };
    }
    return { kind: 'shape' as const, path: pathOf(shapeOutline(shape)), pts: [], valid: windowFits(shape, this.face(), this.blockedFor('')) };
  });

  /** Resize handles for a single selected window or skylight (world units: [u, z] on a face). */
  protected readonly handles = computed(() => {
    const sel = this.pick();
    if (!sel || sel.ids.length !== 1 || this.tool() !== 'select') return [];
    const shape = this.shapeOf(sel.ids[0]);
    if (!shape) return [];
    const r = 4.5 / this.view().scale;
    return handlesOf(shape).map((h) => ({ ...h, r }));
  });

  /** Size readout for the selection (screen px). */
  protected readonly selBar = computed(() => {
    const sel = this.pick();
    if (!sel || ['move', 'resize', 'slide'].includes(this.interaction().mode)) return null;
    if (sel.kind === 'door') return this.doorBar(sel.ids[0]);
    const shapes = sel.ids.map((id) => this.shapeOf(id)).filter((s): s is WindowShape => !!s);
    if (!shapes.length) return null;
    const bs = shapes.map(shapeBounds);
    const b = { u0: Math.min(...bs.map((x) => x.u0)), u1: Math.max(...bs.map((x) => x.u1)), z0: Math.min(...bs.map((x) => x.z0)), z1: Math.max(...bs.map((x) => x.z1)) };
    const v = this.view();
    const corners = [this.toWorld([b.u0, b.z0]), this.toWorld([b.u1, b.z1])].map((p) => worldToScreen(v, p));
    const x = (corners[0].x + corners[1].x) / 2;
    const y = Math.max(54, Math.min(corners[0].y, corners[1].y) - 10);
    const w = sel.kind === 'window' && sel.ids.length === 1 ? this.store.windows().find((o) => o.id === sel.ids[0]) : undefined;
    const dims = `${this.inches(b.u1 - b.u0)} × ${this.inches(b.z1 - b.z0)}`;
    const title =
      sel.ids.length > 1
        ? `${sel.ids.length} ${sel.kind === 'window' ? 'windows' : 'skylights'}`
        : sel.kind === 'skylight'
          ? `Skylight · ${dims}`
          : `${SHAPE_NAME[shapes[0].t]} · ${dims}${b.z0 > 0 ? ` · sill ${formatFeet(b.z0)}` : ''}`;
    const f = this.face();
    const s = w?.shape;
    const lowerRoof = s?.t === 'roofline' && !!f && !!lowerRoofAt(f, s.u + s.w / 2);
    return { x, y, title, window: w ?? null, lowerRoof, door: false };
  });

  /** The selection bar over a door: what it is, and how far it is from the wall's corners. */
  private doorBar(id: string) {
    const d = this.faceDoors().find((x) => x.id === id);
    const f = this.face();
    if (!d || !f) return null;
    const v = this.view();
    const corners = [this.toWorld([d.b.u0, d.b.z0]), this.toWorld([d.b.u1, d.b.z1])].map((p) => worldToScreen(v, p));
    const x = (corners[0].x + corners[1].x) / 2;
    const y = Math.max(54, Math.min(corners[0].y, corners[1].y) - 10);
    const title = `${DOOR_NAME[d.kind]} · ${this.inches(d.width)} wide · drag to slide`;
    return { x, y, title, window: null, lowerRoof: false, door: true };
  }

  protected readonly cursorStyle = computed(() => {
    const it = this.interaction();
    if (it.mode === 'pan' || it.mode === 'move' || it.mode === 'slide') return 'grabbing';
    if (this.tool() !== 'select') return 'crosshair';
    const c = this.cursor();
    if (it.mode === 'idle' && c && this.hitAt(c)?.kind === 'door') return 'ew-resize';
    return 'default';
  });

  protected readonly tools = computed(() => (this.roof() ? TOOLS.filter((t) => t.id === 'select' || t.id === 'rect') : TOOLS));

  protected readonly hint = computed(() => {
    if (this.roof()) return 'Drag a rectangle over a roof to add a skylight · Select to move or resize · Del or right-click deletes';
    switch (this.tool()) {
      case 'select':
        return 'Click a window to select it (Shift adds) · Drag to move, handles to resize (Shift squares a shape’s corner up with its neighbors) · Drag a door to slide it · Del or right-click deletes · Ctrl+D duplicates · PgUp/PgDn: other walls';
      case 'rect':
        return this.preset() ? 'Click to place · snaps to other windows, door heads and floors · Esc: Select' : 'Drag a window · snaps to other windows, door heads and floors · Alt: inches only';
      case 'circle':
        return 'Drag from the center out';
      case 'arch':
        return 'Drag the window, round top included';
      case 'poly':
        return 'Click each corner · Backspace or right-click undoes one · click the first corner, Enter or double-click to finish · Esc cancels';
      case 'roofline':
        return 'Drag a window; its top runs at the roof’s pitch · Drag its edges to resize';
    }
  });

  constructor() {
    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const first = this.size().x === 0;
      this.size.set({ x: width, y: height });
      if (first) this.fit();
    });
    afterNextRender(() => resize.observe(this.canvas().nativeElement));
    inject(DestroyRef).onDestroy(() => resize.disconnect());

    // A different face: frame it, and drop what was going on.
    effect(() => {
      this.face();
      this.roof();
      untracked(() => {
        this.pick.set(null);
        this.polyPts.set([]);
        this.interaction.set({ mode: 'idle' });
        if (this.roof() && !['select', 'rect'].includes(this.tool())) this.tool.set('select');
        this.fit();
      });
    });
    // Selections can vanish (undo); drop them.
    effect(() => {
      const sel = this.pick();
      const gone = (id: string) => (sel?.kind === 'door' ? !this.faceDoors().some((d) => d.id === id) : !this.shapeOf(id));
      if (sel && sel.ids.some(gone)) untracked(() => this.pick.set(null));
    });
  }

  // ------------------------------------------------------------------ commands

  fit(): void {
    if (this.size().x === 0) return;
    this.view.set(fitViewport(this.size(), this.contentBounds(), 60));
  }

  protected zoomBy(factor: number): void {
    const s = this.size();
    this.view.set(zoomAt(this.view(), { x: s.x / 2, y: s.y / 2 }, factor));
  }

  protected chooseFace(key: string): void {
    this.editor.windowFace.set(key);
  }

  protected stepFace(by: number): void {
    const faces = this.faces();
    if (!faces.length) return;
    const i = this.roof() ? (by > 0 ? -1 : 0) : this.faceIndex();
    this.chooseFace(faces[(i + by + faces.length) % faces.length].key);
  }

  protected setTool(t: WindowTool): void {
    if (this.roof() && t !== 'select' && t !== 'rect') return;
    this.tool.set(t);
    this.polyPts.set([]);
    if (t !== 'select') this.pick.set(null);
  }

  protected choosePreset(value: string): void {
    const p = WINDOW_PRESETS[+value];
    this.preset.set(p ?? null);
    this.setTool('rect');
  }

  protected setStyle(style: WindowStyle): void {
    this.editWindows((w) => ({ ...w, style }));
  }

  protected setGrille(axis: 'cols' | 'rows', by: number): void {
    this.editWindows((w) => ({ ...w, grille: { ...w.grille, [axis]: Math.min(12, Math.max(1, w.grille[axis] + by)) } }));
  }

  protected deleteSelection(): void {
    const sel = this.pick();
    if (sel && sel.kind !== 'door') this.delete(sel.ids); // doors are removed in Floorplan
  }

  /** Deletes windows (or, on the roof, skylights), dropping them from the selection. */
  private delete(list: readonly string[]): void {
    const ids = new Set(list);
    if (this.roof()) this.store.updateSkylights((ks) => ks.filter((k) => !ids.has(k.id)));
    else this.store.updateWindows((ws) => ws.filter((w) => !ids.has(w.id)));
    const sel = this.pick();
    const left = sel?.ids.filter((id) => !ids.has(id)) ?? [];
    this.pick.set(sel && left.length ? { ...sel, ids: left } : null);
  }

  /** Roofline windows: whether the bottom follows the lower roof under the window. */
  protected setFollowLower(on: boolean): void {
    const faces = this.faces();
    this.editWindows((w) => (w.shape.t === 'roofline' ? syncRooflines([{ ...w, shape: { ...w.shape, lower: on } }], faces)[0] : w));
  }

  /** Copies the selection a foot over (or down, on the roof). */
  protected duplicateSelection(): void {
    const sel = this.pick();
    if (!sel || sel.kind === 'door') return;
    const ids = new Set(sel.ids);
    if (sel.kind === 'window') {
      const copies = this.store
        .windows()
        .filter((w) => ids.has(w.id))
        .map((w): HouseWindow => {
          const b = shapeBounds(w.shape);
          return { ...w, id: newId(), shape: moveShape(w.shape, b.u1 - b.u0 + 1, 0) };
        });
      this.store.updateWindows((ws) => [...ws, ...copies]);
      this.pick.set({ kind: 'window', ids: copies.map((c) => c.id) });
    } else {
      const copies = this.store
        .skylights()
        .filter((k) => ids.has(k.id))
        .map((k): Skylight => ({ ...k, id: newId(), x0: k.x0 + 1, x1: k.x1 + 1, y0: k.y0 + 1, y1: k.y1 + 1 }));
      this.store.updateSkylights((ks) => [...ks, ...copies]);
      this.pick.set({ kind: 'skylight', ids: copies.map((c) => c.id) });
    }
  }

  // ------------------------------------------------------------------ pointer input

  protected onCanvasDown(e: PointerEvent): void {
    if (isFromUi(e)) return;
    const p = this.localPoint(e);
    const w = this.fromWorld(screenToWorld(this.view(), p));
    this.cursor.set(w);
    this.alt.set(e.altKey);
    this.shift.set(e.shiftKey);
    if (e.button === 1) return this.startPan(e, p);
    // Right-click takes back a shape's last corner while drawing one, else deletes what's under it.
    if (e.button === 2) {
      if (this.polyPts().length) this.polyPts.update((pts) => pts.slice(0, -1));
      else {
        const hit = this.hitAt(w);
        if (hit && hit.kind !== 'door') this.delete([hit.id]);
      }
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();

    switch (this.tool()) {
      case 'select': {
        const handle = this.handleAt(w);
        if (handle) {
          this.capture(e);
          this.interaction.set({ mode: 'press', pointerId: e.pointerId, start: p, id: handle.id, handle: handle.handle });
          return;
        }
        const hit = this.hitAt(w);
        if (!hit) {
          if (!e.shiftKey) this.pick.set(null);
          return this.startPan(e, p);
        }
        const { kind, id } = hit;
        const sel = this.pick();
        if (kind === 'door') {
          this.pick.set({ kind, ids: [id] });
        } else if (e.shiftKey) {
          const ids = sel?.kind === kind ? sel.ids : [];
          this.pick.set({ kind, ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] });
        } else if (!(sel?.kind === kind && sel.ids.includes(id))) {
          this.pick.set({ kind, ids: [id] });
        }
        this.capture(e);
        this.interaction.set({ mode: 'press', pointerId: e.pointerId, start: p, id, handle: null });
        return;
      }
      case 'poly': {
        const pts = this.polyPts();
        const q = this.polyPoint(w);
        // Clicking the first corner again closes the shape.
        if (pts.length >= 3 && this.near(q, pts[0])) return this.finishPoly();
        this.polyPts.set([...pts, q]);
        return;
      }
      default: {
        // A preset size goes in with a click; anything else (and skylights) is dragged out.
        if (this.tool() === 'rect' && this.preset() && !this.roof()) {
          this.addWindow(this.presetAt(w));
          return;
        }
        this.capture(e);
        const from = this.snapPoint(w);
        this.interaction.set({ mode: 'draw', pointerId: e.pointerId, from, to: from });
      }
    }
  }

  protected onPointerMove(e: PointerEvent): void {
    const p = this.localPoint(e);
    const w = this.fromWorld(screenToWorld(this.view(), p));
    this.cursor.set(w);
    this.alt.set(e.altKey);
    this.shift.set(e.shiftKey);
    const it = this.interaction();
    switch (it.mode) {
      case 'pan': {
        const v = it.startView;
        const moved = it.moved || Math.hypot(p.x - it.start.x, p.y - it.start.y) >= DRAG_START_THRESHOLD_PX;
        this.interaction.set({ ...it, moved });
        this.view.set({ ...v, tx: v.tx + p.x - it.start.x, ty: v.ty + p.y - it.start.y });
        return;
      }
      case 'press': {
        if (Math.hypot(p.x - it.start.x, p.y - it.start.y) < DRAG_START_THRESHOLD_PX) return;
        const door = this.pick()?.kind === 'door' ? this.faceDoors().find((d) => d.id === it.id) : undefined;
        if (door) {
          this.store.beginGesture();
          const start = this.fromWorld(screenToWorld(this.view(), it.start));
          this.interaction.set({ mode: 'slide', pointerId: it.pointerId, start, door });
          this.onPointerMove(e);
          return;
        }
        this.store.beginGesture();
        const base = this.shapeOf(it.id);
        if (it.handle !== null && base) {
          this.interaction.set({ mode: 'resize', pointerId: it.pointerId, id: it.id, handle: it.handle, base: this.recordOf(it.id)! });
        } else {
          const ids = this.pick()?.ids ?? [it.id];
          const start = this.fromWorld(screenToWorld(this.view(), it.start));
          this.interaction.set({ mode: 'move', pointerId: it.pointerId, start, ids, base: new Map(ids.map((id) => [id, this.recordOf(id)!])) });
        }
        this.onPointerMove(e);
        return;
      }
      case 'move':
        this.applyMove(it, w);
        return;
      case 'resize':
        this.applyResize(it, w);
        return;
      case 'slide':
        this.applySlide(it, w);
        return;
      case 'draw':
        this.interaction.set({ ...it, to: this.roof() ? this.snapPoint(w) : this.snapDrawCorner(it.from, w) });
        return;
    }
  }

  protected onPointerUp(e: PointerEvent): void {
    const it = this.interaction();
    if (it.mode === 'idle' || it.pointerId !== e.pointerId) return;
    this.interaction.set({ mode: 'idle' });
    this.guides.set([]);
    switch (it.mode) {
      case 'pan':
        if (!it.moved && this.tool() === 'select') this.pick.set(null);
        break;
      case 'move':
      case 'resize':
      case 'slide':
        this.store.endGesture();
        break;
      case 'draw': {
        const shape = this.shapeFromDrag(it.from, it.to);
        if (!shape) break;
        if (this.roof()) {
          const b = shapeBounds(shape);
          const k: Skylight = { id: newId(), x0: b.u0, x1: b.u1, y0: b.z0, y1: b.z1 };
          if (b.u1 - b.u0 >= 1 && b.z1 - b.z0 >= 1) {
            this.store.updateSkylights((ks) => [...ks, k]);
            this.pick.set({ kind: 'skylight', ids: [k.id] });
          }
        } else {
          this.addWindow(shape);
        }
        break;
      }
    }
  }

  protected onDoubleClick(e: MouseEvent): void {
    if (isFromUi(e)) return;
    if (this.tool() === 'poly') this.finishPoly();
  }

  protected onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED * (e.deltaMode === 1 ? 16 : 1));
    this.view.set(zoomAt(this.view(), this.localPoint(e), factor));
  }

  protected onPointerLeave(): void {
    if (this.interaction().mode === 'idle' && !this.polyPts().length) this.cursor.set(null);
  }

  // ------------------------------------------------------------------ keyboard

  protected onKeyDown(e: KeyboardEvent): void {
    this.alt.set(e.altKey);
    this.shift.set(e.shiftKey);
    if (e.target instanceof HTMLSelectElement && [' ', 'Escape'].includes(e.key)) e.target.blur();
    else if (isTyping(e)) return;
    if (e.metaKey || (e.ctrlKey && e.key.toLowerCase() !== 'd')) return;
    switch (e.key) {
      case ' ':
      case 'm':
      case 'M':
        this.setTool('select');
        break;
      case 'r':
      case 'R':
        this.setTool('rect');
        break;
      case 'c':
      case 'C':
        this.setTool('circle');
        break;
      case 'a':
      case 'A':
        this.setTool('arch');
        break;
      case 'p':
      case 'P':
        this.setTool('poly');
        break;
      case 'l':
      case 'L':
        this.setTool('roofline');
        break;
      case 'Enter':
        this.finishPoly();
        break;
      case 'Backspace':
        if (this.polyPts().length) this.polyPts.update((pts) => pts.slice(0, -1));
        else this.deleteSelection();
        break;
      case 'Delete':
        this.deleteSelection();
        break;
      case 'd':
      case 'D':
        if (e.ctrlKey) this.duplicateSelection();
        else return;
        break;
      case 'Escape':
      case 'q':
      case 'Q':
        if (this.polyPts().length) this.polyPts.set([]);
        else if (this.pick()) this.pick.set(null);
        else this.setTool('select');
        break;
      case 'PageUp':
      case 'PageDown':
        this.stepFace(e.key === 'PageDown' ? 1 : -1);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // ------------------------------------------------------------------ internals

  private shapeOf(id: string): WindowShape | null {
    if (this.roof()) {
      const k = this.store.skylights().find((x) => x.id === id);
      return k ? { t: 'rect', u: k.x0, z: k.y0, w: k.x1 - k.x0, h: k.y1 - k.y0 } : null;
    }
    return this.store.windows().find((x) => x.id === id)?.shape ?? null;
  }

  private recordOf(id: string): WindowShape | Skylight | null {
    return this.roof() ? (this.store.skylights().find((x) => x.id === id) ?? null) : this.shapeOf(id);
  }

  /** Things a window on this face must stay clear of: doors and the other windows. */
  private blockedFor(id: string): Bounds[] {
    // Interior walls butt into the exterior wall, so a window can't sit where one meets it.
    const walls = this.partitions().filter((p) => !p.divider);
    return [...this.doorBounds(), ...walls, ...this.faceWindows().filter((w) => w.id !== id).map((w) => shapeBounds(w.shape))];
  }

  private skylightFits(k: Pick<Skylight, 'x0' | 'x1' | 'y0' | 'y1'>): boolean {
    const [cx, cy] = [(k.x0 + k.x1) / 2, (k.y0 + k.y1) / 2];
    const s = this.sections().find((e) => cx > x0(e.rect) && cx < x1(e.rect) && cy > y0(e.rect) && cy < y1(e.rect));
    return !!s && k.x0 >= x0(s.rect) - 1e-6 && k.x1 <= x1(s.rect) + 1e-6 && k.y0 >= y0(s.rect) - 1e-6 && k.y1 <= y1(s.rect) + 1e-6;
  }

  private addWindow(shape: WindowShape | null): void {
    const f = this.face();
    if (!shape || !f) return;
    const w: HouseWindow = { id: newId(), host: { side: f.side, coord: f.coord }, shape, style: 'fixed', grille: { cols: 1, rows: 1 } };
    this.store.updateWindows((ws) => [...ws, w]);
    this.pick.set({ kind: 'window', ids: [w.id] });
  }

  private editWindows(fn: (w: HouseWindow) => HouseWindow): void {
    const sel = this.pick();
    if (sel?.kind !== 'window') return;
    const ids = new Set(sel.ids);
    this.store.updateWindows((ws) => ws.map((w) => (ids.has(w.id) ? fn(w) : w)));
  }

  private finishPoly(): void {
    const pts = this.polyPts();
    this.polyPts.set([]);
    if (pts.length < 3) return;
    this.addWindow({ t: 'poly', pts: pts.map(([u, z]): [number, number] => [u, z]) });
  }

  /** The shape a drag from `a` to `b` draws with the current tool. */
  private shapeFromDrag(a: UZ, b: UZ): WindowShape | null {
    const [u0, u1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [z0, z1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    switch (this.roof() ? 'rect' : this.tool()) {
      case 'circle': {
        const r = snapTo(Math.hypot(b[0] - a[0], b[1] - a[1]), GRID);
        return r >= MIN_WINDOW / 2 ? { t: 'circle', u: a[0], z: a[1], r } : null;
      }
      case 'arch': {
        const w = u1 - u0;
        return w >= MIN_WINDOW ? { t: 'arch', u: u0, z: z0, w, h: Math.max(w / 2, z1 - z0) } : null;
      }
      case 'roofline': {
        // The top runs at the roof's pitch, through the drag's top at its middle.
        const f = this.face();
        const w = u1 - u0;
        const top = f ? slopeAt(f.top, (u0 + u1) / 2) : 0;
        const h = z1 - z0 - (top * w) / 2;
        const shape: WindowShape = { t: 'roofline', u: u0, z: z0, w, h, top, bottom: 0, lower: false };
        return w >= MIN_WINDOW && Math.min(h, h + top * w) >= MIN_WINDOW ? shape : null;
      }
      default:
        return u1 - u0 >= MIN_WINDOW && z1 - z0 >= MIN_WINDOW ? { t: 'rect', u: u0, z: z0, w: u1 - u0, h: z1 - z0 } : null;
    }
  }

  /** A preset-size window centered at the pointer, its edges snapped. */
  private presetAt(c: UZ): WindowShape | null {
    const p = this.preset();
    if (!p) return null;
    const [w, h] = [p[0] * IN, p[1] * IN];
    const u0 = this.snapEdges(c[0] - w / 2, w, 'u');
    const z0 = this.snapEdges(c[1] - h / 2, h, 'z');
    return { t: 'rect', u: u0, z: z0, w, h };
  }

  /**
   * The corner being dragged out for a new window, snapped like resizing: its edges
   * line up, match other windows' sizes and gaps, center between neighbors, keep the
   * usual clearance under the roof. (A circle's rim, for its radius.)
   */
  private snapDrawCorner(from: UZ, w: UZ): UZ {
    const none = new Set<string>();
    if (this.tool() === 'circle') {
      const r = Math.hypot(w[0] - from[0], w[1] - from[1]);
      const b = { u0: from[0] - r, u1: from[0] + r, z0: from[1] - r, z1: from[1] + r };
      const s = this.snapEdgeTo(none, b, 'u1', from[0] + r);
      this.guides.set(s.guides);
      return [s.v, from[1]];
    }
    const b = { u0: Math.min(from[0], w[0]), u1: Math.max(from[0], w[0]), z0: Math.min(from[1], w[1]), z1: Math.max(from[1], w[1]) };
    const su = this.snapEdgeTo(none, b, w[0] >= from[0] ? 'u1' : 'u0', w[0]);
    const bu = w[0] >= from[0] ? { ...b, u1: su.v } : { ...b, u0: su.v };
    const up = w[1] >= from[1];
    const sz = this.snapEdgeTo(none, bu, up ? 'z1' : 'z0', w[1], up ? this.roofOver(bu, this.tool() !== 'rect') : undefined);
    this.guides.set([...su.guides, ...sz.guides]);
    return [su.v, sz.v];
  }

  /** Lines windows line up with on this face: other windows' edges, doors, floors and door-head height. */
  private snapLines(axis: 'u' | 'z', skip: ReadonlySet<string> = new Set()): number[] {
    if (this.roof()) {
      return this.sections().flatMap((s) => (axis === 'u' ? [x0(s.rect), x1(s.rect)] : [y0(s.rect), y1(s.rect)]));
    }
    const f = this.face();
    const others = this.faceWindows()
      .filter((w) => !skip.has(w.id))
      .map((w) => shapeBounds(w.shape));
    const doors = this.doorBounds();
    if (axis === 'u') {
      return [...others.flatMap((b) => [b.u0, b.u1, (b.u0 + b.u1) / 2]), ...doors.flatMap((b) => [b.u0, b.u1]), ...(f ? [(f.from + f.to) / 2] : [])];
    }
    const floors = this.store.floors().filter((fl) => fl.elevation >= 0);
    return [
      ...others.flatMap((b) => [b.z0, b.z1]),
      ...doors.map((b) => b.z1),
      ...floors.flatMap((fl) => [fl.elevation, fl.elevation + 6 + 8 / 12, fl.elevation + 3]),
    ];
  }

  private snapCoord(v: number, axis: 'u' | 'z', skip?: ReadonlySet<string>): number {
    let best = snapTo(v, GRID);
    if (this.alt()) return best;
    let dist = SNAP_PX / this.view().scale;
    for (const c of this.snapLines(axis, skip)) {
      if (Math.abs(c - v) < dist) [best, dist] = [c, Math.abs(c - v)];
    }
    return best;
  }

  private snapPoint([u, z]: UZ): UZ {
    return [this.snapCoord(u, 'u'), this.snapCoord(z, 'z')];
  }

  /** Where something `size` long starting near `start` should start, so one of its edges lines up. */
  private snapEdges(start: number, size: number, axis: 'u' | 'z', skip?: ReadonlySet<string>): number {
    let best = snapTo(start, GRID);
    if (this.alt()) return best;
    let dist = SNAP_PX / this.view().scale;
    for (const c of this.snapLines(axis, skip)) {
      for (const [edge, off] of [
        [start, 0],
        [start + size, size],
        [start + size / 2, size / 2],
      ]) {
        if (Math.abs(c - edge) < dist) [best, dist] = [c - off, Math.abs(c - edge)];
      }
    }
    return best;
  }

  /** The next corner of a free shape: angle snapped from the last one (unless Alt), on whole inches. */
  private polyPoint(w: UZ): UZ {
    const pts = this.polyPts();
    const last = pts.at(-1);
    if (!last || this.alt()) return this.snapPoint(w);
    if (pts.length >= 3 && this.near(w, pts[0])) return pts[0];
    const [du, dz] = [w[0] - last[0], w[1] - last[1]];
    const len = snapTo(Math.hypot(du, dz), GRID);
    const a = Math.round(Math.atan2(dz, du) / ANGLE_STEP) * ANGLE_STEP;
    const p: UZ = [last[0] + len * Math.cos(a), last[1] + len * Math.sin(a)];
    // Square angles land on whole inches, and on the lines things line up with.
    if (Math.abs(Math.sin(a)) < 1e-9) p[1] = last[1];
    if (Math.abs(Math.cos(a)) < 1e-9) p[0] = last[0];
    if (Math.abs(Math.sin(a)) < 1e-9) p[0] = this.snapCoord(p[0], 'u');
    if (Math.abs(Math.cos(a)) < 1e-9) p[1] = this.snapCoord(p[1], 'z');
    return [round4(p[0]), round4(p[1])];
  }

  private near(a: UZ, b: UZ): boolean {
    return Math.hypot(a[0] - b[0], a[1] - b[1]) <= (HIT_PX * 1.5) / this.view().scale;
  }

  private applyMove(it: Extract<Interaction, { mode: 'move' }>, w: UZ): void {
    const skip = new Set(it.ids);
    if (!this.roof()) {
      // Windows: the dragged ones together, snapped by the scene's rules.
      const [ru, rz] = [w[0] - it.start[0], w[1] - it.start[1]];
      const pts = [...it.base.values()].flatMap((o) => shapeOutline(moveShape(o as WindowShape, ru, rz)));
      const scene = this.alt() ? null : this.snapScene(skip);
      const snap = scene ? snapMove(scene, pts, SNAP_PX / this.view().scale) : null;
      const b = shapeBounds(it.base.get(it.ids[0]) as WindowShape);
      const du = snap ? ru + snap.du : snapTo(b.u0 + ru, GRID) - b.u0;
      const dz = snap ? rz + snap.dz : snapTo(b.z0 + rz, GRID) - b.z0;
      this.guides.set(snap?.guides ?? []);
      this.store.updateWindows((ws) =>
        ws.map((x) => {
          const o = it.base.get(x.id) as WindowShape | undefined;
          return o ? { ...x, shape: moveShape(o, du, dz) } : x;
        }),
      );
      return;
    }
    const first = it.base.get(it.ids[0])!;
    const b = 'x0' in first ? { u0: first.x0, u1: first.x1, z0: first.y0, z1: first.y1 } : shapeBounds(first);
    const du = this.snapEdges(b.u0 + w[0] - it.start[0], b.u1 - b.u0, 'u', skip) - b.u0;
    const dz = this.snapEdges(b.z0 + w[1] - it.start[1], b.z1 - b.z0, 'z', skip) - b.z0;
    if (this.roof()) {
      this.store.updateSkylights((ks) =>
        ks.map((k) => {
          const o = it.base.get(k.id) as Skylight | undefined;
          return o ? { ...k, x0: o.x0 + du, x1: o.x1 + du, y0: o.y0 + dz, y1: o.y1 + dz } : k;
        }),
      );
    } else {
      this.store.updateWindows((ws) =>
        ws.map((x) => {
          const o = it.base.get(x.id) as WindowShape | undefined;
          return o ? { ...x, shape: moveShape(o, du, dz) } : x;
        }),
      );
    }
  }

  /**
   * Slides a door along its wall: snapped sideways like a window (Alt: whole inches
   * only), kept within its run of wall and off the interior walls meeting it (it
   * hops to whichever side is nearer), and saved on its floor, so the floor plan
   * and the 3D view follow.
   */
  private applySlide(it: Extract<Interaction, { mode: 'slide' }>, w: UZ): void {
    const { door } = it;
    const ru = w[0] - it.start[0];
    const b = { ...door.b, u0: door.b.u0 + ru, u1: door.b.u1 + ru };
    const scene = this.alt() ? null : this.snapScene(new Set([door.id]));
    const snap = scene ? snapSlide(scene, b, SNAP_PX / this.view().scale) : { du: snapTo(b.u0, GRID) - b.u0, guides: [] };
    const want = (b.u0 + b.u1) / 2 + snap.du;
    const half = door.width / 2;
    const walls = this.partitions().filter((p) => !p.divider && overlap(p, { ...door.b, u0: p.u0, u1: p.u1 }));
    const hits = (at: number) => walls.filter((p) => overlap(p, { ...door.b, u0: at - half, u1: at + half }));
    let at = clampAlong(want, door.width, door.lo, door.hi);
    const blocker = hits(at)[0];
    if (blocker) {
      const fits = (c: number) => c - half >= door.lo - 1e-6 && c + half <= door.hi + 1e-6 && !hits(c).length;
      const sides = [blocker.u0 - half, blocker.u1 + half].filter(fits).sort((p, q) => Math.abs(p - want) - Math.abs(q - want));
      at = sides[0] ?? (door.b.u0 + door.b.u1) / 2;
    }
    // Held at the end of its wall, what it snapped to no longer applies.
    this.guides.set(Math.abs(at - want) < 1e-6 ? snap.guides : []);
    this.store.updateFloor(door.floorId, (f) => ({ ...f, doors: f.doors.map((d) => (d.id === door.id ? { ...d, at } : d)) }));
  }

  private applyResize(it: Extract<Interaction, { mode: 'resize' }>, w: UZ): void {
    const skip = new Set([it.id]);
    const u = this.snapCoord(w[0], 'u', skip);
    const z = this.snapCoord(w[1], 'z', skip);
    if (this.roof()) {
      const k = it.base as Skylight;
      const r = resizeBox({ u0: k.x0, u1: k.x1, z0: k.y0, z1: k.y1 }, it.handle, u, z, 1);
      this.store.updateSkylights((ks) => ks.map((x) => (x.id === it.id ? { ...x, x0: r.u0, x1: r.u1, y0: r.z0, y1: r.z1 } : x)));
      return;
    }
    const s = it.base as WindowShape;
    const name = String(it.handle);
    const guides: Guide[] = [];
    /** Snaps the edges a handle moves: u first, then z (measured with the new u). */
    const edges = (b: Bounds, middle: boolean): Bounds => {
      let out = b;
      for (const [letter, edge, raw] of [
        ['w', 'u0', w[0]],
        ['e', 'u1', w[0]],
        ['s', 'z0', w[1]],
        ['n', 'z1', w[1]],
      ] as const) {
        if (!name.includes(letter)) continue;
        const r = this.snapEdgeTo(skip, out, edge, raw, edge === 'z1' ? this.roofOver(out, middle) : undefined);
        guides.push(...r.guides);
        out = { ...out, [edge]: r.v };
      }
      return out;
    };
    let next: WindowShape;
    if (s.t === 'poly' && typeof it.handle === 'number') {
      const i = it.handle;
      const p = this.shift() ? this.squareCorner(s.pts, i, w) : [u, z];
      next = { ...s, pts: s.pts.map((q, j): [number, number] => (j === i ? [p[0], p[1]] : q)) };
    } else if (s.t === 'roofline') {
      // Its top and bottom are sloped: measure them at the middle.
      const m = s.u + s.w / 2;
      const e = rooflineEdges(s, m);
      const b = edges({ u0: s.u, u1: s.u + s.w, z0: e.bottom, z1: e.top }, true);
      const r = resizeRoofline(s, it.handle, name === 'w' ? b.u0 : b.u1, name === 's' ? b.z0 : b.z1);
      if (!r) return;
      next = r;
    } else if (s.t === 'circle') {
      const b = { u0: s.u - s.r, u1: s.u + s.r, z0: s.z - s.r, z1: s.z + s.r };
      const r = this.snapEdgeTo(skip, b, 'u1', s.u + Math.hypot(w[0] - s.u, w[1] - s.z));
      guides.push(...r.guides);
      next = { ...s, r: Math.max(MIN_WINDOW / 2, r.v - s.u) };
    } else if (s.t === 'rect' || s.t === 'arch') {
      const b = edges({ u0: s.u, u1: s.u + s.w, z0: s.z, z1: s.z + s.h }, s.t === 'arch');
      const r = resizeBox({ u0: s.u, u1: s.u + s.w, z0: s.z, z1: s.z + s.h }, it.handle, name.includes('w') ? b.u0 : b.u1, name.includes('s') ? b.z0 : b.z1, MIN_WINDOW);
      const width = r.u1 - r.u0;
      next = { ...s, u: r.u0, z: r.z0, w: width, h: s.t === 'arch' ? Math.max(width / 2, r.z1 - r.z0) : r.z1 - r.z0 };
    } else return;
    this.guides.set(guides);
    this.store.updateWindows((ws) => ws.map((x) => (x.id === it.id ? { ...x, shape: next } : x)));
  }

  /**
   * Shift-dragging a free shape's corner squares it up with its neighbors: it snaps
   * onto the vertical and horizontal lines through the two corners it connects to,
   * so either edge runs straight — and, more strongly, to where those lines cross,
   * so both do. An axis that finds no line snaps as usual.
   */
  private squareCorner(pts: readonly [number, number][], i: number, w: UZ): UZ {
    const n = pts.length;
    const [a, b] = [pts[(i - 1 + n) % n], pts[(i + 1) % n]];
    const tol = SNAP_PX / this.view().scale;
    const crossings = ([
      [a[0], b[1]],
      [b[0], a[1]],
    ] as UZ[]).filter((c) => !samePoint(c, a) && !samePoint(c, b)); // lined-up neighbors cross at themselves
    let best: UZ | null = null;
    let dist = 2 * tol;
    for (const c of crossings) {
      const d = Math.hypot(c[0] - w[0], c[1] - w[1]);
      if (d < dist) [best, dist] = [c, d];
    }
    if (best) return best;
    const onLine = (v: number, lines: number[]) => {
      const hit = lines.filter((c) => Math.abs(c - v) < tol).sort((x, y) => Math.abs(x - v) - Math.abs(y - v))[0];
      return hit ?? null;
    };
    const skip = new Set(this.pick()?.ids ?? []);
    return [onLine(w[0], [a[0], b[0]]) ?? this.snapCoord(w[0], 'u', skip), onLine(w[1], [a[1], b[1]]) ?? this.snapCoord(w[1], 'z', skip)];
  }

  /**
   * While Shift-dragging a free shape's corner: the lines through its neighbors it
   * can square up to (world units), the ones it's on marked.
   */
  protected readonly cornerGuides = computed(() => {
    const it = this.interaction();
    if (it.mode !== 'resize' || typeof it.handle !== 'number' || !this.shift()) return [];
    const shape = this.shapeOf(it.id);
    if (shape?.t !== 'poly') return [];
    const n = shape.pts.length;
    const i = it.handle;
    const p = shape.pts[i];
    const reach = 1000;
    return [shape.pts[(i - 1 + n) % n], shape.pts[(i + 1) % n]].flatMap(([u, z]) => [
      { x1: u, y1: z - reach, x2: u, y2: z + reach, on: Math.abs(p[0] - u) < 1e-6 },
      { x1: u - reach, y1: z, x2: u + reach, y2: z, on: Math.abs(p[1] - z) < 1e-6 },
    ]);
  });

  /** What's under a point: a skylight on the roof; on a face, a window (drawn on top), else a door. */
  private hitAt(w: UZ): { kind: Picked['kind']; id: string } | null {
    const tol = HIT_PX / this.view().scale;
    const within = (b: Bounds) => w[0] >= b.u0 - tol && w[0] <= b.u1 + tol && w[1] >= b.z0 - tol && w[1] <= b.z1 + tol;
    if (this.roof()) {
      const k = [...this.store.skylights()].reverse().find((x) => within({ u0: x.x0, u1: x.x1, z0: x.y0, z1: x.y1 }));
      return k ? { kind: 'skylight', id: k.id } : null;
    }
    const win = [...this.faceWindows()].reverse().find((x) => within(shapeBounds(x.shape)));
    if (win) return { kind: 'window', id: win.id };
    const door = this.faceDoors().find((d) => within(d.b));
    return door ? { kind: 'door', id: door.id } : null;
  }

  private handleAt(w: UZ): { id: string; handle: Handle } | null {
    const r = (HIT_PX * 1.2) / this.view().scale;
    const sel = this.pick();
    if (!sel || sel.ids.length !== 1) return null;
    const h = this.handles().find((x) => Math.hypot(x.u - w[0], x.z - w[1]) <= r);
    return h ? { id: sel.ids[0], handle: h.handle } : null;
  }

  private startPan(e: PointerEvent, p: Point): void {
    this.capture(e);
    this.interaction.set({ mode: 'pan', pointerId: e.pointerId, start: p, startView: this.view(), moved: false });
  }

  private capture(e: PointerEvent): void {
    try {
      this.host.nativeElement.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  private localPoint(e: MouseEvent): Point {
    const r = this.canvas().nativeElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
}

// ===================================================================== helpers

const SIDE_NAME = { N: 'North', E: 'East', S: 'South', W: 'West' } as const;
const SHAPE_NAME = { rect: 'Window', circle: 'Round window', arch: 'Arched window', poly: 'Shaped window', roofline: 'Roofline window' } as const;
const DOOR_NAME: Record<DoorKind, string> = {
  single: 'Door',
  double: 'Double doors',
  pocket: 'Pocket door',
  barn: 'Barn door',
  opening: 'Cased opening',
  garage: 'Garage door',
};

/** True if two boxes on the face overlap (touching doesn't count). */
const overlap = (a: Bounds, b: Bounds) =>
  Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0) > 1e-6 && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 1e-6;

const snapTo = (v: number, step: number) => Math.round(v / step) * step;
const uniq = (v: number[]) => [...v].sort((a, b) => a - b).filter((x, i, arr) => i === 0 || x - arr[i - 1] > 1 / 48);
const samePoint = (a: UZ, b: UZ) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

function pathOf(pts: readonly UZ[], close = true): string {
  if (!pts.length) return '';
  return `M ${pts.map(([u, z]) => `${u} ${z}`).join(' L ')}${close ? ' Z' : ''}`;
}

/** A double-hung's upper sash, drawn over the lower one's top rail. */
function sashOf(s: WindowShape): { x: number; y: number; w: number; h: number } | null {
  if (s.t !== 'rect') return null;
  const inset = Math.min(1.5 * IN, s.w / 10);
  return { x: s.u + inset, y: s.z + s.h / 2 - inset, w: s.w - 2 * inset, h: s.h / 2 };
}

/** Where a shape can be resized from: corners and edges, a circle's rim, a free shape's corners. */
function handlesOf(s: WindowShape): { u: number; z: number; handle: Handle }[] {
  switch (s.t) {
    case 'roofline': {
      // Its edges, at their middles: the sides slide sideways, the top and bottom up and down.
      const [l, r, m] = [rooflineEdges(s, s.u), rooflineEdges(s, s.u + s.w), rooflineEdges(s, s.u + s.w / 2)];
      return [
        { u: s.u, z: (l.bottom + l.top) / 2, handle: 'w' },
        { u: s.u + s.w, z: (r.bottom + r.top) / 2, handle: 'e' },
        { u: s.u + s.w / 2, z: m.bottom, handle: 's' },
        { u: s.u + s.w / 2, z: m.top, handle: 'n' },
      ];
    }
    case 'circle':
      return [{ u: s.u + s.r, z: s.z, handle: 'r' }];
    case 'poly':
      return s.pts.map(([u, z], i) => ({ u, z, handle: i }));
    default: {
      const [u0, u1, z0, z1] = [s.u, s.u + s.w, s.z, s.z + s.h];
      const [um, zm] = [(u0 + u1) / 2, (z0 + z1) / 2];
      return [
        { u: u0, z: z0, handle: 'sw' },
        { u: u1, z: z0, handle: 'se' },
        { u: u0, z: z1, handle: 'nw' },
        { u: u1, z: z1, handle: 'ne' },
        { u: um, z: z0, handle: 's' },
        { u: um, z: z1, handle: 'n' },
        { u: u0, z: zm, handle: 'w' },
        { u: u1, z: zm, handle: 'e' },
      ];
    }
  }
}

/**
 * A roofline window with one edge dragged to (u, z): the sides move along u with
 * the sloped top and bottom staying on their lines; the top or bottom line moves up
 * or down to pass through z at the middle. Null if that would leave it too small.
 */
function resizeRoofline(s: Extract<WindowShape, { t: 'roofline' }>, h: Handle, u: number, z: number): WindowShape | null {
  let next = s;
  const m = s.u + s.w / 2;
  switch (h) {
    case 'w': {
      const du = u - s.u;
      next = { ...s, u, w: s.w - du, z: s.z + s.bottom * du, h: s.h + (s.top - s.bottom) * du };
      break;
    }
    case 'e':
      next = { ...s, w: u - s.u };
      break;
    case 's': {
      const z0 = z - s.bottom * (m - s.u);
      next = { ...s, z: z0, h: s.h + s.z - z0 };
      break;
    }
    case 'n':
      next = { ...s, h: z - s.top * (m - s.u) - s.z };
      break;
    default:
      return null;
  }
  const right = next.h + (next.top - next.bottom) * next.w;
  return next.w >= MIN_WINDOW && Math.min(next.h, right) >= MIN_WINDOW ? next : null;
}

/** A box with the edges a handle moves set to (u, z), kept at least `min` across. */
function resizeBox(b: Bounds, h: Handle, u: number, z: number, min: number): Bounds {
  const out = { ...b };
  const name = String(h);
  if (name.includes('w')) out.u0 = Math.min(u, b.u1 - min);
  if (name.includes('e')) out.u1 = Math.max(u, b.u0 + min);
  if (name.includes('s')) out.z0 = Math.min(z, b.z1 - min);
  if (name.includes('n')) out.z1 = Math.max(z, b.z0 + min);
  return out;
}

/** An arrow down a section's roof, from its high side toward the low one (plan units). */
function slopeArrow(dir: 'N' | 'E' | 'S' | 'W', ax: number, ay: number, bx: number, by: number): string {
  const [cx, cy] = [(ax + bx) / 2, (ay + by) / 2];
  const len = Math.min(bx - ax, by - ay) * 0.3;
  const [dx, dy] = dir === 'N' ? [0, -1] : dir === 'S' ? [0, 1] : dir === 'E' ? [1, 0] : [-1, 0];
  const [tx, ty] = [cx + dx * len, cy + dy * len];
  const [px, py] = [-dy * len * 0.25, dx * len * 0.25];
  return `M ${cx - dx * len} ${cy - dy * len} L ${tx} ${ty} M ${tx - dx * len * 0.3 + px} ${ty - dy * len * 0.3 + py} L ${tx} ${ty} L ${tx - dx * len * 0.3 - px} ${ty - dy * len * 0.3 - py}`;
}

function isFromUi(e: Event): boolean {
  return e.target instanceof Element && !!e.target.closest('.ui, .p-tooltip');
}

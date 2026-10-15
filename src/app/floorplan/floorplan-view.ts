import { afterNextRender, Component, computed, DestroyRef, effect, ElementRef, inject, signal, untracked, viewChild } from '@angular/core';
import { ButtonModule } from '@openng/optimus-ui/button';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { CATALOG_BY_ID, CatalogItem, itemShape, rotatedBox, rotatedSize, stairArrival } from '../core/floorplan/catalog';
import { exteriorWallBand, fitDoorWidth, GARAGE_DOOR_HEIGHTS, nextSwing, placeDoors } from '../core/floorplan/doors';
import { shapeBounds } from '../core/floorplan/windows';
import {
  floorArea,
  floorRegion,
  floorRise,
  isBasement,
  kneeStrips,
  openingsOf,
  patioBoxes,
  regionOf,
  stairOpenings,
} from '../core/floorplan/floor-region';
import { copyGroups, group, isGroup, pruneGroups, rotateAbout, ungroup, unitItems, unitsOf } from '../core/floorplan/groups';
import { Box, cellsWhere, pointIn } from '../core/floorplan/region';
import { isUnheated } from '../core/floorplan/areas';
import { findRooms, Room } from '../core/floorplan/rooms';
import {
  addWall,
  Axis,
  clampAlong,
  deleteNode,
  deleteWalls,
  lineGroup,
  misfitWalls,
  moveIsValid,
  moveNode,
  moveWallLine,
  normalize,
  Pt,
  setDividers,
  solidWalls,
  wallBoxes,
  wallFits,
  wallGeoms,
} from '../core/floorplan/wall-graph';
import { boundsOf, x0, x1, y0, y1 } from '../core/geometry/rect';
import { newId } from '../core/model/defaults';
import { formatFeet } from '../core/model/format';
import { Door, DoorHost, DoorKind, Floor, FloorOpening, FurnitureItem, Rotation } from '../core/model/types';
import { EditorState } from '../core/state/editor-state';
import { ProjectStore } from '../core/state/project-store';
import { DRAG_START_THRESHOLD_PX } from '../editor/side-drag';
import { isTyping } from '../shell/keys';
import { clampPan, fitViewport, Point, screenToWorld, Viewport, worldToScreen, zoomAt } from '../editor/viewport';
import { doorGraphics, parseLength } from './door-graphics';
import { DoorOptions } from './door-options';
import { floorLabel, FloorStack } from './floor-stack';
import { CatalogPick, CATEGORY_TINT, FurniturePanel } from './furniture-panel';
import { ItemSymbol } from './item-symbol';
import {
  connects,
  doorSpot,
  FINE_GRID,
  GRID,
  hitTest,
  itemBox,
  planContext,
  resizeOpening,
  sameHost,
  Snap,
  snapAlong,
  snapItem,
  snapPoint,
  snapTo,
  StairHandle,
  Target,
} from './plan-tools';

const WHEEL_ZOOM_SPEED = 0.0015;
/** Pointer tolerance for grabbing things (px). */
const HIT_PX = 7;
/** Snapping reach (px). */
const SNAP_PX = 10;

export type Tool = 'select' | 'wall' | 'door' | 'opening' | 'tape';

interface ToolSpec {
  id: Tool;
  label: string;
  tip: string;
  fill: string;
  stroke: string;
}

/** Toolbar entries; icons are 20×20 SVG paths (a filled part and a stroked part). */
const TOOLS: ToolSpec[] = [
  { id: 'select', label: 'Select', tip: 'Select and move (M, or Space)', fill: 'M5 2.5 V15.5 L8.6 12.2 L11 17.5 L13.2 16.5 L10.8 11.3 H15.5 Z', stroke: '' },
  { id: 'wall', label: 'Wall', tip: 'Draw interior walls (W)', fill: 'M3 3 H7.5 V12.5 H17 V17 H3 Z', stroke: '' },
  { id: 'door', label: 'Door', tip: 'Add doors to any wall (D)', fill: '', stroke: 'M2 17.5 H18 M4.5 17.5 V4 M4.5 4 A13.5 13.5 0 0 1 18 17.5' },
  { id: 'tape', label: 'Tape', tip: 'Measure distances (T)', fill: '', stroke: 'M2.5 14 H17.5 M2.5 10.5 V17.5 M17.5 10.5 V17.5 M6.25 14 V12 M10 14 V11 M13.75 14 V12' },
  { id: 'opening', label: 'Open to below', tip: 'Open part of this floor to the one below (O)', fill: '', stroke: 'M3 3 H17 V17 H3 Z M10 6.5 V13.5 M7 10.5 L10 13.5 L13 10.5' },
];

/** On a basement, the opening tool's slot marks ground that isn't dug out instead. */
const UNDUG_TOOL: ToolSpec = {
  id: 'opening',
  label: 'Not dug out',
  tip: 'Mark part of the basement as not dug out: the floor above sits on a slab there (O)',
  fill: '',
  stroke: 'M3 3 H17 V17 H3 Z M3 9 L9 3 M3 15 L15 3 M7 17 L17 7 M13 17 L17 13',
};

/** Small 16×16 icons for the selection bar (stroked). */
const ICONS = {
  group: 'M1.5 1.5 H14.5 V14.5 H1.5 Z M4 4 H8 V8 H4 Z M8.5 8.5 H12 V12 H8.5 Z',
  ungroup: 'M2 2 H7 V7 H2 Z M9 9 H14 V14 H9 Z M9.5 2.5 L13.5 6.5 M13.5 2.5 L9.5 6.5',
  divider: 'M1 8 H3.5 M6 8 H8.5 M11 8 H13.5 M1 4 V12 M15 4 V12',
  wall: 'M1 6 H15 V10 H1 Z',
};

/** The drawn areas a floor's area tool edits: openings to below, or a basement's undug parts. */
const areasOf = (f: Floor): FloorOpening[] => (isBasement(f) ? f.unexcavated : f.openings);

type Selection = { kind: 'wall' | 'door' | 'item' | 'stair' | 'opening' | 'node'; id: string } | null;

interface Placing {
  item: CatalogItem;
  rotation: Rotation;
  pos: Pt | null;
  /** True while the button is held from the panel (drag to place); false once it follows the cursor (click to place). */
  held: boolean;
}

type Interaction =
  | { mode: 'idle' }
  | { mode: 'pan'; pointerId: number; start: Point; startView: Viewport; moved: boolean }
  | { mode: 'press'; pointerId: number; start: Point; target: Target }
  /** `base` is the floor being edited as the drag began (the floor below, for a stair arriving from there). */
  | { mode: 'drag'; pointerId: number; target: Target; base: Floor; start: Pt }
  | { mode: 'wall-press'; pointerId: number; start: Point; from: Snap; moved: boolean }
  | { mode: 'tape-press'; pointerId: number; start: Point; from: Snap; moved: boolean }
  | { mode: 'opening-draw'; pointerId: number; from: Pt; to: Pt };

/**
 * Left pane in Floorplan mode: lays out one floor at a time inside the fixed
 * exterior walls. Tools: Select (drag walls, corners, doors, furniture, openings),
 * Wall (click-click chains, or press-drag-release), Door, and Opening (upper floors:
 * open the floor to the one below). Furniture comes from the side panel. Every edit
 * goes straight to the store, so the 3D view follows live.
 */
@Component({
  selector: 'app-floorplan-view',
  imports: [ButtonModule, TooltipModule, DoorOptions, FloorStack, FurniturePanel, ItemSymbol],
  templateUrl: './floorplan-view.html',
  styleUrl: './floorplan-view.scss',
  host: {
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerUp($event)',
    // On the host: clicks follow pointer capture there, so the canvas wouldn't see them.
    '(dblclick)': 'onDoubleClick($event)',
    '(window:keydown)': 'onKeyDown($event)',
    '(window:keyup)': 'onKeyUp($event)',
    '(window:blur)': 'alt.set(false); shift.set(false)',
  },
})
export class FloorplanView {
  private readonly store = inject(ProjectStore);
  protected readonly editor = inject(EditorState);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly canvas = viewChild.required<ElementRef<HTMLElement>>('canvas');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  protected readonly size = signal<Point>({ x: 0, y: 0 });
  protected readonly view = computed<Viewport>(() => this.editor.planView() ?? { scale: 12, tx: 0, ty: 0 });
  protected readonly tool = signal<Tool>('select');
  protected readonly selection = signal<Selection>(null);
  /**
   * The furniture selected along with the selection's item: a group clicked, or
   * pieces shift-clicked (whole groups at a time). The primary is the last.
   */
  private readonly picked = signal<string[]>([]);
  /** The furniture currently selected: the picked set, or just the selected item. */
  protected readonly selectedItems = computed(() => {
    const sel = this.selection();
    if (sel?.kind !== 'item') return [];
    const g = this.picked();
    return g.includes(sel.id) ? g : [sel.id];
  });
  protected readonly hover = signal<Target | null>(null);
  private readonly interaction = signal<Interaction>({ mode: 'idle' });
  protected readonly cursor = signal<Pt | null>(null);
  protected readonly alt = signal(false);
  protected readonly shift = signal(false);
  /** Tape tool: the start of a measurement in progress, and the last finished one. */
  private readonly tapeFrom = signal<Pt | null>(null);
  private readonly tapeDone = signal<{ a: Pt; b: Pt } | null>(null);
  /** Wall tool: the end of the last wall drawn, while a chain is in progress. */
  protected readonly chain = signal<Pt | null>(null);
  /** Wall tool: a length being typed for the next wall. */
  protected readonly lengthEntry = signal('');
  protected readonly doorKind = signal<DoorKind>('single');
  protected readonly doorWidth = signal<number>(2 + 8 / 12);
  /** Door tool: a new garage door's height. */
  protected readonly doorHeight = signal<number>(GARAGE_DOOR_HEIGHTS[0]);
  /** Wall tool: whether new walls are built walls or room dividers. */
  protected readonly wallKind = signal<'wall' | 'divider'>('wall');
  /** Door tool: how many times R has turned the new door's swing from its default. */
  private readonly doorTurns = signal(0);
  protected readonly placing = signal<Placing | null>(null);

  protected readonly icons = ICONS;
  protected readonly feet = formatFeet;

  // ------------------------------------------------------------------ model

  protected readonly floor = this.editor.activeFloor;
  protected readonly floorIndex = this.editor.activeFloorIndex;
  /** −1 for the basement, 0 for the ground floor, 1 for the floor above it… */
  protected readonly level = this.editor.activeLevel;
  protected readonly basement = computed(() => isBasement(this.floor()));
  private readonly floorId = computed(() => this.floor().id);
  protected readonly floorName = computed(() => floorLabel(this.level()));
  private readonly sections = this.store.sections;
  private readonly ti = computed(() => this.store.settings().interiorWallThickness);
  protected readonly region = computed(() => regionOf(this.sections(), this.store.settings(), this.floor()));
  private readonly doors = computed(() => placeDoors(this.floor(), this.region(), this.ti()));
  /** Height to the floor above, which sizes stairs. */
  private readonly rise = computed(() => floorRise(this.store.floors(), this.floorIndex()));
  /** Whether there's a floor above, whose deck is the stairs' top landing. */
  private readonly floorAbove = computed(() => this.floorIndex() + 1 < this.store.floors().length);
  private readonly ctx = computed(() => {
    const mark = this.tapeDone();
    return planContext(this.floor(), this.region(), this.ti(), this.doors(), this.rise(), mark ? [mark] : [], this.floorAbove());
  });

  /** The area tool works on a basement (undug ground) or any floor with one below it (openings). */
  protected readonly areaToolUsable = computed(() => this.basement() || this.floorIndex() > 0);
  protected readonly tools = computed(() => (this.basement() ? TOOLS.map((t) => (t.id === 'opening' ? UNDUG_TOOL : t)) : TOOLS));
  /** The active floor's drawn areas (see `areasOf`). */
  protected readonly areas = computed(() => areasOf(this.floor()));
  private readonly step = computed(() => (this.alt() ? FINE_GRID : GRID));
  private readonly tol = computed(() => HIT_PX / this.view().scale);
  private readonly snapTol = computed(() => SNAP_PX / this.view().scale);
  private readonly contentBounds = computed(() => boundsOf(this.sections().map((s) => s.rect)));

  /** Everything open to below on this floor: drawn openings plus those the stairs below need. */
  private readonly allOpenings = computed(() => openingsOf(this.store.floors(), this.floorIndex()));
  protected readonly area = computed(() => Math.round(floorArea(this.region(), this.allOpenings())));

  /** Openings made automatically over the stairs below (plan units, with screen label points). */
  protected readonly stairOpens = computed(() => {
    const v = this.view();
    return stairOpenings(this.store.floors(), this.floorIndex()).map((b) => ({
      b,
      label: worldToScreen(v, { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }),
      vertical: b.y1 - b.y0 > b.x1 - b.x0,
    }));
  });
  /** The floor below and what its stairs need to lay out (null on the lowest floor). */
  private readonly belowFloor = computed(() => {
    const i = this.floorIndex();
    if (i === 0) return null;
    const floors = this.store.floors();
    const floor = floors[i - 1];
    const region = regionOf(this.sections(), this.store.settings(), floor);
    const rise = floorRise(floors, i - 1);
    return { floor, region, rise, ctx: planContext(floor, region, this.ti(), placeDoors(floor, region, this.ti()), rise, [], true) };
  });

  /**
   * Stairs climbing to this floor from the one below: their top landings, drawn on
   * this floor, and the handles (landing and opening) to move them by from here.
   */
  protected readonly arrivals = computed(() => {
    const b = this.belowFloor();
    if (!b) return [];
    const sel = this.selection();
    return b.floor.items.flatMap((it) => {
      const cat = CATALOG_BY_ID.get(it.type);
      const arrival = cat && stairArrival(cat, b.rise);
      if (!arrival) return [];
      const off = rotatedBox(arrival.box, it.rotation);
      const box = { x0: it.x + off.x0, x1: it.x + off.x1, y0: it.y + off.y0, y1: it.y + off.y1 };
      return [
        {
          id: it.id,
          box,
          transform: `translate(${it.x} ${it.y}) rotate(${it.rotation})`,
          prims: arrival.symbol,
          tint: CATEGORY_TINT[cat.category],
          selected: sel?.kind === 'stair' && sel.id === it.id,
        },
      ];
    });
  });
  private readonly stairHandles = computed<StairHandle[]>(() => this.arrivals().map(({ id, box }) => ({ id, box })));

  protected readonly rooms = computed(() => findRooms(this.floor(), this.region(), this.ti()));
  protected readonly misfits = computed(() => misfitWalls(this.floor(), this.region(), this.ti()));
  protected readonly noRoom = computed(() => this.region().footprint.length === 0);

  // ------------------------------------------------------------------ view models (world units unless noted)

  protected readonly worldTransform = computed(() => {
    const v = this.view();
    return `translate(${v.tx} ${v.ty}) scale(${v.scale})`;
  });

  protected readonly grid = computed(() => {
    const { scale, tx, ty } = this.view();
    const minorFt = scale >= 8 ? 1 : 5;
    const majorFt = scale >= 4 ? 10 : 50;
    return { minor: minorFt * scale, major: majorFt * scale, offsetX: tx, offsetY: ty };
  });

  /** Upper floors: stretches of the outline left without a wall because they're open to below. */
  protected readonly openOutline = computed(() => {
    const openings = this.allOpenings();
    if (this.level() <= 0 || openings.length === 0) return [];
    const ground = floorRegion(this.sections(), this.store.settings(), 0);
    return kneeStrips(this.region(), ground, openings).open.map((k) => k.box);
  });

  protected readonly hatch = computed(() => ({ size: 9 / this.view().scale, stroke: 1.4 / this.view().scale }));

  protected readonly patios = computed(() => (this.level() === 0 ? patioBoxes(this.sections()) : []));

  /** The floor below, drawn faintly for reference (when there is one). */
  protected readonly below = computed(() => {
    const i = this.floorIndex();
    if (i === 0) return null;
    const f = this.store.floors()[i - 1];
    const region = regionOf(this.sections(), this.store.settings(), f);
    const rise = floorRise(this.store.floors(), i - 1);
    return {
      footprint: region.footprint,
      walls: [...wallBoxes(solidWalls(f), this.ti()).values()],
      items: f.items.map((it) => this.itemView(it, rise, true)).filter((v) => !!v),
    };
  });

  /**
   * Basement: the house above it for reference — its whole outline (dashed, since
   * parts may not be dug out) and the ground floor's walls — plus the undug ground,
   * hatched within that outline.
   */
  protected readonly above = computed(() => {
    if (!this.basement()) return null;
    const floors = this.store.floors();
    const ground = floors[this.floorIndex() + 1];
    const house = floorRegion(this.sections(), this.store.settings(), 0).footprint;
    const undug = this.areas();
    return {
      outline: house,
      walls: ground ? [...wallBoxes(solidWalls(ground), this.ti()).values()] : [],
      undug: undug.length ? cellsWhere([...house, ...undug], (x, y) => pointIn(house, x, y) && pointIn(undug, x, y)) : [],
    };
  });

  protected readonly walls = computed(() => {
    const sel = this.selection();
    const hov = this.hover();
    const misfits = this.misfits();
    const { geoms, dividers } = this.ctx();
    const lines = new Map(geoms.map((g) => [g.wall.id, g]));
    return [...this.ctx().wallBoxes].map(([id, box]) => {
      const g = lines.get(id)!;
      const divider = dividers.has(id);
      return {
        id,
        box,
        divider,
        // A divider is drawn as its centerline.
        line: g.axis === 'x' ? { x1: g.lo, x2: g.hi, y1: g.coord, y2: g.coord } : { x1: g.coord, x2: g.coord, y1: g.lo, y2: g.hi },
        selected: sel?.kind === 'wall' && sel.id === id,
        hover: hov?.kind === 'wall' && hov.id === id,
        misfit: misfits.has(id),
      };
    });
  });

  protected readonly doorViews = computed(() => {
    const sel = this.selection();
    const hov = this.hover();
    return this.doors().map((p) => ({
      id: p.door.id,
      ...doorGraphics(p.axis, p.at, p.c0, p.c1, p.door),
      valid: p.valid,
      selected: sel?.kind === 'door' && sel.id === p.door.id,
      hover: hov?.kind === 'door' && hov.id === p.door.id,
    }));
  });

  protected readonly items = computed(() => {
    const picked = new Set(this.selectedItems());
    return this.floor()
      .items.map((it) => {
        const v = this.itemView(it, this.rise(), this.floorAbove());
        return v && { ...v, selected: picked.has(it.id) };
      })
      .filter((v) => !!v);
  });

  /**
   * Windows cut by this floor's plan (the usual 4′ above the floor), drawn in their
   * walls: glass across the wall's thickness with a line down the middle.
   */
  protected readonly windowMarks = computed(() => {
    const cut = this.floor().elevation + 4;
    const t = this.store.settings().wallThickness;
    return this.store.windows().flatMap((w) => {
      const b = shapeBounds(w.shape);
      if (b.z0 > cut || b.z1 < cut) return [];
      const [c0, c1] = exteriorWallBand(w.host.side, w.host.coord, t);
      const along = w.host.side === 'N' || w.host.side === 'S';
      const box = along ? { x0: b.u0, x1: b.u1, y0: c0, y1: c1 } : { x0: c0, x1: c1, y0: b.u0, y1: b.u1 };
      const mid = (c0 + c1) / 2;
      const line = along ? { x1: b.u0, x2: b.u1, y1: mid, y2: mid } : { x1: mid, x2: mid, y1: b.u0, y2: b.u1 };
      return [{ id: w.id, box, line }];
    });
  });

  /** Outline around a selection of several pieces (a group, or a shift-click set). */
  protected readonly itemsOutline = computed(() => (this.selectedItems().length > 1 ? this.selectedBox() : null));

  /** The drawn areas: openings to below, or a basement's undug parts. */
  protected readonly openings = computed(() => {
    const sel = this.selection();
    const v = this.view();
    const label = this.basement() ? 'Not dug out' : 'Open to below';
    return this.areas().map((o) => ({
      o,
      selected: sel?.kind === 'opening' && sel.id === o.id,
      label: worldToScreen(v, { x: (o.x0 + o.x1) / 2, y: (o.y0 + o.y1) / 2 }),
      text: label,
    }));
  });

  protected readonly nodes = computed(() => {
    if (this.tool() !== 'select') return [];
    const sel = this.selection();
    const hov = this.hover();
    const r = 4 / this.view().scale;
    return this.floor().nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      r,
      active: (sel?.kind === 'node' && sel.id === n.id) || (hov?.kind === 'node' && hov.id === n.id),
    }));
  });

  /** Room area labels (screen px). */
  protected readonly roomLabels = computed(() => {
    const v = this.view();
    if (v.scale < 5) return [];
    const names = this.floor().roomNames;
    const editing = this.naming()?.room;
    // The room being named shows only the name box (and its toggle) for now.
    return this.rooms().filter((r) => r !== editing).map((r) => {
      const s = worldToScreen(v, r);
      return {
        x: s.x,
        y: s.y,
        name: names.find((n) => pointIn(r.cells, n.x, n.y))?.name ?? null,
        unheated: isUnheated(this.floor(), r),
        area: `${Math.round(r.area)} sq ft`,
        dims: r.rect && v.scale >= 9 ? `${formatFeet(r.rect.w)} × ${formatFeet(r.rect.d)}` : null,
      };
    });
  });

  /** Unheated rooms' floor, hatched (plan units). */
  protected readonly unheatedCells = computed(() => {
    const f = this.floor();
    return this.rooms()
      .filter((r) => isUnheated(f, r))
      .flatMap((r) => r.cells);
  });

  /** A room name being typed (after double-clicking a room), and whether it's unheated. */
  protected readonly naming = signal<{ room: Room; at: Pt; value: string; unheated: boolean } | null>(null);
  protected readonly namingBox = computed(() => {
    const n = this.naming();
    return n && worldToScreen(this.view(), n.room);
  });

  // ------------------------------------------------------------------ tool previews

  /** Wall tool: where the next wall would end, from the chain point toward the cursor. */
  private readonly chainEnd = computed<Snap | null>(() => {
    const from = this.chain();
    const c = this.cursor();
    if (!from || !c) return null;
    const axis: Axis = Math.abs(c.x - from.x) >= Math.abs(c.y - from.y) ? 'x' : 'y';
    const typed = parseLength(this.lengthEntry());
    if (typed !== null && typed > 0) {
      const sign = (axis === 'x' ? c.x - from.x : c.y - from.y) >= 0 ? 1 : -1;
      const p = axis === 'x' ? { x: from.x + sign * typed, y: from.y } : { x: from.x, y: from.y + sign * typed };
      return { p, kind: 'grid' };
    }
    return snapAlong(this.ctx(), from, axis, axis === 'x' ? c.x : c.y, this.snapTol(), this.step());
  });

  /** Wall tool: the start point under the cursor before a chain begins. */
  private readonly startSnap = computed<Snap | null>(() => {
    const c = this.cursor();
    const tool = this.tool();
    if ((tool !== 'wall' && tool !== 'tape') || !c) return null;
    const it = this.interaction();
    if (it.mode === 'wall-press' || it.mode === 'tape-press') return it.from;
    if (this.chain() || this.tapeFrom()) return null;
    return snapPoint(this.ctx(), c, this.snapTol(), this.step());
  });

  protected readonly wallPreview = computed(() => {
    const it = this.interaction();
    const from = it.mode === 'wall-press' && it.moved ? it.from.p : this.chain();
    const c = this.cursor();
    if (!from || !c) return null;
    const end =
      it.mode === 'wall-press'
        ? (() => {
            const axis: Axis = Math.abs(c.x - from.x) >= Math.abs(c.y - from.y) ? 'x' : 'y';
            return snapAlong(this.ctx(), from, axis, axis === 'x' ? c.x : c.y, this.snapTol(), this.step());
          })()
        : this.chainEnd();
    if (!end) return null;
    const ti = this.ti();
    const len = Math.abs(end.p.x - from.x) + Math.abs(end.p.y - from.y);
    const box: Box = {
      x0: Math.min(from.x, end.p.x) - (from.y === end.p.y ? 0 : ti / 2),
      x1: Math.max(from.x, end.p.x) + (from.y === end.p.y ? 0 : ti / 2),
      y0: Math.min(from.y, end.p.y) - (from.y === end.p.y ? ti / 2 : 0),
      y1: Math.max(from.y, end.p.y) + (from.y === end.p.y ? ti / 2 : 0),
    };
    const v = this.view();
    const mid = worldToScreen(v, { x: (from.x + end.p.x) / 2, y: (from.y + end.p.y) / 2 });
    return {
      from,
      end,
      box,
      valid: len > 0 && wallFits(from, end.p, this.region(), ti),
      label: { x: mid.x, y: mid.y, text: this.lengthEntry() ? `${this.lengthEntry()}▏` : formatFeet(len) },
    };
  });

  /** Tape tool: the measurement being made, from its start to the snapped cursor. */
  private readonly tapeLive = computed<{ a: Pt; end: Snap } | null>(() => {
    const it = this.interaction();
    const a = it.mode === 'tape-press' ? (it.moved ? it.from.p : null) : this.tapeFrom();
    return a && this.cursor() ? { a, end: this.tapeEndFrom(a)! } : null;
  });

  /** The snap the wall or tape tool is showing: where the next point would land. */
  private readonly activeSnap = computed(() => this.wallPreview()?.end ?? this.tapeLive()?.end ?? this.startSnap());

  /**
   * The tape measurement on screen (screen px): a dimension line with end ticks and
   * its length — plus the along/across components when it's measured at an angle.
   */
  protected readonly tape = computed(() => {
    const live = this.tapeLive();
    const m = live ? { a: live.a, b: live.end.p } : this.tapeDone();
    if (!m) return null;
    const v = this.view();
    const a = worldToScreen(v, m.a);
    const b = worldToScreen(v, m.b);
    const dx = m.b.x - m.a.x;
    const dy = m.b.y - m.a.y;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const [nx, ny] = [-(b.y - a.y) / len, (b.x - a.x) / len];
    const tick = (p: Point) => ({ x1: p.x - nx * 7, y1: p.y - ny * 7, x2: p.x + nx * 7, y2: p.y + ny * 7 });
    const square = Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6;
    const text = formatFeet(Math.hypot(dx, dy)) + (square ? '' : `  (${formatFeet(Math.abs(dx))} × ${formatFeet(Math.abs(dy))})`);
    return {
      line: { x1: a.x, y1: a.y, x2: b.x, y2: b.y },
      ticks: [tick(a), tick(b)],
      label: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text, w: text.length * 6.6 + 14 },
    };
  });

  /** A jut corner the wall or tape tool is snapped to, highlighted whole (plan units). */
  protected readonly cornerHighlight = computed(() => this.activeSnap()?.highlight ?? null);

  /** Snap marker for the wall and tape tools (screen px). */
  protected readonly snapMarker = computed(() => {
    const s = this.activeSnap();
    if (!s || s.kind === 'corner') return null;
    const p = worldToScreen(this.view(), s.p);
    return { x: p.x, y: p.y, kind: s.kind };
  });

  protected readonly guides = computed(() => {
    const s = this.activeSnap();
    const v = this.view();
    const size = this.size();
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    if (s?.guideX !== undefined) {
      const x = worldToScreen(v, { x: s.guideX, y: 0 }).x;
      lines.push({ x1: x, y1: 0, x2: x, y2: size.y });
    }
    if (s?.guideY !== undefined) {
      const y = worldToScreen(v, { x: 0, y: s.guideY }).y;
      lines.push({ x1: 0, y1: y, x2: size.x, y2: y });
    }
    return lines;
  });

  protected readonly doorGhost = computed(() => {
    const c = this.cursor();
    if (this.tool() !== 'door' || !c || this.interaction().mode !== 'idle') return null;
    const spot = doorSpot(this.ctx(), c, this.tol(), this.doorWidth(), this.step());
    if (!spot) return null;
    let swing: Pick<Door, 'swing' | 'hinge'> = { swing: spot.side, hinge: -1 };
    for (let i = 0; i < this.doorTurns() % 4; i++) swing = nextSwing(swing);
    const door = { width: this.doorWidth(), kind: this.doorKind(), height: this.doorHeight(), ...swing };
    return { spot, door, valid: spot.valid, ...doorGraphics(spot.axis, spot.at, spot.c0, spot.c1, door) };
  });

  protected readonly openingDraft = computed(() => {
    const it = this.interaction();
    return it.mode === 'opening-draw' ? boxOf(it.from, it.to) : null;
  });

  protected readonly placingGhost = computed(() => {
    const pl = this.placing();
    if (!pl?.pos) return null;
    return this.itemView({ id: '', type: pl.item.id, x: pl.pos.x, y: pl.pos.y, rotation: pl.rotation }, this.rise(), this.floorAbove());
  });

  // ------------------------------------------------------------------ selection overlay

  private readonly selectedBox = computed<Box | null>(() => {
    const sel = this.selection();
    if (!sel) return null;
    const f = this.floor();
    switch (sel.kind) {
      case 'wall':
        return this.ctx().wallBoxes.get(sel.id) ?? null;
      case 'door':
        return this.doors().find((d) => d.door.id === sel.id)?.box ?? null;
      case 'item': {
        const boxes = this.selectedItems()
          .map((id) => f.items.find((i) => i.id === id))
          .map((it) => it && itemBox(it, this.rise(), this.floorAbove()))
          .filter((b): b is Box => !!b);
        if (boxes.length === 0) return null;
        return {
          x0: Math.min(...boxes.map((b) => b.x0)),
          x1: Math.max(...boxes.map((b) => b.x1)),
          y0: Math.min(...boxes.map((b) => b.y0)),
          y1: Math.max(...boxes.map((b) => b.y1)),
        };
      }
      case 'stair':
        return this.arrivals().find((a) => a.id === sel.id)?.box ?? null;
      case 'opening':
        return this.areas().find((o) => o.id === sel.id) ?? null;
      case 'node': {
        const n = f.nodes.find((x) => x.id === sel.id);
        return n ? { x0: n.x, x1: n.x, y0: n.y, y1: n.y } : null;
      }
    }
  });

  /** The floating toolbar for the selection (screen px), and what it edits. */
  protected readonly selBar = computed(() => {
    const sel = this.selection();
    const b = this.selectedBox();
    if (!sel || !b || this.interaction().mode === 'drag') return null;
    const v = this.view();
    const tl = worldToScreen(v, { x: b.x0, y: b.y0 });
    const br = worldToScreen(v, { x: b.x1, y: b.y1 });
    const f = this.floor();
    const base = {
      x: (tl.x + br.x) / 2,
      y: Math.max(44, tl.y - 10),
      kind: sel.kind,
      door: null as Door | null,
      grouping: null as 'group' | 'ungroup' | null,
      divider: false,
    };
    switch (sel.kind) {
      case 'item': {
        const ids = this.selectedItems();
        const units = unitsOf(ids, f.groups);
        const grouping = units.length > 1 ? 'group' : isGroup(units[0], f.groups) ? 'ungroup' : null;
        if (grouping === 'ungroup') return { ...base, grouping, title: `Group · ${ids.length} items` };
        if (ids.length > 1) return { ...base, grouping, title: `${ids.length} items` };
        const it = f.items.find((i) => i.id === sel.id)!;
        const cat = CATALOG_BY_ID.get(it.type);
        return { ...base, title: cat?.name ?? it.type };
      }
      case 'stair':
        return { ...base, title: `Stairs up from ${floorLabel(this.level() - 1).toLowerCase()}` };
      case 'door': {
        const d = this.doors().find((p) => p.door.id === sel.id)!;
        return { ...base, title: null, door: d.door };
      }
      case 'wall': {
        const g = wallGeoms(f).find((w) => w.wall.id === sel.id);
        const divider = !!g?.wall.divider;
        const name = divider ? 'Room divider' : 'Wall';
        return { ...base, divider, title: g ? `${name} · ${formatFeet(g.hi - g.lo)}` : name };
      }
      case 'opening': {
        const o = this.areas().find((x) => x.id === sel.id)!;
        const name = this.basement() ? 'Not dug out' : 'Open to below';
        return { ...base, title: `${name} · ${formatFeet(o.x1 - o.x0)} × ${formatFeet(o.y1 - o.y0)}` };
      }
      case 'node':
        return { ...base, title: 'Corner' };
    }
  });

  protected readonly cursorStyle = computed(() => {
    if (this.placing()) return 'copy';
    const it = this.interaction();
    if (it.mode === 'pan') return 'grabbing';
    if (it.mode === 'drag') return 'grabbing';
    switch (this.tool()) {
      case 'wall':
      case 'opening':
      case 'tape':
        return 'crosshair';
      case 'door': {
        const g = this.doorGhost();
        return g ? (g.valid ? 'copy' : 'not-allowed') : 'crosshair';
      }
      case 'select': {
        const h = this.hover();
        if (!h) return 'grab';
        if (h.kind === 'wall') {
          const g = this.ctx().geoms.find((w) => w.wall.id === h.id);
          return g?.axis === 'x' ? 'ns-resize' : 'ew-resize';
        }
        if (h.kind === 'opening' && h.edge) return h.edge === 'N' || h.edge === 'S' ? 'ns-resize' : 'ew-resize';
        return h.kind === 'door' ? 'pointer' : 'move';
      }
    }
  });

  protected readonly hint = computed(() => {
    if (this.placing()) return 'Click to place · R rotates · Shift+click places several · Esc or Q cancels';
    switch (this.tool()) {
      case 'select':
        return 'Click to select · Shift+click furniture to select several · G groups (or ungroups) them · Drag walls, corners, doors and furniture · Click a selected door to flip it · Del or right-click deletes · R rotates';
      case 'wall':
        return this.chain()
          ? 'Click to add a corner · Type a length + Enter · Clicking a wall finishes · Esc, Q or double-click to stop · Space: Select'
          : 'Click to start a wall (or drag one out) · Walls snap to corners, walls and the exterior · Room dividers split rooms without being built · Space: Select';
      case 'door':
        return 'Click any wall, interior or exterior, to add a door · It opens toward the side you click · R turns the swing';
      case 'opening':
        return this.basement()
          ? 'Drag a rectangle over ground that won’t be dug out (slab on grade above) · Snaps to the house’s walls · Foundation walls go around it'
          : 'Drag a rectangle to open this floor to the one below (stairs, lofts, two-story rooms)';
      case 'tape':
        return 'Click two points (or drag) to measure · Snaps like walls · Shift measures at any angle · Esc or Q clears';
    }
  });

  constructor() {
    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const first = this.size().x === 0;
      this.size.set({ x: width, y: height });
      // The canvas is narrower than Exterior's (furniture panel), so frame it afresh.
      if (first) this.fit();
    });
    afterNextRender(() => resize.observe(this.canvas().nativeElement));
    inject(DestroyRef).onDestroy(() => {
      resize.disconnect();
      if (this.interaction().mode === 'drag') this.store.endGesture();
    });

    let lastEpoch = untracked(this.store.viewEpoch);
    effect(() => {
      const epoch = this.store.viewEpoch();
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        untracked(() => this.fit());
      }
    });
    // Switching floors drops whatever was going on.
    effect(() => {
      this.floorId();
      untracked(() => this.resetTransient());
    });
    // A room name box appears focused, with its text selected.
    effect(() => {
      const input = this.nameInput()?.nativeElement;
      if (input) untracked(() => (input.focus(), input.select()));
    });
    // Selections can vanish (undo, normalization); drop them.
    effect(() => {
      const sel = this.selection();
      if (sel && !this.selectedBox()) untracked(() => this.selection.set(null));
    });
  }

  // ------------------------------------------------------------------ commands

  fit(): void {
    if (this.size().x === 0) return;
    this.editor.planView.set(fitViewport(this.size(), this.contentBounds()));
  }

  protected zoomBy(factor: number): void {
    const s = this.size();
    this.setView(zoomAt(this.view(), { x: s.x / 2, y: s.y / 2 }, factor));
  }

  protected setTool(t: Tool): void {
    if (t === 'opening' && !this.areaToolUsable()) return;
    this.tool.set(t);
    this.chain.set(null);
    this.lengthEntry.set('');
    this.placing.set(null);
    this.tapeFrom.set(null); // a finished measurement stays, to draw and snap to
    if (t !== 'select') this.selection.set(null);
  }

  protected deleteSelection(): void {
    const items = this.selectedItems();
    if (items.length > 1) {
      const ids = new Set(items);
      this.edit((f) => pruneGroups({ ...f, items: f.items.filter((i) => !ids.has(i.id)) }));
      this.selectItems([]);
      return;
    }
    const sel = this.selection();
    if (sel) this.deleteTarget(sel);
  }

  private deleteTarget(sel: NonNullable<Selection>): void {
    const below = this.belowFloor()?.floor;
    if (sel.kind === 'stair') {
      if (below) this.store.updateFloor(below.id, (f) => pruneGroups({ ...f, items: f.items.filter((i) => i.id !== sel.id) }));
      this.selection.set(null);
      this.hover.set(null);
      return;
    }
    const ti = this.ti();
    this.edit((f) => {
      switch (sel.kind) {
        case 'wall':
          return deleteWalls(f, new Set([sel.id]), ti);
        case 'node':
          return deleteNode(f, sel.id, ti);
        case 'door':
          return { ...f, doors: f.doors.filter((d) => d.id !== sel.id) };
        case 'item':
          return pruneGroups({ ...f, items: f.items.filter((i) => i.id !== sel.id) });
        case 'stair':
          return f;
        case 'opening':
          return withAreas(f, areasOf(f).filter((o) => o.id !== sel.id));
      }
    });
    if (this.selection()?.id === sel.id) this.selection.set(null);
    this.hover.set(null);
  }

  /**
   * Turns the selected furniture a quarter turn clockwise. Several pieces (a group,
   * or a multi-selection) turn together about the middle of their footprints, so
   * they keep their places relative to one another; a single piece turns in place.
   */
  protected rotateSelection(): void {
    const sel = this.selection();
    if (sel?.kind === 'stair') return this.rotateArrival(sel.id);
    const ids = new Set(this.selectedItems());
    const items = this.floor().items.filter((i) => ids.has(i.id));
    if (items.length === 0) return;
    const boxes = items.map((it) => {
      const cat = CATALOG_BY_ID.get(it.type);
      const { w, d } = cat ? rotatedSize(itemShape(cat, this.rise()), it.rotation) : { w: 0, d: 0 };
      return { x0: it.x - w / 2, x1: it.x + w / 2, y0: it.y - d / 2, y1: it.y + d / 2 };
    });
    const cx = (Math.min(...boxes.map((b) => b.x0)) + Math.max(...boxes.map((b) => b.x1))) / 2;
    const cy = (Math.min(...boxes.map((b) => b.y0)) + Math.max(...boxes.map((b) => b.y1))) / 2;
    const turned = new Map(rotateAbout(items, cx, cy).map((it) => [it.id, it]));
    this.edit((f) => ({ ...f, items: f.items.map((i) => turned.get(i.id) ?? i) }));
    // Mid-drag, positions come from the drag's starting layout, which would undo the
    // turn on the next move: carry on dragging from the turned layout instead.
    const drag = this.interaction();
    const at = this.cursor();
    if (drag.mode === 'drag' && drag.target.kind === 'item' && at) this.interaction.set({ ...drag, base: this.floor(), start: at });
  }

  /** Turns a stair arriving from the floor below in place (it belongs to that floor). */
  private rotateArrival(id: string): void {
    const below = this.belowFloor()?.floor;
    if (!below) return;
    this.store.updateFloor(below.id, (f) => ({
      ...f,
      items: f.items.map((i) => (i.id === id ? { ...i, rotation: ((i.rotation + 90) % 360) as Rotation } : i)),
    }));
    const drag = this.interaction();
    const at = this.cursor();
    const now = this.store.floors().find((f) => f.id === below.id);
    if (drag.mode === 'drag' && drag.target.kind === 'stair' && at && now) this.interaction.set({ ...drag, base: now, start: at });
  }

  /** Duplicates the selected furniture (groups included), offset a foot, and selects the copies. */
  protected duplicateSelection(): void {
    const f0 = this.floor();
    const ids = new Set(this.selectedItems());
    const copyIds = new Map<string, string>();
    const copies = f0.items
      .filter((i) => ids.has(i.id))
      .map((it): FurnitureItem => {
        copyIds.set(it.id, newId());
        return { ...it, id: copyIds.get(it.id)!, x: it.x + 1, y: it.y + 1 };
      });
    if (copies.length === 0) return;
    const groups = copyGroups(unitsOf([...ids], f0.groups), f0.groups, copyIds);
    this.edit((f) => ({ ...f, items: [...f.items, ...copies], groups: [...f.groups, ...groups] }));
    this.selectItems(copies.map((c) => c.id));
  }

  /**
   * G: groups the selected pieces (and groups) into one group, or — when the
   * selection is a single group — ungroups it, leaving its parts selected.
   */
  protected toggleGroup(): void {
    const groups = this.floor().groups;
    const units = unitsOf(this.selectedItems(), groups);
    if (units.length > 1) this.edit((f) => group(f, units));
    else if (units.length === 1 && isGroup(units[0], groups)) this.edit((f) => ungroup(f, units[0]));
  }

  /** Selects a set of furniture (empty clears the selection). */
  private selectItems(ids: string[]): void {
    this.picked.set(ids);
    this.selection.set(ids.length ? { kind: 'item', id: ids.at(-1)! } : null);
  }

  /** Turns the selected wall into a room divider, or a divider back into a wall. */
  protected toggleDivider(): void {
    const sel = this.selection();
    if (sel?.kind !== 'wall') return;
    const wall = this.floor().walls.find((w) => w.id === sel.id);
    if (!wall) return;
    const ti = this.ti();
    this.edit((f) => setDividers(f, new Set([sel.id]), !wall.divider, ti));
  }

  protected flipDoor(): void {
    const sel = this.selection();
    if (sel?.kind !== 'door') return;
    this.edit((f) => ({ ...f, doors: f.doors.map((d) => (d.id === sel.id ? { ...d, ...nextSwing(d) } : d)) }));
  }

  /** Sets the kind of the selected door (or of new doors), moving its width to one that kind comes in. */
  protected setDoorKind(kind: DoorKind): void {
    const sel = this.selection();
    if (sel?.kind === 'door') {
      this.edit((f) => ({ ...f, doors: f.doors.map((d) => (d.id === sel.id ? { ...d, kind, width: fitDoorWidth(kind, d.width) } : d)) }));
    } else {
      this.doorKind.set(kind);
      this.doorWidth.set(fitDoorWidth(kind, this.doorWidth()));
    }
  }

  /** Sets the height of the selected garage door (or of new ones). */
  protected setDoorHeight(height: number): void {
    const sel = this.selection();
    if (sel?.kind === 'door') {
      this.edit((f) => ({ ...f, doors: f.doors.map((d) => (d.id === sel.id ? { ...d, height } : d)) }));
    } else this.doorHeight.set(height);
  }

  protected setDoorWidth(width: number): void {
    const sel = this.selection();
    if (sel?.kind === 'door') {
      this.edit((f) => ({ ...f, doors: f.doors.map((d) => (d.id === sel.id ? { ...d, width } : d)) }));
    } else this.doorWidth.set(width);
  }

  protected startPlacing(pick: CatalogPick): void {
    this.setTool('select');
    this.placing.set({ item: pick.item, rotation: 0, pos: null, held: true });
    try {
      this.host.nativeElement.setPointerCapture(pick.event.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  // ------------------------------------------------------------------ pointer input

  protected onCanvasDown(e: PointerEvent): void {
    if (isFromUi(e)) return;
    const p = this.localPoint(e);
    const w = screenToWorld(this.view(), p);
    this.cursor.set(w);
    this.alt.set(e.altKey);
    this.shift.set(e.shiftKey);

    // Right-click: finishes a wall chain or cancels a placement; otherwise deletes
    // the wall, corner, piece of furniture or opening under the pointer.
    if (e.button === 2) {
      if (this.chain()) this.endChain();
      else if (this.placing()) this.placing.set(null);
      else if (this.tool() === 'tape') this.clearTape();
      else {
        const target = this.hitAt(w);
        if (target && target.kind !== 'door') this.deleteTarget(target);
      }
      return;
    }
    if (e.button === 1) {
      this.startPan(e, p);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();

    const pl = this.placing();
    if (pl) {
      if (pl.pos) this.addItem(pl.item, pl.pos, pl.rotation, !e.shiftKey);
      if (!e.shiftKey) this.placing.set(null);
      return;
    }

    switch (this.tool()) {
      case 'select': {
        const target = this.hitAt(w);
        if (!target) return this.startPan(e, p);
        this.capture(e);
        this.interaction.set({ mode: 'press', pointerId: e.pointerId, start: p, target });
        return;
      }
      case 'wall': {
        if (this.chain()) {
          this.commitChainWall();
          return;
        }
        this.capture(e);
        const from = snapPoint(this.ctx(), w, this.snapTol(), this.step());
        this.interaction.set({ mode: 'wall-press', pointerId: e.pointerId, start: p, from, moved: false });
        return;
      }
      case 'door': {
        const g = this.doorGhost();
        if (!g) return this.startPan(e, p);
        if (g.valid) this.addDoor(g.spot.host, g.spot.at, g.door);
        return;
      }
      case 'tape': {
        const from = this.tapeFrom();
        if (from) {
          this.tapeDone.set({ a: from, b: this.tapeEndFrom(from)!.p });
          this.tapeFrom.set(null);
          return;
        }
        this.capture(e);
        // Snap first, so a new measurement can start from the last mark; then replace it.
        const snap = snapPoint(this.ctx(), w, this.snapTol(), this.step());
        this.tapeDone.set(null);
        this.interaction.set({ mode: 'tape-press', pointerId: e.pointerId, start: p, from: snap, moved: false });
        return;
      }
      case 'opening': {
        this.capture(e);
        const from = this.snapAreaPoint(w);
        this.interaction.set({ mode: 'opening-draw', pointerId: e.pointerId, from, to: from });
        return;
      }
    }
  }

  protected onPointerMove(e: PointerEvent): void {
    const p = this.localPoint(e);
    const w = screenToWorld(this.view(), p);
    this.cursor.set(w);
    this.alt.set(e.altKey);
    this.shift.set(e.shiftKey);

    const pl = this.placing();
    if (pl) {
      const inside = p.x >= 0 && p.y >= 0 && p.x <= this.size().x && p.y <= this.size().y && !isFromUi(e);
      const extent = rotatedBox(itemShape(pl.item, this.rise(), this.floorAbove()).box, pl.rotation);
      this.placing.set({ ...pl, pos: inside ? snapItem(this.ctx(), w, extent, this.snapTol(), this.step()) : null });
      return;
    }

    const it = this.interaction();
    switch (it.mode) {
      case 'idle':
        if (this.tool() === 'select' && !isFromUi(e)) this.hover.set(this.hitAt(w));
        else this.hover.set(null);
        return;
      case 'pan': {
        const v = it.startView;
        const moved = it.moved || Math.hypot(p.x - it.start.x, p.y - it.start.y) >= DRAG_START_THRESHOLD_PX;
        this.interaction.set({ ...it, moved });
        this.setView({ ...v, tx: v.tx + p.x - it.start.x, ty: v.ty + p.y - it.start.y });
        return;
      }
      case 'press':
        if (Math.hypot(p.x - it.start.x, p.y - it.start.y) < DRAG_START_THRESHOLD_PX) return;
        this.store.beginGesture();
        // Dragging something unselected selects it first: a piece of furniture with its group.
        if (it.target.kind === 'item') {
          if (!this.selectedItems().includes(it.target.id)) this.selectItems(unitItems(it.target.id, this.floor().groups));
        } else {
          this.picked.set([]);
          this.selection.set(selectionOf(it.target));
        }
        const base = it.target.kind === 'stair' ? this.belowFloor()!.floor : this.floor();
        this.interaction.set({ mode: 'drag', pointerId: it.pointerId, target: it.target, base, start: screenToWorld(this.view(), it.start) });
        this.applyDrag(w);
        return;
      case 'drag':
        this.applyDrag(w);
        return;
      case 'wall-press':
      case 'tape-press':
        if (!it.moved && Math.hypot(p.x - it.start.x, p.y - it.start.y) >= DRAG_START_THRESHOLD_PX) {
          this.interaction.set({ ...it, moved: true });
        }
        return;
      case 'opening-draw':
        this.interaction.set({ ...it, to: this.snapAreaPoint(w) });
        return;
    }
  }

  protected onPointerUp(e: PointerEvent): void {
    const pl = this.placing();
    if (pl?.held) {
      if (pl.pos) {
        this.addItem(pl.item, pl.pos, pl.rotation, true);
        this.placing.set(null);
      } else {
        this.placing.set({ ...pl, held: false }); // released over the panel: click to place
      }
      return;
    }

    const it = this.interaction();
    if (it.mode === 'idle' || it.pointerId !== e.pointerId) return;
    this.interaction.set({ mode: 'idle' });
    switch (it.mode) {
      case 'pan':
        if (!it.moved && this.tool() === 'select') this.selection.set(null);
        break;
      case 'press':
        this.click(it.target);
        break;
      case 'drag':
        if (it.target.kind === 'wall' || it.target.kind === 'node') {
          const ti = this.ti();
          this.edit((f) => normalize(f, ti));
        }
        this.store.endGesture();
        break;
      case 'wall-press':
        if (it.moved) {
          const prev = this.wallPreviewFrom(it.from.p);
          if (prev) this.addWallSegment(it.from.p, prev);
        } else {
          this.chain.set(it.from.p);
        }
        break;
      case 'tape-press':
        if (it.moved) this.tapeDone.set({ a: it.from.p, b: this.tapeEndFrom(it.from.p)!.p });
        else this.tapeFrom.set(it.from.p);
        break;
      case 'opening-draw': {
        const b = boxOf(it.from, it.to);
        if (b.x1 - b.x0 >= 1 && b.y1 - b.y0 >= 1) {
          const o: FloorOpening = { id: newId(), ...b };
          this.edit((f) => withAreas(f, [...areasOf(f), o]));
          this.selection.set({ kind: 'opening', id: o.id });
          this.tool.set('select');
        }
        break;
      }
    }
  }

  protected onDoubleClick(e: MouseEvent): void {
    if (isFromUi(e) || (e.target as Element).closest?.('app-furniture-panel')) return;
    if (this.tool() !== 'select') {
      this.endChain();
      return;
    }
    // Double-clicking a room names it, even over furniture, stairs or an opening in it;
    // only what bounds rooms (walls, their corners, doors) gets in the way.
    const w = screenToWorld(this.view(), this.localPoint(e));
    const hit = this.hitAt(w);
    if (hit && (hit.kind === 'wall' || hit.kind === 'node' || hit.kind === 'door')) return;
    const room = this.rooms().find((r) => pointIn(r.cells, w.x, w.y));
    if (!room) return;
    const current = this.floor().roomNames.find((n) => pointIn(room.cells, n.x, n.y));
    this.naming.set({
      room,
      at: current ? { x: current.x, y: current.y } : { x: room.x, y: room.y },
      value: current?.name ?? '',
      unheated: !!current?.unheated,
    });
  }

  /** Saves the room name being typed (an empty name removes it). */
  protected commitName(): void {
    const n = this.naming();
    if (!n) return;
    this.naming.set(null);
    const name = n.value.trim();
    this.edit((f) => {
      const others = f.roomNames.filter((r) => !pointIn(n.room.cells, r.x, r.y));
      const pin = { id: newId(), x: n.at.x, y: n.at.y, name, ...(n.unheated ? { unheated: true } : {}) };
      return { ...f, roomNames: name ? [...others, pin] : others };
    });
  }

  protected setNameValue(value: string): void {
    this.naming.update((n) => n && { ...n, value });
  }

  /** Marks the room being named unheated, or heated again (saved with its name). */
  protected toggleUnheated(): void {
    this.naming.update((n) => n && { ...n, unheated: !n.unheated });
  }

  protected onNameKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') this.commitName();
    else if (e.key === 'Escape') this.naming.set(null);
  }

  protected onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED * (e.deltaMode === 1 ? 16 : 1));
    this.setView(zoomAt(this.view(), this.localPoint(e), factor));
  }

  protected onPointerLeave(): void {
    if (this.interaction().mode === 'idle') {
      this.hover.set(null);
      if (!this.placing() && !this.chain()) this.cursor.set(null);
    }
  }

  // ------------------------------------------------------------------ keyboard

  protected onKeyDown(e: KeyboardEvent): void {
    this.alt.set(e.altKey);
    this.shift.set(e.shiftKey);
    // A dropdown (door width) keeps focus after a pick; the editor's own keys still work.
    const editorKeys = [' ', 'q', 'Q', 'Escape'];
    if (e.target instanceof HTMLSelectElement && editorKeys.includes(e.key)) e.target.blur();
    else if (isTyping(e)) return;
    if (e.metaKey || (e.ctrlKey && e.key.toLowerCase() !== 'd')) return;
    // Q works as Escape, in every tool.
    const key = e.key === 'q' || e.key === 'Q' ? 'Escape' : e.key;

    if (key === ' ' && !this.lengthEntry()) {
      this.setTool('select');
      e.preventDefault();
      return;
    }

    if (this.tool() === 'wall' && this.chain()) {
      if (/^[0-9.'"\- ]$/.test(key)) {
        this.lengthEntry.update((s) => s + key);
        e.preventDefault();
        return;
      }
      if (key === 'Backspace' && this.lengthEntry()) {
        this.lengthEntry.update((s) => s.slice(0, -1));
        e.preventDefault();
        return;
      }
      if (key === 'Enter') {
        this.commitChainWall();
        e.preventDefault();
        return;
      }
    }

    switch (key) {
      case 'Escape':
        if (this.placing()) this.placing.set(null);
        else if (this.chain()) this.endChain();
        else if (this.tapeFrom() || this.tapeDone()) this.clearTape();
        else if (this.selection()) this.selection.set(null);
        else this.setTool('select');
        break;
      case 'Delete':
      case 'Backspace':
        this.deleteSelection();
        break;
      case 'r':
      case 'R': {
        const pl = this.placing();
        if (pl) this.placing.set({ ...pl, rotation: (((pl.rotation + 90) % 360) as Rotation) });
        else if (this.tool() === 'door') this.doorTurns.update((n) => n + 1);
        else if (this.selection()?.kind === 'door') this.flipDoor();
        else this.rotateSelection();
        break;
      }
      case 'd':
      case 'D':
        if (e.ctrlKey) this.duplicateSelection();
        else this.setTool('door');
        break;
      case 'm':
      case 'M':
        this.setTool('select');
        break;
      case 'w':
      case 'W':
        this.setTool('wall');
        break;
      case 'o':
      case 'O':
        this.setTool('opening');
        break;
      case 't':
      case 'T':
        this.setTool('tape');
        break;
      case 'g':
      case 'G':
        this.toggleGroup();
        break;
      case 'PageUp':
      case 'PageDown': {
        const floors = this.store.floors();
        const next = floors[this.floorIndex() + (key === 'PageUp' ? 1 : -1)];
        if (next) this.editor.selectFloor(next.id);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  protected onKeyUp(e: KeyboardEvent): void {
    this.alt.set(e.altKey);
    this.shift.set(e.shiftKey);
  }

  // ------------------------------------------------------------------ internals

  /** Applies an edit to the active floor. */
  private edit(fn: (f: Floor) => Floor): void {
    this.store.updateFloor(this.floor().id, fn);
  }

  private resetTransient(): void {
    this.selection.set(null);
    this.hover.set(null);
    this.chain.set(null);
    this.lengthEntry.set('');
    this.placing.set(null);
    this.clearTape();
    this.naming.set(null);
    if (this.tool() === 'opening' && !this.areaToolUsable()) this.tool.set('select');
  }

  private clearTape(): void {
    this.tapeFrom.set(null);
    this.tapeDone.set(null);
  }

  /**
   * Where a tape from `from` ends at the cursor: square to it, snapping like a wall
   * end; with Shift, at any angle, snapping like a free point.
   */
  private tapeEndFrom(from: Pt): Snap | null {
    const c = this.cursor();
    if (!c) return null;
    if (this.shift()) return snapPoint(this.ctx(), c, this.snapTol(), this.step());
    const axis: Axis = Math.abs(c.x - from.x) >= Math.abs(c.y - from.y) ? 'x' : 'y';
    return snapAlong(this.ctx(), from, axis, axis === 'x' ? c.x : c.y, this.snapTol(), this.step());
  }

  private click(target: Target): void {
    const sel = this.selection();
    if (target.kind === 'door' && sel?.kind === 'door' && sel.id === target.id) {
      this.flipDoor();
      return;
    }
    if (target.kind === 'item') {
      // A piece of furniture selects with its whole group; Shift adds or removes the lot.
      const unit = unitItems(target.id, this.floor().groups);
      const ids = this.selectedItems();
      if (!this.shift()) this.selectItems(unit);
      else if (ids.includes(target.id)) this.selectItems(ids.filter((x) => !unit.includes(x)));
      else this.selectItems([...ids, ...unit]);
      return;
    }
    this.picked.set([]);
    this.selection.set(selectionOf(target));
  }

  private applyDrag(w: Pt): void {
    const it = this.interaction();
    if (it.mode !== 'drag') return;
    const { target, base, start } = it;
    const region = this.region();
    const ti = this.ti();
    const step = this.step();

    switch (target.kind) {
      case 'wall': {
        const g = wallGeoms(base).find((x) => x.wall.id === target.id);
        if (!g) return;
        const raw = g.coord + (g.axis === 'x' ? w.y - start.y : w.x - start.x);
        const skip = lineGroup(base, g.a.id, g.axis);
        const coord = this.snapCoord(raw, g.axis === 'x' ? 'y' : 'x', skip, step);
        const delta = backoff(coord - g.coord, step, (d) => moveIsValid(base, moveWallLine(base, target.id, d), region, ti));
        this.edit(() => moveWallLine(base, target.id, delta));
        return;
      }
      case 'node': {
        const n = base.nodes.find((x) => x.id === target.id);
        if (!n) return;
        const tx = this.snapCoord(n.x + w.x - start.x, 'x', lineGroup(base, n.id, 'y'), step) - n.x;
        const ty = this.snapCoord(n.y + w.y - start.y, 'y', lineGroup(base, n.id, 'x'), step) - n.y;
        const ok = (dx: number, dy: number) => moveIsValid(base, moveNode(base, n.id, dx, dy), region, ti);
        const dx = backoff(tx, step, (d) => ok(d, 0));
        const dy = backoff(ty, step, (d) => ok(dx, d));
        this.edit(() => moveNode(base, n.id, dx, dy));
        return;
      }
      case 'door': {
        const p = placeDoors(base, region, ti).find((d) => d.door.id === target.id);
        if (!p) return;
        const along = p.axis === 'x' ? w.x : w.y;
        const at = clampAlong(snapTo(along, step), p.door.width, p.lo, p.hi);
        const clash = this.doors().some(
          (d) => d.door.id !== target.id && sameHost(d.door.host, p.door.host) && Math.abs(d.at - at) < (d.door.width + p.door.width) / 2 - 1e-6,
        );
        if (!clash) this.edit((f) => ({ ...f, doors: f.doors.map((d) => (d.id === target.id ? { ...d, at } : d)) }));
        return;
      }
      case 'item': {
        const item = base.items.find((i) => i.id === target.id);
        const cat = item && CATALOG_BY_ID.get(item.type);
        if (!item || !cat) return;
        const center = { x: item.x + w.x - start.x, y: item.y + w.y - start.y };
        const selected = this.selectedItems();
        const moving = new Set(selected.includes(target.id) ? selected : [target.id]);
        const extent = rotatedBox(itemShape(cat, this.rise(), this.floorAbove()).box, item.rotation);
        const pos = snapItem(this.ctx(), center, extent, this.snapTol(), step, moving);
        // The held piece snaps; the rest of a multi-selection moves with it.
        const [dx, dy] = [pos.x - item.x, pos.y - item.y];
        const from = new Map(base.items.map((i) => [i.id, i]));
        this.edit((f) => ({
          ...f,
          items: f.items.map((i) => (moving.has(i.id) ? { ...i, x: from.get(i.id)!.x + dx, y: from.get(i.id)!.y + dy } : i)),
        }));
        return;
      }
      case 'stair': {
        // The stair lives on the floor below: move it there, snapping to that floor's walls.
        const below = this.belowFloor();
        const item = base.items.find((i) => i.id === target.id);
        const cat = item && CATALOG_BY_ID.get(item.type);
        if (!below || !item || !cat) return;
        const extent = rotatedBox(itemShape(cat, below.rise, true).box, item.rotation);
        const center = { x: item.x + w.x - start.x, y: item.y + w.y - start.y };
        const pos = snapItem(below.ctx, center, extent, this.snapTol(), step, new Set([item.id]));
        this.store.updateFloor(base.id, (f) => ({ ...f, items: f.items.map((i) => (i.id === item.id ? { ...i, x: pos.x, y: pos.y } : i)) }));
        return;
      }
      case 'opening': {
        const o = areasOf(base).find((x) => x.id === target.id);
        if (!o) return;
        let next: FloorOpening;
        if (target.edge) {
          const v = target.edge === 'N' || target.edge === 'S' ? this.snapAreaCoord(w.y, 'y', o.id) : this.snapAreaCoord(w.x, 'x', o.id);
          next = resizeOpening(o, target.edge, v);
        } else {
          const dx = this.snapAreaShift(o.x0, o.x1, w.x - start.x, 'x', o.id);
          const dy = this.snapAreaShift(o.y0, o.y1, w.y - start.y, 'y', o.id);
          next = { ...o, x0: o.x0 + dx, x1: o.x1 + dx, y0: o.y0 + dy, y1: o.y1 + dy };
        }
        this.edit((f) => withAreas(f, areasOf(f).map((x) => (x.id === target.id ? next : x))));
        return;
      }
    }
  }

  /** What's under the pointer on this floor, including stairs arriving from below. */
  private hitAt(w: Pt): Target | null {
    return hitTest(this.ctx(), w, this.tol(), this.areas(), this.stairHandles());
  }

  /**
   * Where an area being drawn snaps. On a basement, undug areas line up with the
   * house's walls (section edges) and each other, since their edges become
   * foundation walls; elsewhere, openings snap like walls.
   */
  private snapAreaPoint(w: Pt): Pt {
    if (!this.basement()) return snapPoint(this.ctx(), w, this.snapTol(), this.step()).p;
    return { x: this.snapAreaCoord(w.x, 'x'), y: this.snapAreaCoord(w.y, 'y') };
  }

  /** Basement area edges line up with these: section edges and other areas' edges. */
  private readonly areaLines = computed(() => {
    const enclosed = this.sections().filter((s) => !s.patio.enabled);
    return {
      x: enclosed.flatMap((s) => [x0(s.rect), x1(s.rect)]),
      y: enclosed.flatMap((s) => [y0(s.rect), y1(s.rect)]),
    };
  });

  private areaCandidates(axis: Axis, skipId?: string): number[] {
    const others = this.areas().filter((o) => o.id !== skipId);
    return [...this.areaLines()[axis], ...others.flatMap((o) => (axis === 'x' ? [o.x0, o.x1] : [o.y0, o.y1]))];
  }

  /** An area edge coordinate: snapped to a line in reach on a basement, else to the grid. */
  private snapAreaCoord(v: number, axis: Axis, skipId?: string): number {
    if (!this.basement()) return snapTo(v, this.step());
    let best = snapTo(v, this.step());
    let bestDist = this.snapTol();
    for (const c of this.areaCandidates(axis, skipId)) {
      if (Math.abs(c - v) < bestDist) [best, bestDist] = [c, Math.abs(c - v)];
    }
    return best;
  }

  /** How far to shift an area spanning lo..hi by about `d`: so an edge lands on a line, on a basement. */
  private snapAreaShift(lo: number, hi: number, d: number, axis: Axis, skipId: string): number {
    let best = snapTo(d, this.step());
    if (!this.basement()) return best;
    let bestDist = this.snapTol();
    for (const c of this.areaCandidates(axis, skipId)) {
      for (const e of [lo + d, hi + d]) {
        if (Math.abs(c - e) < bestDist) [best, bestDist] = [d + c - e, Math.abs(c - e)];
      }
    }
    return best;
  }

  /** Snaps a coordinate to a node or exterior face lined up with it, else the grid. */
  private snapCoord(v: number, axis: Axis, skip: ReadonlySet<string>, step: number): number {
    const tol = this.snapTol();
    let best = snapTo(v, step);
    let bestDist = tol;
    for (const n of this.floor().nodes) {
      if (skip.has(n.id)) continue;
      const c = axis === 'x' ? n.x : n.y;
      if (Math.abs(c - v) < bestDist) [best, bestDist] = [c, Math.abs(c - v)];
    }
    return best;
  }

  private wallPreviewFrom(from: Pt): Pt | null {
    const c = this.cursor();
    if (!c) return null;
    const axis: Axis = Math.abs(c.x - from.x) >= Math.abs(c.y - from.y) ? 'x' : 'y';
    return snapAlong(this.ctx(), from, axis, axis === 'x' ? c.x : c.y, this.snapTol(), this.step()).p;
  }

  private commitChainWall(): void {
    const from = this.chain();
    const end = this.chainEnd();
    if (!from || !end) return;
    if (!this.addWallSegment(from, end.p)) return;
    this.lengthEntry.set('');
    this.chain.set(connects(end) ? null : end.p);
  }

  /** Adds a wall (or room divider, per the wall tool's setting) if it fits; returns whether it did. */
  private addWallSegment(from: Pt, to: Pt): boolean {
    const ti = this.ti();
    if (Math.abs(to.x - from.x) + Math.abs(to.y - from.y) < 1e-6 || !wallFits(from, to, this.region(), ti)) return false;
    const divider = this.wallKind() === 'divider';
    this.edit((f) => addWall(f, from, to, ti, divider));
    return true;
  }

  private endChain(): void {
    this.chain.set(null);
    this.lengthEntry.set('');
  }

  private addDoor(host: DoorHost, at: number, swing: Pick<Door, 'swing' | 'hinge'>): void {
    const id = newId();
    const door: Door = { id, host, at, width: this.doorWidth(), kind: this.doorKind(), swing: swing.swing, hinge: swing.hinge };
    if (door.kind === 'garage') door.height = this.doorHeight();
    this.edit((f) => ({ ...f, doors: [...f.doors, door] }));
  }

  private addItem(item: CatalogItem, pos: Pt, rotation: Rotation, select: boolean): void {
    const it: FurnitureItem = { id: newId(), type: item.id, x: pos.x, y: pos.y, rotation };
    this.edit((f) => ({ ...f, items: [...f.items, it] }));
    if (select) this.selectItems([it.id]);
  }

  /** How an item draws on a floor with the given rise (and whether there's a floor above). */
  private itemView(it: FurnitureItem, rise: number, floorAbove: boolean) {
    const cat = CATALOG_BY_ID.get(it.type);
    if (!cat) return null;
    const shape = itemShape(cat, rise, floorAbove);
    return {
      id: it.id,
      transform: `translate(${it.x} ${it.y}) rotate(${it.rotation})`,
      prims: shape.symbol,
      tint: CATEGORY_TINT[cat.category],
      box: shape.box,
    };
  }

  private startPan(e: PointerEvent, p: Point): void {
    this.capture(e);
    this.interaction.set({ mode: 'pan', pointerId: e.pointerId, start: p, startView: this.view(), moved: false });
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
    const r = this.canvas().nativeElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
}

function selectionOf(t: Target): Selection {
  return { kind: t.kind, id: t.id };
}

/** A floor with its drawn areas replaced (see `areasOf`). */
function withAreas(f: Floor, areas: FloorOpening[]): Floor {
  return isBasement(f) ? { ...f, unexcavated: areas } : { ...f, openings: areas };
}

function boxOf(a: Pt, b: Pt): Box {
  return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
}

/**
 * The largest move toward `target` (stepping back toward 0 by `step`) that `ok`
 * accepts. Zero is always acceptable: it's where the drag started.
 */
function backoff(target: number, step: number, ok: (d: number) => boolean): number {
  if (Math.abs(target) < 1e-9 || ok(target)) return target;
  const sign = Math.sign(target);
  for (let d = snapTo(target, step) - sign * step; d * sign > 1e-9; d -= sign * step) {
    if (ok(d)) return d;
  }
  return 0;
}

function isFromUi(e: Event): boolean {
  return e.target instanceof Element && !!e.target.closest('.ui, app-furniture-panel, app-floor-stack, .p-tooltip');
}

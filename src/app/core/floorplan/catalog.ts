import { STORY } from '../model/defaults';
import { Box, cellsWhere, pointInBox } from './region';

/**
 * Standard furniture and fixtures for laying out rooms. Items aren't modeled in
 * detail: each is a few boxes for the 3D view and a simple top-down symbol for the
 * plan, at real-world sizes (ft).
 *
 * Local coordinates: origin at the item's center; at rotation 0 the item's back
 * (headboard, sofa back, toilet tank, appliance back) is toward −y (north), so it
 * sits naturally against a north wall.
 */

export type CategoryId = 'bedroom' | 'bath' | 'kitchen' | 'living' | 'dining' | 'laundry' | 'office' | 'other';

export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'bedroom', label: 'Bedroom' },
  { id: 'bath', label: 'Bathroom' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'living', label: 'Living' },
  { id: 'dining', label: 'Dining' },
  { id: 'laundry', label: 'Laundry' },
  { id: 'office', label: 'Office' },
  { id: 'other', label: 'Stairs & misc' },
];

/** Plan symbol styles: body = main tinted shape, soft = light cushion/basin, solid = dark accent, line = detail stroke. */
export type PrimStyle = 'body' | 'soft' | 'solid' | 'line' | 'dash';

export type Prim =
  | { t: 'rect'; x: number; y: number; w: number; h: number; r?: number; s: PrimStyle }
  | { t: 'circle'; cx: number; cy: number; r: number; s: PrimStyle }
  | { t: 'ellipse'; cx: number; cy: number; rx: number; ry: number; s: PrimStyle }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; s: PrimStyle }
  | { t: 'path'; d: string; s: PrimStyle }
  | { t: 'text'; x: number; y: number; text: string; size: number };

/** A box of an item in local coordinates, from z0 to z1 above the floor. */
export interface Part {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z0: number;
  z1: number;
  color?: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  category: CategoryId;
  /** Footprint at rotation 0 (ft). */
  w: number;
  d: number;
  color: string;
  parts: Part[];
  symbol: Prim[];
  /** Stairs are laid out for their floor's height (see `itemShape`). */
  stairs?: boolean;
}

const IN = 1 / 12;
const COLOR = {
  silver: '#d3d8dc',
  rack: '#3b4148',
  plate: '#2b2f33',
  chrome: '#aeb4b9',
  fabric: '#8ea3bd',
  linen: '#e9e4da',
  wood: '#a07a55',
  darkWood: '#7a5a3e',
  porcelain: '#f2f4f5',
  steel: '#c3c8cc',
  counter: '#d8d2c4',
  cabinet: '#c9bfae',
  sofa: '#9a8f80',
  appliance: '#e4e7ea',
  car: '#5b6f8c',
  stairs: '#b8946c',
  piano: '#23272b',
  felt: '#2f6b4f',
  brick: '#a0634d',
  stone: '#8f8a84',
  dark: '#4a5560',
};

const box = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, color?: string): Part => ({
  x0,
  y0,
  x1,
  y1,
  z0,
  z1,
  color,
});
const rect = (x: number, y: number, w: number, h: number, s: PrimStyle, r?: number): Prim => ({ t: 'rect', x, y, w, h, s, r });
const line = (x1: number, y1: number, x2: number, y2: number, s: PrimStyle = 'line'): Prim => ({ t: 'line', x1, y1, x2, y2, s });
const outline = (w: number, d: number, r = 0.08): Prim => rect(-w / 2, -d / 2, w, d, 'body', r);

// ===================================================================== builders

function bed(id: string, name: string, w: number, d: number): CatalogItem {
  const pillows: Prim[] =
    w >= 4.4
      ? [rect(-w / 2 + 0.3, -d / 2 + 0.45, (w - 0.8) / 2, 1.05, 'soft', 0.25), rect(0.1, -d / 2 + 0.45, (w - 0.8) / 2, 1.05, 'soft', 0.25)]
      : [rect(-w / 2 + 0.35, -d / 2 + 0.45, w - 0.7, 1.05, 'soft', 0.25)];
  const fold = -d / 2 + 2.1;
  return {
    id,
    name,
    category: 'bedroom',
    w,
    d,
    color: COLOR.fabric,
    parts: [box(-w / 2, -d / 2 + 0.25, w / 2, d / 2, 0, 2), box(-w / 2, -d / 2, w / 2, -d / 2 + 0.25, 0, 3.75, COLOR.wood)],
    symbol: [
      outline(w, d, 0.15),
      rect(-w / 2, -d / 2, w, 0.25, 'solid'),
      ...pillows,
      line(-w / 2, fold, w / 2, fold),
      { t: 'path', d: `M ${w / 2 - 1.2} ${fold} L ${w / 2} ${fold + 1.2}`, s: 'line' },
    ],
  };
}

function simple(
  id: string,
  name: string,
  category: CategoryId,
  w: number,
  d: number,
  h: number,
  color: string,
  extra: Prim[] = [],
  r = 0.08,
): CatalogItem {
  return { id, name, category, w, d, color, parts: [box(-w / 2, -d / 2, w / 2, d / 2, 0, h)], symbol: [outline(w, d, r), ...extra] };
}

/** Boxes filling `r` from z0 to z1, less the `holes` (each wholly inside it). */
function boxesAround(r: Box, holes: readonly Box[], z0: number, z1: number, color?: string): Part[] {
  return cellsWhere([r, ...holes], (x, y) => pointInBox(r, x, y) && !holes.some((h) => pointInBox(h, x, y))).map((c) =>
    box(c.x0, c.y0, c.x1, c.y1, z0, z1, color),
  );
}

/**
 * A counter-height cabinet with sinks: the cabinet and countertop are built around
 * each basin, which is sunk `depth` into the top as a bowl of `basinColor` (a floor
 * and four thin sides), with a faucet behind it at `faucetY`.
 */
function sinkCabinet(
  w: number,
  d: number,
  height: number,
  basins: readonly Box[],
  depth: number,
  basinColor: string,
  faucetY: number,
): Part[] {
  const counter = 1.5 * IN;
  const side = 0.5 * IN;
  const floor = height - depth;
  const parts = [
    ...boxesAround({ x0: -w / 2, y0: -d / 2, x1: w / 2, y1: d / 2 - IN }, basins, 0, height - counter, COLOR.cabinet),
    ...boxesAround({ x0: -w / 2, y0: -d / 2, x1: w / 2, y1: d / 2 }, basins, height - counter, height, COLOR.counter),
  ];
  for (const b of basins) {
    parts.push(
      box(b.x0, b.y0, b.x1, b.y1, floor - IN, floor, basinColor),
      box(b.x0, b.y0, b.x1, b.y0 + side, floor, height, basinColor),
      box(b.x0, b.y1 - side, b.x1, b.y1, floor, height, basinColor),
      box(b.x0, b.y0 + side, b.x0 + side, b.y1 - side, floor, height, basinColor),
      box(b.x1 - side, b.y0 + side, b.x1, b.y1 - side, floor, height, basinColor),
    );
  }
  // One faucet per bowl, or one between a pair of bowls that touch (a double kitchen sink).
  const centers = basins.length === 2 && basins[1].x0 - basins[0].x1 < 0.5 ? [(basins[0].x1 + basins[1].x0) / 2] : basins.map((b) => (b.x0 + b.x1) / 2);
  for (const cx of centers) {
    const reach = Math.min(...basins.map((b) => b.y0)) + 0.3;
    parts.push(
      box(cx - 1 * IN, faucetY - 1 * IN, cx + 1 * IN, faucetY + 1 * IN, height, height + 10 * IN, COLOR.chrome),
      box(cx - 0.6 * IN, faucetY - 0.6 * IN, cx + 0.6 * IN, reach, height + 8.5 * IN, height + 10 * IN, COLOR.chrome),
    );
  }
  return parts;
}

/** A bathroom vanity (21" deep, 34" high) with one or two white oval basins (squared off in 3D). */
function vanity(id: string, name: string, w: number, sinks: 1 | 2): CatalogItem {
  const d = 21 * IN;
  const centers = sinks === 1 ? [0] : [-w / 4, w / 4];
  const [rx, ry, cy] = [Math.min(0.75, w / (2 * sinks) - 0.35), 0.5, 0.1];
  const faucetY = -d / 2 + 0.2;
  const basins = centers.map((cx): Box => ({ x0: cx - rx, x1: cx + rx, y0: cy - ry, y1: cy + ry }));
  return {
    id,
    name,
    category: 'bath',
    w,
    d,
    color: COLOR.counter,
    parts: sinkCabinet(w, d, 34 * IN, basins, 5 * IN, COLOR.porcelain, faucetY),
    symbol: [
      outline(w, d),
      ...centers.map((cx): Prim => ({ t: 'ellipse', cx, cy, rx, ry, s: 'soft' })),
      ...centers.map((cx): Prim => ({ t: 'circle', cx, cy: faucetY, r: 0.07, s: 'solid' })),
    ],
  };
}

/** A 36" kitchen sink base with a stainless double bowl. */
function kitchenSink(): CatalogItem {
  const [w, d] = [3, 2];
  const basins: Box[] = [
    { x0: -1.3, x1: -0.1, y0: -0.6, y1: 0.55 },
    { x0: 0.1, x1: 1.3, y0: -0.6, y1: 0.55 },
  ];
  return {
    id: 'sink-base',
    name: 'Sink cabinet 36"',
    category: 'kitchen',
    w,
    d,
    color: COLOR.counter,
    parts: sinkCabinet(w, d, 3, basins, 8 * IN, COLOR.silver, -0.8),
    symbol: [
      outline(w, d),
      ...basins.map((b) => rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 'soft', 0.12)),
      { t: 'circle', cx: 0, cy: -0.8, r: 0.07, s: 'solid' },
    ],
  };
}

/**
 * A standing coat rack, about 6' tall: a turned pole on four splayed feet, with two
 * tiers of hook arms (each ending in an upturned hook) and a knob on top.
 */
function coatRack(): CatalogItem {
  const reach = 10 * IN; // feet, center to tip
  const [pole, bar] = [0.75 * IN, 0.75 * IN];
  const arms = (z: number, len: number): Part[] =>
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].flatMap(([dx, dy]) => {
      const along = (a: number, b: number, z0: number, z1: number) =>
        dx !== 0
          ? box(Math.min(dx * a, dx * b), -bar / 2, Math.max(dx * a, dx * b), bar / 2, z0, z1)
          : box(-bar / 2, Math.min(dy * a, dy * b), bar / 2, Math.max(dy * a, dy * b), z0, z1);
      return [along(pole, len, z, z + 1 * IN), along(len - 1 * IN, len, z + 1 * IN, z + 3 * IN)];
    });
  const inset = reach - 1.25 * IN;
  const pad = (x: number, y: number) => box(x - 0.75 * IN, y - 0.75 * IN, x + 0.75 * IN, y + 0.75 * IN, 0, 0.5 * IN);
  const parts: Part[] = [
    // Feet: a cross of bars, each tip on a small pad.
    box(-reach, -bar, reach, bar, 0.5 * IN, 2 * IN),
    box(-bar, -reach, bar, reach, 0.5 * IN, 2 * IN),
    pad(inset, 0),
    pad(-inset, 0),
    pad(0, inset),
    pad(0, -inset),
    box(-pole, -pole, pole, pole, 0, 68 * IN),
    box(-1.25 * IN, -1.25 * IN, 1.25 * IN, 1.25 * IN, 68 * IN, 71 * IN),
    ...arms(64 * IN, 7 * IN),
    ...arms(56 * IN, 5 * IN),
  ];
  const tip = 7 * IN;
  return {
    id: 'coat-rack',
    name: 'Coat rack',
    category: 'other',
    w: 2 * reach,
    d: 2 * reach,
    color: COLOR.darkWood,
    parts,
    symbol: [
      { t: 'circle', cx: 0, cy: 0, r: reach, s: 'dash' },
      line(-reach, 0, reach, 0),
      line(0, -reach, 0, reach),
      rect(-tip, -bar / 2, 2 * tip, bar, 'solid'),
      rect(-bar / 2, -tip, bar, 2 * tip, 'solid'),
      ...[
        [tip, 0],
        [-tip, 0],
        [0, tip],
        [0, -tip],
      ].map(([cx, cy]): Prim => ({ t: 'circle', cx, cy, r: 1.25 * IN, s: 'solid' })),
      { t: 'circle', cx: 0, cy: 0, r: 1.5 * IN, s: 'body' },
    ],
  };
}

/**
 * A chest of drawers, 36" × 18" and 48" tall: five drawers on a plinth under a top
 * that overhangs the sides, each drawer front a little proud of the case with a
 * pull, and the drawers shallowest at the top.
 */
function chestOfDrawers(): CatalogItem {
  const [w, d, h] = [3, 18 * IN, 4];
  const [plinth, top, gap] = [4 * IN, 1 * IN, 0.5 * IN];
  const front = d / 2 - 0.75 * IN; // the case's front; drawer fronts stand proud of it
  const parts: Part[] = [
    box(-w / 2 + 0.5 * IN, -d / 2, w / 2 - 0.5 * IN, front - 1 * IN, 0, plinth, COLOR.darkWood),
    box(-w / 2 + 0.5 * IN, -d / 2, w / 2 - 0.5 * IN, front, plinth, h - top),
    box(-w / 2, -d / 2, w / 2, front + 0.5 * IN, h - top, h),
  ];
  // Drawer heights from the bottom up, deepest first.
  const heights = [10, 9, 8.5, 8, 7].map((x) => x * IN);
  const scale = (h - top - plinth - gap * (heights.length + 1)) / heights.reduce((a, b) => a + b, 0);
  let z = plinth + gap;
  for (const dh of heights.map((x) => x * scale)) {
    parts.push(box(-w / 2 + 1 * IN, front, w / 2 - 1 * IN, front + 0.75 * IN - 0.25 * IN, z, z + dh));
    parts.push(box(-3 * IN, front + 0.5 * IN, 3 * IN, d / 2, z + dh / 2 - 0.4 * IN, z + dh / 2 + 0.4 * IN, COLOR.chrome));
    z += dh + gap;
  }
  return {
    id: 'chest-of-drawers',
    name: 'Chest of drawers',
    category: 'bedroom',
    w,
    d,
    color: COLOR.wood,
    parts,
    symbol: [outline(w, d, 0.04), line(-w / 2, front, w / 2, front), rect(-3 * IN, front + 0.1 * IN, 6 * IN, d / 2 - front - 0.1 * IN, 'solid')],
  };
}

function shower(id: string, name: string, w: number, d: number): CatalogItem {
  const item = simple(id, name, 'bath', w, d, 0.33, COLOR.porcelain, [
    line(-w / 2, -d / 2, w / 2, d / 2),
    line(w / 2, -d / 2, -w / 2, d / 2),
    { t: 'circle', cx: 0, cy: 0, r: 0.12, s: 'soft' },
  ]);
  return item;
}

function sofa(id: string, name: string, w: number, seats: number): CatalogItem {
  const d = 38 * IN;
  const back = 0.7;
  const arm = 0.6;
  const seatW = (w - 2 * arm) / seats;
  return {
    id,
    name,
    category: 'living',
    w,
    d,
    color: COLOR.sofa,
    parts: [
      box(-w / 2, -d / 2, w / 2, -d / 2 + back, 0, 2.75),
      box(-w / 2, -d / 2 + back, -w / 2 + arm, d / 2, 0, 2.1),
      box(w / 2 - arm, -d / 2 + back, w / 2, d / 2, 0, 2.1),
      box(-w / 2 + arm, -d / 2 + back, w / 2 - arm, d / 2, 0, 1.5),
    ],
    symbol: [
      outline(w, d, 0.2),
      rect(-w / 2, -d / 2, w, back, 'solid', 0.15),
      rect(-w / 2, -d / 2 + back, arm, d - back, 'solid', 0.15),
      rect(w / 2 - arm, -d / 2 + back, arm, d - back, 'solid', 0.15),
      ...Array.from({ length: seats }, (_, i) => rect(-w / 2 + arm + i * seatW + 0.05, -d / 2 + back + 0.05, seatW - 0.1, d - back - 0.15, 'soft', 0.15)),
    ],
  };
}

/**
 * An L sectional: the long run against the back, and a chaise return on one end.
 * `hand` is the side the chaise is on when you face the sofa (the usual naming);
 * the left-hand one is the right-hand one mirrored.
 */
function sectional(hand: 'right' | 'left'): CatalogItem {
  const [w, d, back, seat, arm] = [9, 7, 0.7, 2.5, 0.6];
  // Laid out as the right-hand version (chaise on +x), then mirrored for the left.
  const mx = (x: number) => (hand === 'right' ? x : -x);
  const mbox = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number) =>
    box(Math.min(mx(x0), mx(x1)), y0, Math.max(mx(x0), mx(x1)), y1, z0, z1);
  const mrect = (x: number, y: number, rw: number, rh: number, st: PrimStyle, r?: number) =>
    rect(hand === 'right' ? x : -(x + rw), y, rw, rh, st, r);
  const yTop = -d / 2;
  const xRight = w / 2;
  const legX = xRight - back - seat; // inner edge of the return
  const legY = yTop + back + seat; // inner edge of the main run
  const cushion = (legX - (-w / 2 + arm)) / 2 - 0.1;
  return {
    id: hand === 'right' ? 'sectional' : 'sectional-left',
    name: `L sectional, chaise ${hand}`,
    category: 'living',
    w,
    d,
    color: COLOR.sofa,
    parts: [
      mbox(-w / 2, yTop, xRight, yTop + back, 0, 2.75),
      mbox(xRight - back, yTop + back, xRight, d / 2, 0, 2.75),
      mbox(-w / 2, yTop + back, -w / 2 + arm, legY, 0, 2.1),
      mbox(legX, d / 2 - arm, xRight - back, d / 2, 0, 2.1),
      mbox(-w / 2 + arm, yTop + back, xRight - back, legY, 0, 1.5),
      mbox(legX, legY, xRight - back, d / 2 - arm, 0, 1.5),
    ],
    symbol: [
      { t: 'path', d: `M ${mx(-w / 2)} ${yTop} H ${mx(xRight)} V ${d / 2} H ${mx(legX)} V ${legY} H ${mx(-w / 2)} Z`, s: 'body' },
      mrect(-w / 2, yTop, w, back, 'solid', 0.12),
      mrect(xRight - back, yTop + back, back, d - back, 'solid', 0.12),
      mrect(-w / 2, yTop + back, arm, seat, 'solid', 0.12),
      mrect(legX, d / 2 - arm, seat, arm, 'solid', 0.12),
      mrect(-w / 2 + arm + 0.05, yTop + back + 0.05, cushion, seat - 0.1, 'soft', 0.15),
      mrect(-w / 2 + arm + cushion + 0.15, yTop + back + 0.05, cushion, seat - 0.1, 'soft', 0.15),
      mrect(legX + 0.05, yTop + back + 0.05, seat - 0.1, seat - 0.1, 'soft', 0.15),
      mrect(legX + 0.05, legY + 0.05, seat - 0.1, d / 2 - arm - legY - 0.1, 'soft', 0.15),
    ],
  };
}

function armchair(): CatalogItem {
  const [w, d, back, arm] = [3, 3, 0.6, 0.5];
  return {
    id: 'armchair',
    name: 'Armchair',
    category: 'living',
    w,
    d,
    color: COLOR.sofa,
    parts: [
      box(-w / 2, -d / 2, w / 2, -d / 2 + back, 0, 2.75),
      box(-w / 2, -d / 2 + back, -w / 2 + arm, d / 2, 0, 2.1),
      box(w / 2 - arm, -d / 2 + back, w / 2, d / 2, 0, 2.1),
      box(-w / 2 + arm, -d / 2 + back, w / 2 - arm, d / 2, 0, 1.5),
    ],
    symbol: [
      outline(w, d, 0.2),
      rect(-w / 2, -d / 2, w, back, 'solid', 0.12),
      rect(-w / 2, -d / 2 + back, arm, d - back, 'solid', 0.12),
      rect(w / 2 - arm, -d / 2 + back, arm, d - back, 'solid', 0.12),
      rect(-w / 2 + arm + 0.05, -d / 2 + back + 0.05, w - 2 * arm - 0.1, d - back - 0.15, 'soft', 0.15),
    ],
  };
}

/** Table top with legs, plus chairs around it (each a seat and a back). */
function table(id: string, name: string, tw: number, td: number, sideChairs: number, endChairs: boolean, round = false): CatalogItem {
  const c = 1.5; // chair width
  const pull = 1.25; // how far chairs reach out from the table edge
  const w = tw + (endChairs ? 2 * pull : 0);
  const d = td + 2 * pull;
  const parts: Part[] = [box(-tw / 2, -td / 2, tw / 2, td / 2, 2.33, 2.5, COLOR.wood)];
  const leg = 0.25;
  const inset = round ? tw / 2 - 0.9 : 0.3;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const cx = sx * (tw / 2 - inset);
      const cy = sy * (td / 2 - inset);
      parts.push(box(cx - leg / 2, cy - leg / 2, cx + leg / 2, cy + leg / 2, 0, 2.33, COLOR.darkWood));
    }
  }
  const symbol: Prim[] = [];
  const chair = (cx: number, cy: number, dir: 'N' | 'S' | 'E' | 'W') => {
    const horizontal = dir === 'N' || dir === 'S';
    const [cw, cd] = horizontal ? [c, 1.4] : [1.4, c];
    const x0 = cx - cw / 2;
    const y0 = cy - cd / 2;
    parts.push(box(x0, y0, x0 + cw, y0 + cd, 0, 1.5, COLOR.darkWood));
    const bt = 0.15;
    const backBox =
      dir === 'N'
        ? box(x0, y0, x0 + cw, y0 + bt, 1.5, 3, COLOR.darkWood)
        : dir === 'S'
          ? box(x0, y0 + cd - bt, x0 + cw, y0 + cd, 1.5, 3, COLOR.darkWood)
          : dir === 'W'
            ? box(x0, y0, x0 + bt, y0 + cd, 1.5, 3, COLOR.darkWood)
            : box(x0 + cw - bt, y0, x0 + cw, y0 + cd, 1.5, 3, COLOR.darkWood);
    parts.push(backBox);
    symbol.push(rect(x0, y0, cw, cd, 'soft', 0.15));
    symbol.push(rect(backBox.x0, backBox.y0, backBox.x1 - backBox.x0, backBox.y1 - backBox.y0, 'solid'));
  };
  // Chairs pushed partly under the table: their inner edge sits 0.4' under it.
  const reach = td / 2 + 0.7 - 0.4;
  for (let i = 0; i < sideChairs; i++) {
    const cx = -tw / 2 + (tw * (i + 0.5)) / sideChairs;
    chair(cx, -reach, 'N');
    chair(cx, reach, 'S');
  }
  if (endChairs) {
    const ex = tw / 2 + 0.7 - 0.4;
    chair(-ex, 0, 'W');
    chair(ex, 0, 'E');
  }
  symbol.push(round ? { t: 'circle', cx: 0, cy: 0, r: tw / 2, s: 'body' } : rect(-tw / 2, -td / 2, tw, td, 'body', 0.1));
  return { id, name, category: 'dining', w, d, color: COLOR.wood, parts, symbol };
}

function laundry(id: string, name: string, letter: string): CatalogItem {
  const [w, d] = [27 * IN, 30 * IN];
  return simple(id, name, 'laundry', w, d, 3.25, COLOR.appliance, [
    rect(-w / 2, -d / 2, w, 0.3, 'solid'),
    { t: 'circle', cx: 0, cy: 0.15, r: 0.72, s: 'soft' },
    { t: 'text', x: 0, y: 0.15, text: letter, size: 0.55 },
  ]);
}

/** Stair limits from the IRC (R311.7): max riser, min tread, min landing depth (ft). */
export const STAIR_CODE = { maxRiser: 7.75 / 12, minTread: 10 / 12, minLanding: 3 } as const;

export interface StairLayout {
  risers: number;
  riser: number;
  treads: number;
  tread: number;
  /** Depth of the landing at each end. */
  landing: number;
  /** Overall length: bottom landing, flight, top landing. */
  length: number;
}

/**
 * A code-compliant straight stair for a floor-to-floor `rise`: the fewest risers
 * within the maximum height, 10" treads (one fewer than risers — the last riser
 * steps onto the top landing), and a 36" landing at the top and bottom.
 */
export function stairLayout(rise: number): StairLayout {
  const risers = Math.max(1, Math.ceil(rise / STAIR_CODE.maxRiser - 1e-9));
  const treads = risers - 1;
  const tread = STAIR_CODE.minTread;
  const landing = STAIR_CODE.minLanding;
  return { risers, riser: rise / risers, treads, tread, landing, length: treads * tread + 2 * landing };
}

/**
 * Parts and plan symbol of a straight stair `w` wide climbing `rise` toward −y:
 * the bottom landing at +y (a 1" pad marking the clear floor), the treads, and the
 * top landing at −y. Each step reaches down only to the top of the step two below
 * it, so the flight is one zig-zag two risers deep, open underneath (for closets
 * and storage); the — a platform at the upper floor's level, as thick as its deck.
 * Where there is a floor above, its deck is the top landing, so `topPlatform` is off:
 * the landing belongs to that floor, and this floor's plan stops at the flight.
 */
function stairShape(w: number, rise: number, topPlatform = true): Pick<ItemShape, 'd' | 'parts' | 'symbol' | 'box'> {
  const lay = stairLayout(rise);
  const L = lay.length;
  const bottom = L / 2 - lay.landing; // where the flight starts
  const parts: Part[] = [box(-w / 2, bottom, w / 2, L / 2, 0, 1 / 12)];
  for (let i = 0; i < lay.treads; i++) {
    parts.push(box(-w / 2, bottom - (i + 1) * lay.tread, w / 2, bottom - i * lay.tread, Math.max(0, i - 1) * lay.riser, (i + 1) * lay.riser));
  }
  if (topPlatform) parts.push(box(-w / 2, -L / 2, w / 2, -L / 2 + lay.landing, Math.max(0, rise - STORY.deckThickness), rise));

  const treadLines: Prim[] = Array.from({ length: Math.max(0, lay.treads - 1) }, (_, i) => {
    const y = bottom - (i + 1) * lay.tread;
    return line(-w / 2, y, w / 2, y);
  });
  const top = -L / 2 + lay.landing;
  const plan = topPlatform ? -L / 2 : top; // where the plan symbol starts
  const tip = topPlatform ? top - lay.landing / 2 + 0.3 : top + 0.15;
  return {
    d: L,
    parts,
    box: { x0: -w / 2, x1: w / 2, y0: plan, y1: L / 2 },
    symbol: [
      rect(-w / 2, plan, w, L / 2 - plan, 'body', 0.02),
      rect(-w / 2, bottom, w, lay.landing, 'soft'),
      ...(topPlatform ? [rect(-w / 2, -L / 2, w, lay.landing, 'soft')] : []),
      ...treadLines,
      { t: 'path', d: `M 0 ${bottom + lay.landing / 2} V ${tip} M -0.45 ${tip + 0.6} L 0 ${tip} L 0.45 ${tip + 0.6}`, s: 'line' },
      { t: 'text', x: 0, y: bottom + lay.landing / 2 + 0.6, text: 'UP', size: 0.6 },
    ],
  };
}

/** Toilet clearances from the IRC (R307.1): centerline to side walls/fixtures, clear space in front. */
export const TOILET_CODE = { side: 15 / 12, front: 21 / 12 } as const;

/**
 * A toilet whose footprint is its code clearance: 30" wide (15" each side of the
 * centerline) and its own 28" depth plus 21" clear in front. The fixture sits at
 * the back; a 1" pad marks the clear floor, like a stair landing. Snapped flush
 * to the walls around it, it lands exactly at code spacing.
 */
function toilet(): CatalogItem {
  const [depth, tank] = [28 * IN, 7 * IN];
  const w = 2 * TOILET_CODE.side;
  const d = depth + TOILET_CODE.front;
  const back = -d / 2;
  return {
    id: 'toilet',
    name: 'Toilet',
    category: 'bath',
    w,
    d,
    color: COLOR.porcelain,
    parts: [
      box(-w / 2, -d / 2, w / 2, d / 2, 0, 1 / 12, '#dfe3e6'),
      box(-10 * IN, back, 10 * IN, back + tank, 0, 2.5),
      box(-7.5 * IN, back + tank, 7.5 * IN, back + depth, 0, 16 * IN),
    ],
    symbol: [
      rect(-w / 2, -d / 2, w, d, 'dash'),
      rect(-10 * IN, back, 20 * IN, tank, 'body', 0.08),
      { t: 'ellipse', cx: 0, cy: back + tank + 10.5 * IN, rx: 7.5 * IN, ry: 10.5 * IN, s: 'body' },
      { t: 'ellipse', cx: 0, cy: back + tank + 11.5 * IN, rx: 5 * IN, ry: 7 * IN, s: 'soft' },
    ],
  };
}

function stairs(): CatalogItem {
  const w = 3;
  return {
    id: 'stairs',
    name: 'Stairs (straight)',
    category: 'other',
    w,
    color: COLOR.stairs,
    stairs: true,
    // Shown for a typical story; placed stairs fit their floor's actual rise.
    ...stairShape(w, STORY.defaultHeight),
  };
}

/** A piano bench (seat in plan coordinates: centered at x = 0, front edge at `y`). */
const bench = (y: number): { part: Part; prim: Prim } => ({
  part: box(-1.25, y, 1.25, y + 1.1, 0, 1.6, COLOR.darkWood),
  prim: rect(-1.25, y, 2.5, 1.1, 'solid', 0.1),
});

/** Keys along the front of a piano case, between `y0` and `y1`. */
const keys = (y0: number, y1: number, half: number): Prim[] => [
  rect(-half, y0, 2 * half, y1 - y0, 'soft'),
  ...Array.from({ length: 11 }, (_, i) => line(-half + ((i + 1) * 2 * half) / 12, y0, -half + ((i + 1) * 2 * half) / 12, y1)),
];

/** A parlor grand (5′ × 6′2″) with its bench; the keyboard faces +y, the curved tail −y. */
function grandPiano(): CatalogItem {
  const [w, len, gap] = [5, 6 + 2 / 12, 0.4];
  const d = len + gap + 1.1;
  const back = -d / 2;
  const front = back + len; // keyboard edge
  const b = bench(front + gap);
  return {
    id: 'piano-grand',
    name: 'Grand piano',
    category: 'other',
    w,
    d,
    color: COLOR.piano,
    parts: [
      box(-w / 2, front - 2, w / 2, front, 0, 3.3), // keybed and wide front of the case
      box(-w / 2, back + 0.6, 0.6, front - 2, 0, 3.3), // bass side running back to the tail
      box(0.6, back + 1.6, 2, front - 2, 0, 3.3), // the treble bend
      b.part,
    ],
    symbol: [
      {
        t: 'path',
        d: `M ${-w / 2} ${front} V ${back + 0.6} Q ${-w / 2} ${back} 0.3 ${back} Q 1.8 ${back} 2 ${back + 2.2} Q ${w / 2} ${front - 2.5} ${w / 2} ${front - 1.6} V ${front} Z`,
        s: 'body',
      },
      ...keys(front - 0.55, front, w / 2 - 0.25),
      b.prim,
    ],
  };
}

/** An upright piano (5′ × 2′2″) with its bench in front. */
function uprightPiano(): CatalogItem {
  const [w, depth, gap] = [5, 2 + 2 / 12, 0.5];
  const d = depth + gap + 1.1;
  const back = -d / 2;
  const b = bench(back + depth + gap);
  return {
    id: 'piano-upright',
    name: 'Upright piano',
    category: 'other',
    w,
    d,
    color: COLOR.piano,
    parts: [box(-w / 2, back, w / 2, back + depth - 0.6, 0, 4.2), box(-w / 2, back + depth - 0.6, w / 2, back + depth, 0, 2.4), b.part],
    symbol: [rect(-w / 2, back, w, depth, 'body', 0.05), ...keys(back + depth - 0.55, back + depth, w / 2 - 0.25), b.prim],
  };
}

/** A regulation table tennis table: 9′ × 5′, 30″ high, net across the middle. */
function pingPong(): CatalogItem {
  const [w, d] = [9, 5];
  const parts: Part[] = [box(-w / 2, -d / 2, w / 2, d / 2, 2.35, 2.5), box(-0.03, -d / 2 - 0.5, 0.03, d / 2 + 0.5, 2.5, 3.0, '#f2f4f5')];
  for (const x of [-3.5, 3.5]) for (const y of [-1.8, 1.8]) parts.push(box(x - 0.15, y - 0.15, x + 0.15, y + 0.15, 0, 2.35, COLOR.dark));
  return {
    id: 'ping-pong',
    name: 'Ping pong table',
    category: 'other',
    w,
    d,
    color: COLOR.felt,
    parts,
    symbol: [outline(w, d, 0.05), line(-w / 2, 0, w / 2, 0, 'dash'), rect(-0.06, -d / 2, 0.12, d, 'solid')],
  };
}

/**
 * A fireplace: 5′ firebox and surround to a 4′6″ mantel, and a stone hearth 18″ deep
 * running 6″ past each side (beyond the code minimum of 16″ in front, 8″ total).
 */
function fireplace(): CatalogItem {
  const [boxW, boxD, hearthW, hearthD] = [5, 2, 6, 1.5];
  const d = boxD + hearthD;
  const back = -d / 2;
  return {
    id: 'fireplace',
    name: 'Fireplace',
    category: 'living',
    w: hearthW,
    d,
    color: COLOR.brick,
    parts: [
      box(-boxW / 2, back, boxW / 2, back + boxD, 0, 4.5),
      box(-hearthW / 2, back + boxD, hearthW / 2, d / 2, 0, 4 / 12, COLOR.stone),
    ],
    symbol: [
      rect(-boxW / 2, back, boxW, boxD, 'body', 0.05),
      rect(-1.5, back + boxD - 1.2, 3, 1.2, 'solid', 0.05),
      rect(-hearthW / 2, back + boxD, hearthW, hearthD, 'soft', 0.05),
    ],
  };
}

/**
 * Kitchen cabinets at standard sizes: a 34½" base box under a 1½" countertop (36"
 * to the top) that overhangs the front by 1". With `upper`, a 12"-deep wall cabinet
 * hangs above from 54" to 84" — 18" over the counter — drawn dashed in plan, the
 * convention for things overhead.
 */
function cabinet(id: string, name: string, w: number, upper: boolean): CatalogItem {
  const d = 2;
  const parts: Part[] = [
    box(-w / 2, -d / 2, w / 2, d / 2 - IN, 0, 34.5 * IN, COLOR.cabinet),
    box(-w / 2, -d / 2, w / 2, d / 2, 34.5 * IN, 3),
  ];
  const symbol: Prim[] = [outline(w, d, 0.04), line(-w / 2, d / 2 - IN, w / 2, d / 2 - IN)];
  if (upper) {
    parts.push(box(-w / 2, -d / 2, w / 2, -d / 2 + 1, 4.5, 7, COLOR.cabinet));
    symbol.push(rect(-w / 2 + 0.04, -d / 2 + 0.04, w - 0.08, 1 - 0.04, 'dash'));
  }
  return { id, name, category: 'kitchen', w, d, color: COLOR.counter, parts, symbol };
}

/**
 * An entry bench with open, see-through cubbies: two rows of four (7" tall, for
 * shoes) between end panels and dividers, and a cushion on top at about 19".
 */
function shoeBench(): CatalogItem {
  const [w, d, board] = [3.5, 16 * IN, 0.75 * IN];
  const [x0, x1, y0, y1] = [-w / 2, w / 2, -d / 2, d / 2];
  const top = 18 * IN;
  const mid = 8 * IN;
  const parts: Part[] = [
    box(x0, y0, x1, y1, 0, board), // bottom
    box(x0, y0, x1, y1, mid, mid + board), // shelf between the rows
    box(x0, y0, x1, y1, top - board, top), // top
    box(x0, y0, x0 + board, y1, board, top - board), // ends
    box(x1 - board, y0, x1, y1, board, top - board),
    box(x0 + 0.08, y0 + 0.06, x1 - 0.08, y1 - 0.06, top, top + 1.5 * IN, COLOR.linen), // cushion
  ];
  const dividers = [-w / 4, 0, w / 4];
  for (const x of dividers) parts.push(box(x - board / 2, y0, x + board / 2, y1, board, top - board));
  return {
    id: 'shoe-bench',
    name: 'Shoe bench',
    category: 'other',
    w,
    d,
    color: COLOR.wood,
    parts,
    symbol: [
      outline(w, d, 0.04),
      ...dividers.map((x) => line(x, y0, x, y1, 'dash')),
      rect(x0 + 0.08, y0 + 0.06, w - 0.16, d - 0.12, 'soft', 0.1),
    ],
  };
}

/** A small round side table, 18" across and 22" tall: a top on a pedestal. */
function roundSideTable(): CatalogItem {
  const r = 9 * IN;
  return {
    id: 'side-table-round',
    name: 'Round side table',
    category: 'living',
    w: 2 * r,
    d: 2 * r,
    color: COLOR.wood,
    parts: [
      box(-r, -r, r, r, 20.5 * IN, 22 * IN),
      box(-1.25 * IN, -1.25 * IN, 1.25 * IN, 1.25 * IN, 1 * IN, 20.5 * IN, COLOR.darkWood),
      box(-6 * IN, -6 * IN, 6 * IN, 6 * IN, 0, 1 * IN, COLOR.darkWood),
    ],
    symbol: [{ t: 'circle', cx: 0, cy: 0, r, s: 'body' }, { t: 'circle', cx: 0, cy: 0, r: r - 0.12, s: 'line' }],
  };
}

/**
 * A home-gym power rack with a flat bench: a 4′ × 4′ rack 7½′ tall at the back
 * (four uprights on floor runners, a top frame and spotter arms), a 7′ barbell with
 * plates resting on the front uprights at bench height, and the bench running
 * through the rack and out the front. The footprint takes in the bar's full length.
 */
function weightRack(): CatalogItem {
  const [w, d] = [7, 6];
  const [rx, ry0, ry1, post, h] = [2, -3, 1, 3 * IN, 7.5];
  const barY = ry1 - post / 2;
  const barZ = 3.75;
  const plate = { r: 0.73, t: 2 * IN, x: 2.45 };
  const parts: Part[] = [];
  for (const sx of [-1, 1]) {
    const [x0, x1] = sx < 0 ? [-rx, -rx + post] : [rx - post, rx];
    parts.push(
      box(x0, ry0, x1, ry0 + post, 0, h, COLOR.rack), // back upright
      box(x0, ry1 - post, x1, ry1, 0, h, COLOR.rack), // front upright
      box(x0, ry0, x1, ry1, 0, post, COLOR.rack), // floor runner
      box(x0, ry0, x1, ry1, h - post, h, COLOR.rack), // top side rail
      box(x0, ry0, x1, ry1, 1.75, 1.75 + 2 * IN, COLOR.chrome), // spotter arm
      box(sx * plate.x - plate.t / 2, barY - plate.r, sx * plate.x + plate.t / 2, barY + plate.r, barZ - plate.r, barZ + plate.r, COLOR.plate),
    );
  }
  parts.push(
    box(-rx, ry0, rx, ry0 + post, h - post, h, COLOR.rack), // top back crossbar
    box(-rx, ry1 - post, rx, ry1, h - post, h, COLOR.rack), // top front crossbar
    box(-w / 2, barY - 0.5 * IN, w / 2, barY + 0.5 * IN, barZ - 0.5 * IN, barZ + 0.5 * IN, COLOR.chrome), // barbell
    // Bench: a padded top on a spine with two posts and two feet.
    box(-0.5, -1.5, 0.5, 2.75, 1.25, 1.5, COLOR.piano),
    box(-0.1, -1.3, 0.1, 2.55, 0.15, 0.35, COLOR.rack),
    box(-0.1, -1.2, 0.1, -1, 0.35, 1.25, COLOR.rack),
    box(-0.1, 2.2, 0.1, 2.4, 0.35, 1.25, COLOR.rack),
    box(-0.6, -1.3, 0.6, -1.05, 0, 0.15, COLOR.rack),
    box(-0.6, 2.3, 0.6, 2.55, 0, 0.15, COLOR.rack),
  );
  const corners = [-rx, rx - post].flatMap((x) => [ry0, ry1 - post].map((y) => rect(x, y, post, post, 'solid')));
  return {
    id: 'weight-rack',
    name: 'Weight rack & bench',
    category: 'other',
    w,
    d,
    color: COLOR.rack,
    parts,
    symbol: [
      rect(-rx, ry0, 2 * rx, ry1 - ry0, 'body', 0.04),
      ...corners,
      rect(-0.5, -1.5, 1, 4.25, 'soft', 0.2),
      line(-w / 2, barY, w / 2, barY),
      rect(-plate.x - plate.t / 2, barY - plate.r, plate.t, 2 * plate.r, 'solid'),
      rect(plate.x - plate.t / 2, barY - plate.r, plate.t, 2 * plate.r, 'solid'),
    ],
  };
}

function car(): CatalogItem {
  const [w, d] = [6.5, 15.5];
  return {
    id: 'car',
    name: 'Car',
    category: 'other',
    w,
    d,
    color: COLOR.car,
    parts: [box(-w / 2, -d / 2, w / 2, d / 2, 0.6, 3), box(-w / 2 + 0.4, -d / 2 + 4.2, w / 2 - 0.4, d / 2 - 3.6, 3, 4.7)],
    symbol: [
      outline(w, d, 1.2),
      rect(-w / 2 + 0.5, -d / 2 + 4.2, w - 1, d - 7.8, 'soft', 0.5),
      line(-w / 2 + 0.5, -d / 2 + 5.4, w / 2 - 0.5, -d / 2 + 5.4),
      line(-w / 2 + 0.5, d / 2 - 4.6, w / 2 - 0.5, d / 2 - 4.6),
    ],
  };
}

// ===================================================================== catalog

export const CATALOG: CatalogItem[] = [
  bed('bed-king', 'King bed', 76 * IN, 80 * IN),
  bed('bed-cal-king', 'Cal king bed', 72 * IN, 84 * IN),
  bed('bed-queen', 'Queen bed', 60 * IN, 80 * IN),
  bed('bed-full', 'Full bed', 54 * IN, 75 * IN),
  bed('bed-twin-xl', 'Twin XL bed', 38 * IN, 80 * IN),
  bed('bed-twin', 'Twin bed', 38 * IN, 75 * IN),
  simple('crib', 'Crib', 'bedroom', 30 * IN, 54 * IN, 3, COLOR.linen, [rect(-15 * IN + 0.15, -27 * IN + 0.15, 30 * IN - 0.3, 54 * IN - 0.3, 'soft')]),
  simple('nightstand', 'Nightstand', 'bedroom', 2, 1.5, 26 * IN, COLOR.wood, [{ t: 'circle', cx: 0, cy: 0, r: 0.35, s: 'soft' }]),
  simple('dresser', 'Dresser', 'bedroom', 5, 20 * IN, 3, COLOR.wood, [line(-5 / 6, -10 * IN, -5 / 6, 10 * IN), line(5 / 6, -10 * IN, 5 / 6, 10 * IN)]),
  chestOfDrawers(),

  toilet(),
  simple('tub', 'Bathtub 60"', 'bath', 5, 2.5, 1.75, COLOR.porcelain, [
    rect(-2.5 + 0.25, -1.25 + 0.25, 4.5, 2, 'soft', 0.7),
    { t: 'circle', cx: 2.5 - 0.65, cy: 0, r: 0.1, s: 'solid' },
  ]),
  shower('shower-36', 'Shower 36"', 3, 3),
  shower('shower-48', 'Shower 48"', 4, 3),
  shower('shower-60', 'Shower 60"', 5, 3),
  vanity('vanity-30', 'Vanity 30"', 2.5, 1),
  vanity('vanity-36', 'Vanity 36"', 3, 1),
  vanity('vanity-60', 'Double vanity 60"', 5, 2),
  vanity('vanity-72', 'Double vanity 72"', 6, 2),

  simple('fridge', 'Refrigerator', 'kitchen', 3, 2.5, 6, COLOR.steel, [line(-1.5, 1.05, 1.5, 1.05), line(0, 1.05, 0, 1.25), { t: 'text', x: 0, y: -0.15, text: 'REF', size: 0.55 }]),
  simple('range', 'Range', 'kitchen', 2.5, 26 * IN, 3, COLOR.steel, [
    ...[-0.6, 0.6].flatMap((cx): Prim[] => [
      { t: 'circle', cx, cy: -0.45, r: 0.33, s: 'soft' },
      { t: 'circle', cx, cy: 0.35, r: 0.33, s: 'soft' },
    ]),
  ]),
  {
    // Under the counter like the base cabinets: 34½" machine, 1½" countertop overhanging 1".
    id: 'dishwasher',
    name: 'Dishwasher',
    category: 'kitchen',
    w: 2,
    d: 2,
    color: COLOR.counter,
    parts: [box(-1, -1, 1, 1 - IN, 0, 34.5 * IN, COLOR.steel), box(-1, -1, 1, 1, 34.5 * IN, 3)],
    symbol: [outline(2, 2, 0.04), line(-1, 1 - IN, 1, 1 - IN), { t: 'text', x: 0, y: 0, text: 'DW', size: 0.55 }],
  },
  kitchenSink(),
  cabinet('cabinet-24', 'Base cabinet 24"', 2, false),
  cabinet('stacked-24', 'Stacked cabinet 24"', 2, true),
  cabinet('stacked-36', 'Stacked cabinet 36"', 3, true),
  cabinet('counter-6', 'Counter 6\'', 6, false),
  simple('island', 'Island 6\'×3\'6"', 'kitchen', 6, 3.5, 3, COLOR.counter),

  sofa('sofa', 'Sofa', 84 * IN, 3),
  sofa('loveseat', 'Loveseat', 64 * IN, 2),
  sectional('left'),
  sectional('right'),
  armchair(),
  fireplace(),
  simple('coffee-table', 'Coffee table', 'living', 4, 2, 1.5, COLOR.wood, [], 0.25),
  simple('side-table-narrow', 'Side table, narrow', 'living', 1, 2, 2, COLOR.wood, [line(-0.5, -0.85, 0.5, -0.85)]),
  roundSideTable(),
  {
    id: 'tv-console',
    name: 'TV console',
    category: 'living',
    w: 5,
    d: 1.5,
    color: COLOR.wood,
    parts: [box(-2.5, -0.75, 2.5, 0.75, 0, 2), box(-2, -0.35, 2, -0.2, 2, 4.6, COLOR.dark)],
    symbol: [outline(5, 1.5), rect(-2, -0.35, 4, 0.15, 'solid')],
  },

  table('table-4', 'Table, seats 4', 4, 3, 2, false),
  table('table-6', 'Table, seats 6', 6, 40 * IN, 2, true),
  table('table-8', 'Table, seats 8', 8, 42 * IN, 3, true),
  table('table-round', 'Round table 48"', 4, 4, 1, true, true),

  laundry('washer', 'Washer', 'W'),
  laundry('dryer', 'Dryer', 'D'),

  {
    id: 'desk',
    name: 'Desk',
    category: 'office',
    w: 5,
    d: 2.5,
    color: COLOR.wood,
    parts: [
      box(-2.5, -1.25, 2.5, 1.25, 2.4, 2.5),
      box(-2.5, -1.25, -1.2, 1.25, 0, 2.4),
      box(2.4, -1.25, 2.5, 1.25, 0, 2.4),
    ],
    symbol: [outline(5, 2.5), line(-1.2, -1.25, -1.2, 1.25, 'dash')],
  },
  simple('desk-chair', 'Desk chair', 'office', 2, 2, 3.25, COLOR.dark, [rect(-0.85, -1, 1.7, 0.35, 'solid', 0.1)], 0.6),
  simple('bookshelf', 'Bookshelf', 'office', 3, 1, 6, COLOR.wood, [line(-0.5, -0.5, -0.5, 0.5), line(0.5, -0.5, 0.5, 0.5)]),

  stairs(),
  shoeBench(),
  coatRack(),
  grandPiano(),
  uprightPiano(),
  pingPong(),
  weightRack(),
  car(),
];

export const CATALOG_BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

/** An item as placed on a particular floor. */
export interface ItemShape extends Pick<CatalogItem, 'w' | 'd' | 'parts' | 'symbol'> {
  /** What it covers in this floor's plan, in local coordinates: usually its w × d footprint. */
  box: Box;
}

/**
 * An item's size, parts and symbol on a floor whose next floor up is `rise` above
 * it (and whether there is one). Only stairs depend on that; everything else is as
 * cataloged.
 */
export function itemShape(item: CatalogItem, rise: number, floorAbove = false): ItemShape {
  if (item.stairs) return { w: item.w, ...stairShape(item.w, rise, !floorAbove) };
  return { w: item.w, d: item.d, parts: item.parts, symbol: item.symbol, box: { x0: -item.w / 2, x1: item.w / 2, y0: -item.d / 2, y1: item.d / 2 } };
}

/**
 * The opening a stair needs in the floor above, in the stair's local coordinates:
 * its full width, from the edge of the top landing back down the flight until the
 * line along the tread nosings is `headroom` below the underside of that floor.
 */
export function stairOpeningLocal(item: CatalogItem, rise: number, headroom: number): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!item.stairs) return null;
  const lay = stairLayout(rise);
  if (lay.treads === 0) return null;
  const flightStart = lay.length / 2 - lay.landing; // bottom of the flight (local y)
  const flightEnd = -lay.length / 2 + lay.landing; // top of the flight, at the top landing
  // Nosing line: riser r (1-based) is (r − 1) treads up the flight at height r·riser.
  const limit = rise - STORY.deckThickness - headroom;
  const s0 = Math.max(0, (limit / lay.riser - 1) * lay.tread);
  const low = flightStart - s0;
  if (low <= flightEnd) return null;
  return { x0: -item.w / 2, x1: item.w / 2, y0: flightEnd, y1: low };
}

/**
 * What a stair on the floor below shows on the floor it climbs to, in its local
 * coordinates: the top landing (that floor's own deck, kept clear by code), drawn
 * with a DN arrow down the flight, and — with the opening over the flight — the
 * part of the stair this floor's plan can pick it up by (`box`).
 */
export function stairArrival(item: CatalogItem, rise: number): { box: Box; symbol: Prim[] } | null {
  if (!item.stairs) return null;
  const lay = stairLayout(rise);
  const w = item.w;
  const top = -lay.length / 2;
  const edge = top + lay.landing;
  const opening = stairOpeningLocal(item, rise, STORY.minHeadroom);
  const tip = edge + 1;
  return {
    box: { x0: -w / 2, x1: w / 2, y0: top, y1: opening ? opening.y1 : edge },
    symbol: [
      rect(-w / 2, top, w, lay.landing, 'body', 0.02),
      { t: 'text', x: 0, y: top + lay.landing / 2 - 0.5, text: 'DN', size: 0.6 },
      { t: 'path', d: `M 0 ${top + lay.landing / 2} V ${tip} M -0.45 ${tip - 0.6} L 0 ${tip} L 0.45 ${tip - 0.6}`, s: 'line' },
    ],
  };
}

/** An item's plan footprint at a rotation: its size along x and y. */
export function rotatedSize(item: Pick<CatalogItem, 'w' | 'd'>, rotation: number): { w: number; d: number } {
  return rotation % 180 === 0 ? { w: item.w, d: item.d } : { w: item.d, d: item.w };
}

/** A local box turned to a rotation, about the item's center: plan offsets from that center. */
export function rotatedBox(b: Box, rotation: number): Box {
  const a = toPlan(b.x0, b.y0, 0, 0, rotation);
  const c = toPlan(b.x1, b.y1, 0, 0, rotation);
  return { x0: Math.min(a.x, c.x), x1: Math.max(a.x, c.x), y0: Math.min(a.y, c.y), y1: Math.max(a.y, c.y) };
}

/** Maps a local point of an item to plan coordinates (rotation is clockwise in plan). */
export function toPlan(lx: number, ly: number, cx: number, cy: number, rotation: number): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: cx - ly, y: cy + lx };
    case 180:
      return { x: cx - lx, y: cy - ly };
    case 270:
      return { x: cx + ly, y: cy - lx };
    default:
      return { x: cx + lx, y: cy + ly };
  }
}

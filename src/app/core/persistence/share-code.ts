import { validateLayout } from '../geometry/constraints';
import { quantize } from '../geometry/rect';
import { createFloor, DEFAULT_PATIO, DEFAULT_SETTINGS, newId, PATIO_LIMITS, ROOF_LIMITS } from '../model/defaults';
import { CameraState, DesignSnapshot, DoorKind, Floor, HouseWindow, ProjectSettings, Section, Skylight, SIDES, WindowShape, WindowStyle } from '../model/types';
import { normalizeLevels } from '../floorplan/floor-region';
import { pruneGroups } from '../floorplan/groups';

/**
 * Compact, copy-pasteable encoding of a design for sharing between browsers.
 *
 * Only the current design travels (name, sections, floors, windows, settings, camera); checkpoints and
 * ids don't. The design is packed into positional arrays, deflated, and base64url
 * encoded. The first character says how the body is encoded, so the format can grow:
 *   'z' — deflate-raw compressed JSON
 *   'j' — uncompressed JSON (used when compression doesn't help)
 *
 * Packed layout (version 4; version 3 has no `glazing`, version 2 has no basements or
 * the trailing floor fields from `unexcavated` on, and version 1 has no `floors`):
 *   [4, name, settings | 0, camera | 0, floors | 0, glazing | 0, ...sections]
 *   settings: [roofThickness, overhang, wallThickness, postSize, defaultSectionDepth, interiorWallThickness], 0 = defaults
 *   camera:   [px, py, pz, tx, ty, tz] rounded to 0.1 ft, 0 = none
 *   section:  [x, y, w, d, slope (index into N/E/S/W), pitch, lowWallHeight, flags, postSpacing?]
 *             flags: 1 = unheated, 2 = patio. postSpacing omitted when default.
 *   The root section is always first.
 *   floors:   0 when there's only an empty ground floor, else one entry per floor, lowest
 *             first (a basement has a negative elevation):
 *             [elevation, [x, y, …nodes], [a, b, …walls as node indices], doors, items, openings,
 *              names?, unexcavated?, dividers?, groups?]  (empty trailing fields are left off)
 *             door:    [wall index | -1, side (exterior only), coord, at, width, kind index, swing, hinge, height?]
 *                      (height: garage doors only)
 *             item:    [type, x, y, rotation]
 *             opening, unexcavated: [x0, y0, x1, y1]
 *             name:    [x, y, text, unheated?]  (1 when unheated; left off when heated)
 *             dividers: the indices of walls that are room dividers
 *             group:   [member…], each an item index, or ~index (−1 − index) of another group
 *   glazing:  0 when there are no windows or skylights, else [windows, skylights]:
 *             window:   [side index, coord, shape, style index, cols, rows]
 *                       shape: [0, u, z, w, h] rect | [1, u, z, r] circle | [2, u, z, w, h] arch | [3, u, z, u, z, …] polygon
 *                              | [4, u, z, w, h, top slope, bottom slope, follows lower roof (0/1)] roofline
 *             skylight: [x0, y0, x1, y1]
 */

const FORMAT_VERSION = 4;
const WINDOW_STYLES: WindowStyle[] = ['fixed', 'double-hung', 'slider', 'casement', 'awning'];
const SETTINGS_KEYS: (keyof ProjectSettings)[] = [
  'roofThickness',
  'overhang',
  'wallThickness',
  'postSize',
  'defaultSectionDepth',
  'interiorWallThickness',
];
const DOOR_KINDS: DoorKind[] = ['single', 'double', 'pocket', 'barn', 'opening', 'garage'];

export interface SharedDesign extends DesignSnapshot {
  name: string;
}

type PackedSection = number[];
type PackedFloor = [
  number,
  number[],
  number[],
  number[][],
  (string | number)[][],
  number[][],
  (string | number)[][]?,
  number[][]?,
  number[]?,
  number[][]?,
];
type PackedGlazing = [unknown[][], number[][]];
type Packed = [number, string, number[] | 0, number[] | 0, PackedFloor[] | 0, PackedGlazing | 0, ...PackedSection[]];

const round1 = (v: number) => Math.round(v * 10) / 10;

export async function encodeShareCode(design: SharedDesign): Promise<string> {
  const root = design.sections.find((s) => s.id === design.rootId);
  if (!root) throw new Error('Design has no root section');
  const ordered = [root, ...design.sections.filter((s) => s !== root)];
  const settings = SETTINGS_KEYS.map((k) => design.settings[k]);
  const packed: Packed = [
    FORMAT_VERSION,
    design.name,
    SETTINGS_KEYS.every((k) => design.settings[k] === DEFAULT_SETTINGS[k]) ? 0 : settings,
    design.camera ? [...design.camera.position, ...design.camera.target].map(round1) : 0,
    isBlank(design.floors) ? 0 : design.floors.map(packFloor),
    design.windows.length || design.skylights.length
      ? [design.windows.map(packWindow), design.skylights.map((k) => [r4(k.x0), r4(k.y0), r4(k.x1), r4(k.y1)])]
      : 0,
    ...ordered.map(packSection),
  ];
  const json = new TextEncoder().encode(JSON.stringify(packed));
  const deflated = await pipe(json, new CompressionStream('deflate-raw'));
  return deflated.length < json.length ? 'z' + toBase64Url(deflated) : 'j' + toBase64Url(json);
}

/** Decodes and validates a share code. Throws an Error with a user-readable message if it's unusable. */
export async function decodeShareCode(code: string): Promise<SharedDesign> {
  const clean = code.replace(/\s+/g, '');
  const kind = clean[0];
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(clean.slice(1));
    if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    else if (kind !== 'j') throw new Error();
  } catch {
    throw new Error('That doesn’t look like a share code.');
  }
  let packed: unknown;
  try {
    packed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('The share code is damaged or incomplete.');
  }
  return unpack(packed);
}

function packSection(s: Section): PackedSection {
  const { x, y, w, d } = s.rect;
  const flags = (s.unheated ? 1 : 0) | (s.patio.enabled ? 2 : 0);
  const out = [x, y, w, d, SIDES.indexOf(s.roof.slopeDir), s.roof.pitch, s.roof.lowWallHeight, flags];
  if (s.patio.postSpacing !== DEFAULT_PATIO.postSpacing) out.push(s.patio.postSpacing);
  return out;
}

function unpack(packed: unknown): SharedDesign {
  if (!Array.isArray(packed) || typeof packed[0] !== 'number') throw new Error('The share code is damaged.');
  if (packed[0] > FORMAT_VERSION) throw new Error('This share code is from a newer version of Home Designer.');
  const version = packed[0];
  const [, name, rawSettings, rawCamera] = packed as Packed;
  const rawFloors = version >= 2 ? (packed as Packed)[4] : 0;
  const rawGlazing = version >= 4 ? (packed as Packed)[5] : 0;
  const rawSections = (packed as unknown[]).slice(version >= 4 ? 6 : version >= 2 ? 5 : 4);

  const settings: ProjectSettings = { ...DEFAULT_SETTINGS };
  if (Array.isArray(rawSettings)) {
    SETTINGS_KEYS.forEach((k, i) => {
      if (isNum(rawSettings[i]) && rawSettings[i] > 0) settings[k] = rawSettings[i];
    });
  }

  let camera: CameraState | null = null;
  if (Array.isArray(rawCamera) && rawCamera.length === 6 && rawCamera.every(isNum)) {
    camera = {
      position: rawCamera.slice(0, 3) as CameraState['position'],
      target: rawCamera.slice(3, 6) as CameraState['target'],
    };
  }

  const sections = rawSections.map(unpackSection);
  if (sections.length === 0) throw new Error('The share code has no sections.');
  const rootId = sections[0].id;
  const violation = validateLayout(sections, rootId);
  if (violation) throw new Error(`The shared layout is invalid: ${violation}`);

  const floors = normalizeLevels(Array.isArray(rawFloors) && rawFloors.length > 0 ? rawFloors.map(unpackFloor) : [createFloor()]);

  return {
    name: typeof name === 'string' && name.trim() ? name : 'Shared design',
    rootId,
    sections,
    floors,
    settings,
    camera,
    ...unpackGlazing(rawGlazing),
  };
}

function packWindow(w: HouseWindow): unknown[] {
  const s = w.shape;
  const shape =
    s.t === 'rect'
      ? [0, s.u, s.z, s.w, s.h]
      : s.t === 'circle'
        ? [1, s.u, s.z, s.r]
        : s.t === 'arch'
          ? [2, s.u, s.z, s.w, s.h]
          : s.t === 'roofline'
            ? [4, s.u, s.z, s.w, s.h, s.top, s.bottom, s.lower ? 1 : 0]
            : [3, ...s.pts.flat()];
  return [SIDES.indexOf(w.host.side), r4(w.host.coord), shape.map((v, i) => (i === 0 ? v : r4(v))), WINDOW_STYLES.indexOf(w.style), w.grille.cols, w.grille.rows];
}

function unpackGlazing(raw: unknown): { windows: HouseWindow[]; skylights: Skylight[] } {
  const windows: HouseWindow[] = [];
  const skylights: Skylight[] = [];
  if (!Array.isArray(raw)) return { windows, skylights };
  const [ws, ks] = raw as PackedGlazing;
  for (const w of Array.isArray(ws) ? ws : []) {
    if (!Array.isArray(w) || !isNum(w[0]) || !isNum(w[1]) || !Array.isArray(w[2]) || !(w[2] as unknown[]).every(isNum)) continue;
    const [t, ...n] = w[2] as number[];
    let shape: WindowShape | null = null;
    if (t === 0 && n.length >= 4) shape = { t: 'rect', u: n[0], z: n[1], w: n[2], h: n[3] };
    else if (t === 1 && n.length >= 3) shape = { t: 'circle', u: n[0], z: n[1], r: n[2] };
    else if (t === 2 && n.length >= 4) shape = { t: 'arch', u: n[0], z: n[1], w: n[2], h: n[3] };
    else if (t === 3 && n.length >= 6) shape = { t: 'poly', pts: Array.from({ length: Math.floor(n.length / 2) }, (_, i): [number, number] => [n[2 * i], n[2 * i + 1]]) };
    else if (t === 4 && n.length >= 7) shape = { t: 'roofline', u: n[0], z: n[1], w: n[2], h: n[3], top: n[4], bottom: n[5], lower: n[6] === 1 };
    if (!shape) continue;
    windows.push({
      id: newId(),
      host: { side: SIDES[w[0] as number] ?? 'S', coord: w[1] as number },
      shape,
      style: WINDOW_STYLES[w[3] as number] ?? 'fixed',
      grille: { cols: clamp(isNum(w[4]) ? w[4] : 1, 1, 12), rows: clamp(isNum(w[5]) ? w[5] : 1, 1, 12) },
    });
  }
  for (const k of Array.isArray(ks) ? ks : []) {
    if (Array.isArray(k) && k.length >= 4 && k.every(isNum)) skylights.push({ id: newId(), x0: k[0], y0: k[1], x1: k[2], y1: k[3] });
  }
  return { windows, skylights };
}

const isBlank = (floors: Floor[]) =>
  floors.length === 1 && floors[0].walls.length === 0 && floors[0].doors.length === 0 && floors[0].items.length === 0;

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

function packFloor(f: Floor): PackedFloor {
  const nodeIndex = new Map(f.nodes.map((n, i) => [n.id, i]));
  const wallIndex = new Map(f.walls.map((w, i) => [w.id, i]));
  const itemIndex = new Map(f.items.map((it, i) => [it.id, i]));
  const groupIndex = new Map(f.groups.map((g, i) => [g.id, i]));
  const member = (id: string) => (groupIndex.has(id) ? ~groupIndex.get(id)! : (itemIndex.get(id) ?? null));
  const packed: PackedFloor = [
    r4(f.elevation),
    f.nodes.flatMap((n) => [r4(n.x), r4(n.y)]),
    f.walls.flatMap((w) => [nodeIndex.get(w.a)!, nodeIndex.get(w.b)!]),
    f.doors.map((d) => [
      'wallId' in d.host ? (wallIndex.get(d.host.wallId) ?? -1) : -1,
      'side' in d.host ? SIDES.indexOf(d.host.side) : 0,
      'coord' in d.host ? r4(d.host.coord) : 0,
      r4(d.at),
      r4(d.width),
      DOOR_KINDS.indexOf(d.kind),
      d.swing,
      d.hinge,
      ...(d.kind === 'garage' && d.height !== undefined ? [r4(d.height)] : []),
    ]),
    f.items.map((it) => [it.type, r4(it.x), r4(it.y), it.rotation]),
    f.openings.map((o) => [r4(o.x0), r4(o.y0), r4(o.x1), r4(o.y1)]),
    f.roomNames.map((n) => [r4(n.x), r4(n.y), n.name, ...(n.unheated ? [1] : [])]),
    f.unexcavated.map((o) => [r4(o.x0), r4(o.y0), r4(o.x1), r4(o.y1)]),
    f.walls.flatMap((w, i) => (w.divider ? [i] : [])),
    f.groups.map((g) => g.members.map(member).filter((m): m is number => m !== null)),
  ];
  while (packed.length > 6 && (packed.at(-1) as unknown[]).length === 0) packed.pop();
  return packed;
}

function unpackFloor(raw: unknown): Floor {
  const bad = () => new Error('The share code is damaged.');
  if (!Array.isArray(raw) || raw.length < 6) throw bad();
  const [elevation, nodesFlat, wallsFlat, doors, items, openings, names = [], unexcavated = [], dividers = [], groups = []] =
    raw as PackedFloor;
  if (!isNum(elevation) || ![nodesFlat, wallsFlat, doors, items, openings].every(Array.isArray)) throw bad();
  const floor = createFloor(elevation);
  for (let i = 0; i + 1 < nodesFlat.length; i += 2) floor.nodes.push({ id: newId(), x: nodesFlat[i], y: nodesFlat[i + 1] });
  for (let i = 0; i + 1 < wallsFlat.length; i += 2) {
    const a = floor.nodes[wallsFlat[i]];
    const b = floor.nodes[wallsFlat[i + 1]];
    if (a && b) floor.walls.push({ id: newId(), a: a.id, b: b.id });
  }
  for (const d of doors) {
    if (!Array.isArray(d) || d.length < 8 || !d.every(isNum)) continue;
    const [wall, side, coord, at, width, kind, swing, hinge, height] = d;
    const host = wall >= 0 ? (floor.walls[wall] ? { wallId: floor.walls[wall].id } : null) : { side: SIDES[side] ?? 'N', coord };
    if (!host) continue;
    floor.doors.push({
      id: newId(),
      host,
      at,
      width: clamp(width, 1, 20),
      kind: DOOR_KINDS[kind] ?? 'single',
      swing: swing < 0 ? -1 : 1,
      hinge: hinge < 0 ? -1 : 1,
      ...(height !== undefined ? { height: clamp(height, 6, 16) } : {}),
    });
  }
  for (const it of items) {
    if (!Array.isArray(it) || typeof it[0] !== 'string' || !it.slice(1, 4).every(isNum)) continue;
    const rotation = ([0, 90, 180, 270] as const).find((r) => r === it[3]) ?? 0;
    floor.items.push({ id: newId(), type: it[0], x: it[1] as number, y: it[2] as number, rotation });
  }
  for (const o of openings) {
    if (!Array.isArray(o) || o.length < 4 || !o.every(isNum)) continue;
    floor.openings.push({ id: newId(), x0: o[0], y0: o[1], x1: o[2], y1: o[3] });
  }
  for (const n of Array.isArray(names) ? names : []) {
    if (!Array.isArray(n) || !isNum(n[0]) || !isNum(n[1]) || typeof n[2] !== 'string') continue;
    floor.roomNames.push({ id: newId(), x: n[0], y: n[1], name: n[2], ...(n[3] === 1 ? { unheated: true } : {}) });
  }
  for (const o of Array.isArray(unexcavated) ? unexcavated : []) {
    if (!Array.isArray(o) || o.length < 4 || !o.every(isNum)) continue;
    floor.unexcavated.push({ id: newId(), x0: o[0], y0: o[1], x1: o[2], y1: o[3] });
  }
  for (const i of Array.isArray(dividers) ? dividers : []) {
    if (isNum(i) && floor.walls[i]) floor.walls[i] = { ...floor.walls[i], divider: true };
  }
  const groupIds = (Array.isArray(groups) ? groups : []).map(() => newId());
  (Array.isArray(groups) ? groups : []).forEach((g, gi) => {
    if (!Array.isArray(g)) return;
    const members = g.filter(isNum).map((m) => (m < 0 ? groupIds[~m] : floor.items[m]?.id)).filter((m): m is string => !!m);
    floor.groups.push({ id: groupIds[gi], members });
  });
  return pruneGroups(floor);
}

function unpackSection(raw: unknown): Section {
  if (!Array.isArray(raw) || raw.length < 8 || !raw.every(isNum)) throw new Error('The share code is damaged.');
  const [x, y, w, d, slope, pitch, low, flags, spacing] = (raw as number[]).map((v, i) => (i < 4 ? quantize(v) : v));
  const unheated = (flags & 1) !== 0;
  const patio = (flags & 2) !== 0;
  return {
    id: newId(),
    rect: { x, y, w, d },
    roof: {
      slopeDir: SIDES[slope] ?? 'S',
      pitch: clamp(pitch, ROOF_LIMITS.pitch.min, ROOF_LIMITS.pitch.max),
      lowWallHeight: clamp(low, ROOF_LIMITS.lowWallHeight.min, ROOF_LIMITS.lowWallHeight.max),
    },
    unheated,
    patio: {
      enabled: patio,
      postSpacing:
        spacing === undefined
          ? DEFAULT_PATIO.postSpacing
          : clamp(spacing, PATIO_LIMITS.postSpacing.min, PATIO_LIMITS.postSpacing.max),
    },
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

import { HouseWindow, WindowShape, WindowStyle } from '../model/types';
import { Face, faceOutline } from './faces';

/**
 * Window geometry in face coordinates ([u, z]: along the face, height). Shared by
 * the elevation editor's drawing and the 3D model, so both show the same panes.
 */

export type UZ = [number, number];
export type Segment = [UZ, UZ];

/** Segments used to draw curves. */
const ARC_STEPS = 48;

export const WINDOW_STYLES: { style: WindowStyle; label: string }[] = [
  { style: 'fixed', label: 'Fixed' },
  { style: 'double-hung', label: 'Double-hung' },
  { style: 'slider', label: 'Slider' },
  { style: 'casement', label: 'Casement' },
  { style: 'awning', label: 'Awning' },
];

/** Common window sizes, width × height in inches. */
export const WINDOW_PRESETS: [number, number][] = [
  [24, 36],
  [24, 48],
  [30, 48],
  [36, 48],
  [36, 60],
  [48, 48],
  [48, 60],
  [60, 48],
  [72, 48],
  [72, 60],
];

/** Nothing smaller than this (ft) across. */
export const MIN_WINDOW = 0.5;

export interface Bounds {
  u0: number;
  u1: number;
  z0: number;
  z1: number;
}

/** The shape's outline as a polygon (curves as short straight runs). */
export function shapeOutline(s: WindowShape): UZ[] {
  switch (s.t) {
    case 'rect':
      return [
        [s.u, s.z],
        [s.u + s.w, s.z],
        [s.u + s.w, s.z + s.h],
        [s.u, s.z + s.h],
      ];
    case 'circle':
      return Array.from({ length: ARC_STEPS }, (_, i): UZ => {
        const a = (2 * Math.PI * i) / ARC_STEPS;
        return [s.u + s.r * Math.cos(a), s.z + s.r * Math.sin(a)];
      });
    case 'arch': {
      const r = s.w / 2;
      const spring = s.z + Math.max(0, s.h - r); // where the round top starts
      const top = Array.from({ length: ARC_STEPS / 2 + 1 }, (_, i): UZ => {
        const a = (Math.PI * i) / (ARC_STEPS / 2);
        return [s.u + r + r * Math.cos(a), spring + r * Math.sin(a)];
      });
      return [[s.u, s.z], [s.u + s.w, s.z], ...top];
    }
    case 'poly':
      return s.pts.map(([u, z]): UZ => [u, z]);
    case 'roofline':
      return [
        [s.u, s.z],
        [s.u + s.w, s.z + s.bottom * s.w],
        [s.u + s.w, s.z + s.h + s.top * s.w],
        [s.u, s.z + s.h],
      ];
  }
}

/** A roofline window's bottom and top edges' heights at u. */
export const rooflineEdges = (s: Extract<WindowShape, { t: 'roofline' }>, u: number) => ({
  bottom: s.z + s.bottom * (u - s.u),
  top: s.z + s.h + s.top * (u - s.u),
});

export function shapeBounds(s: WindowShape): Bounds {
  const pts = shapeOutline(s);
  return {
    u0: Math.min(...pts.map((p) => p[0])),
    u1: Math.max(...pts.map((p) => p[0])),
    z0: Math.min(...pts.map((p) => p[1])),
    z1: Math.max(...pts.map((p) => p[1])),
  };
}

export const shapeCenterU = (s: WindowShape) => {
  const b = shapeBounds(s);
  return (b.u0 + b.u1) / 2;
};

export function moveShape(s: WindowShape, du: number, dz: number): WindowShape {
  switch (s.t) {
    case 'poly':
      return { ...s, pts: s.pts.map(([u, z]): [number, number] => [u + du, z + dz]) };
    default:
      return { ...s, u: s.u + du, z: s.z + dz };
  }
}

export function pointInPolygon([u, z]: UZ, poly: readonly UZ[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ui, zi] = poly[i];
    const [uj, zj] = poly[j];
    if (zi > z !== zj > z && u < ((uj - ui) * (z - zi)) / (zj - zi) + ui) inside = !inside;
  }
  return inside;
}

/** The parts of segment a–b inside a polygon (which may be concave). */
export function clipSegment(a: UZ, b: UZ, poly: readonly UZ[]): Segment[] {
  const d: UZ = [b[0] - a[0], b[1] - a[1]];
  const ts = [0, 1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[j];
    const e: UZ = [poly[i][0] - p[0], poly[i][1] - p[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p[0] - a[0]) * e[1] - (p[1] - a[1]) * e[0]) / den;
    const s = ((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]) / den;
    if (t > 0 && t < 1 && s >= 0 && s <= 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const at = (t: number): UZ => [a[0] + d[0] * t, a[1] + d[1] * t];
  const out: Segment[] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    if (ts[i + 1] - ts[i] < 1e-9) continue;
    if (pointInPolygon(at((ts[i] + ts[i + 1]) / 2), poly)) out.push([at(ts[i]), at(ts[i + 1])]);
  }
  return out;
}

/**
 * The lines drawn over a window's glass: `bars` — where sashes meet (a double-hung's
 * meeting rail, a slider's center stile) and the grille's muntins — clipped to its
 * shape; and `hinge` — the dashed elevation convention for casements and awnings,
 * pointing to the hinged side (drawn in plan views only).
 */
export function windowLines(w: Pick<HouseWindow, 'shape' | 'style' | 'grille'>): { bars: Segment[]; hinge: Segment[] } {
  const poly = shapeOutline(w.shape);
  const b = shapeBounds(w.shape);
  const [um, zm] = [(b.u0 + b.u1) / 2, (b.z0 + b.z1) / 2];
  const lines: Segment[] = [];
  if (w.style === 'double-hung') lines.push([[b.u0, zm], [b.u1, zm]]);
  if (w.style === 'slider') lines.push([[um, b.z0], [um, b.z1]]);
  const cols = Math.max(1, Math.round(w.grille.cols));
  const rows = Math.max(1, Math.round(w.grille.rows));
  for (let i = 1; i < cols; i++) {
    const u = b.u0 + ((b.u1 - b.u0) * i) / cols;
    lines.push([[u, b.z0], [u, b.z1]]);
  }
  for (let i = 1; i < rows; i++) {
    const z = b.z0 + ((b.z1 - b.z0) * i) / rows;
    lines.push([[b.u0, z], [b.u1, z]]);
  }
  const bars = lines.flatMap(([p, q]) => clipSegment(p, q, poly));
  const hinge: Segment[] =
    w.style === 'casement'
      ? [
          [[b.u1, b.z0], [b.u0, zm]],
          [[b.u1, b.z1], [b.u0, zm]],
        ]
      : w.style === 'awning'
        ? [
            [[b.u0, b.z0], [um, b.z1]],
            [[b.u1, b.z0], [um, b.z1]],
          ]
        : [];
  return { bars, hinge: hinge.flatMap(([p, q]) => clipSegment(p, q, poly)) };
}

/** Clearance (ft) kept between a window and the edges of its wall face, or another window or door. */
export const WINDOW_MARGIN = 2 / 12;

/**
 * Whether a window fits: inside its face with a little wall all round, and clear
 * of the other windows and the doors (`blocked`, as bounds) on that face.
 */
export function windowFits(shape: WindowShape, face: Face | null, blocked: readonly Bounds[]): boolean {
  if (!face) return false;
  const b = shapeBounds(shape);
  if (b.u1 - b.u0 < MIN_WINDOW - 1e-9 || b.z1 - b.z0 < MIN_WINDOW - 1e-9) return false;
  const outline = faceOutline(face);
  const m = WINDOW_MARGIN;
  const probes: UZ[] = shapeOutline(shape).flatMap(([u, z]): UZ[] => [
    [u - m, z],
    [u + m, z],
    [u, z - m],
    [u, z + m],
  ]);
  if (!probes.every((p) => pointInPolygon(p, outline))) return false;
  return !blocked.some((o) => b.u0 < o.u1 + m - 1e-9 && b.u1 > o.u0 - m + 1e-9 && b.z0 < o.z1 + m - 1e-9 && b.z1 > o.z0 - m + 1e-9);
}

/** Clips a polygon to z ≤ `top` (for views cut off at a height). */
export function clipBelow(poly: readonly UZ[], top: number): UZ[] {
  const out: UZ[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ina = a[1] <= top;
    const inb = b[1] <= top;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (top - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, top]);
    }
  }
  return out;
}

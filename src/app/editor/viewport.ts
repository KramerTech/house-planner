import { Rect } from '../core/model/types';

/** Plan-view camera: screen = world * scale + (tx, ty). Scale is pixels per foot. */
export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

export interface Point {
  x: number;
  y: number;
}

export const ZOOM_LIMITS = { min: 3, max: 60 } as const;
/** How far (ft) beyond the building the view center may be panned. */
const PAN_MARGIN_FT = 150;

export function worldToScreen(v: Viewport, p: Point): Point {
  return { x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty };
}

export function screenToWorld(v: Viewport, p: Point): Point {
  return { x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale };
}

/** Zooms by `factor` keeping the world point under `anchor` (screen px) fixed. */
export function zoomAt(v: Viewport, anchor: Point, factor: number): Viewport {
  const scale = clamp(v.scale * factor, ZOOM_LIMITS.min, ZOOM_LIMITS.max);
  const k = scale / v.scale;
  return { scale, tx: anchor.x - (anchor.x - v.tx) * k, ty: anchor.y - (anchor.y - v.ty) * k };
}

/** Keeps the world point at the view center within reach of the content. */
export function clampPan(v: Viewport, viewSize: Point, content: Rect | null): Viewport {
  if (!content) return v;
  const center = screenToWorld(v, { x: viewSize.x / 2, y: viewSize.y / 2 });
  const cx = clamp(center.x, content.x - PAN_MARGIN_FT, content.x + content.w + PAN_MARGIN_FT);
  const cy = clamp(center.y, content.y - PAN_MARGIN_FT, content.y + content.d + PAN_MARGIN_FT);
  if (cx === center.x && cy === center.y) return v;
  return { ...v, tx: viewSize.x / 2 - cx * v.scale, ty: viewSize.y / 2 - cy * v.scale };
}

/** Viewport that shows `content` centered with some padding. */
export function fitViewport(viewSize: Point, content: Rect | null, paddingPx = 80): Viewport {
  const c = content ?? { x: -10, y: -10, w: 20, d: 20 };
  const sx = (viewSize.x - paddingPx * 2) / Math.max(c.w, 1);
  const sy = (viewSize.y - paddingPx * 2) / Math.max(c.d, 1);
  const scale = clamp(Math.min(sx, sy), ZOOM_LIMITS.min, 24);
  return {
    scale,
    tx: viewSize.x / 2 - (c.x + c.w / 2) * scale,
    ty: viewSize.y / 2 - (c.y + c.d / 2) * scale,
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

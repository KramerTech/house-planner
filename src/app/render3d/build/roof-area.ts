import { BuildingModel } from './building-model';

/**
 * Total sloped roof surface (sq ft): each roof's plan footprint, overhangs included,
 * scaled by 1/cos of its pitch angle, so steeper roofs have more area. Footprint
 * rectangles of one roof never overlap, so their plan areas simply add.
 */
export function roofSurfaceArea(model: BuildingModel): number {
  let total = 0;
  for (const piece of model.pieces) {
    if (piece.kind !== 'roof') continue;
    const plan = piece.footprint.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
    const { gx, gy } = piece.plane;
    total += plan * Math.sqrt(1 + gx * gx + gy * gy);
  }
  return total;
}

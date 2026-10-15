import { RoofPiece } from '../build/building-model';

const EPS = 1e-6;

const samePlane = (a: RoofPiece, b: RoofPiece): boolean =>
  Math.abs(a.plane.base - b.plane.base) < EPS &&
  Math.abs(a.plane.gx - b.plane.gx) < EPS &&
  Math.abs(a.plane.gy - b.plane.gy) < EPS &&
  Math.abs(a.verticalThickness - b.verticalThickness) < EPS;

/**
 * Combines roof pieces that share the same underside plane and thickness — adjoining
 * sections with matching pitch and height — into one piece. addRoof rasterizes a
 * piece's footprint rectangles onto a shared grid and only emits side faces along
 * its outline, so once the rectangles are combined the formerly-shared edge between
 * them is interior and gets no face (and no outline) at all. Roof pieces that don't
 * share a plane (a real ridge or valley between two different pitches) are left
 * separate — the edge between them is real and should render.
 */
export function mergeRoofPieces(pieces: readonly RoofPiece[]): RoofPiece[] {
  const merged: RoofPiece[] = [];
  for (const roof of pieces) {
    const match = merged.find((m) => samePlane(m, roof));
    if (match) match.footprint.push(...roof.footprint);
    else merged.push({ ...roof, footprint: [...roof.footprint] });
  }
  return merged;
}

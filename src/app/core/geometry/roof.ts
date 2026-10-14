import { Section } from '../model/types';
import { x0, x1, y0, y1 } from './rect';

/** Rise per foot of run. */
export function roofSlope(section: Section): number {
  return section.roof.pitch / 12;
}

/** Horizontal run of the roof along its slope, from the low wall to the high wall (ft). */
export function roofRun(section: Section): number {
  const { slopeDir } = section.roof;
  return slopeDir === 'N' || slopeDir === 'S' ? section.rect.d : section.rect.w;
}

export function highWallHeight(section: Section): number {
  return section.roof.lowWallHeight + roofRun(section) * roofSlope(section);
}

/**
 * Height of the underside of the roof plane above plan point (x, y). The plane passes
 * through the top of the low wall's outer face and extends past the footprint, so
 * this also gives overhang heights (lower than the low wall on the low side).
 */
export function roofHeightAt(section: Section, x: number, y: number): number {
  const r = section.rect;
  let distFromLow: number;
  switch (section.roof.slopeDir) {
    case 'S':
      distFromLow = y1(r) - y;
      break;
    case 'N':
      distFromLow = y - y0(r);
      break;
    case 'E':
      distFromLow = x1(r) - x;
      break;
    case 'W':
      distFromLow = x - x0(r);
      break;
  }
  return section.roof.lowWallHeight + distFromLow * roofSlope(section);
}

import { Section } from '../model/types';

export interface AreaSummary {
  /** Conditioned floor area, sq ft. */
  heated: number;
  /** Enclosed but unheated floor area (excludes patios), sq ft. */
  unheated: number;
  /** Covered patio floor (poured slab) area, sq ft. Overhangs are not counted. */
  covered: number;
  /** All floor area: heated + unheated + covered, sq ft. */
  total: number;
}

export function areaSummary(sections: readonly Section[]): AreaSummary {
  let heated = 0;
  let unheated = 0;
  let covered = 0;
  for (const s of sections) {
    const a = s.rect.w * s.rect.d;
    if (s.patio.enabled) covered += a;
    else if (s.unheated) unheated += a;
    else heated += a;
  }
  return { heated, unheated, covered, total: heated + unheated + covered };
}

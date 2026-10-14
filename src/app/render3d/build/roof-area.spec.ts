import { describe, expect, it } from 'vitest';
import { createSection, DEFAULT_SETTINGS } from '../../core/model/defaults';
import { buildBuildingModel } from './building-builder';
import { roofSurfaceArea } from './roof-area';

describe('roofSurfaceArea', () => {
  it('includes overhangs on every free edge and scales by pitch', () => {
    const s = createSection({ x: 0, y: 0, w: 16, d: 12 }, { pitch: 12 });
    const area = roofSurfaceArea(buildBuildingModel({ sections: [s], settings: DEFAULT_SETTINGS }));
    expect(area).toBeCloseTo(20 * 16 * Math.SQRT2);
  });

  it('a flat roof is just its plan area', () => {
    const s = createSection({ x: 0, y: 0, w: 16, d: 12 }, { pitch: 0 });
    const settings = { ...DEFAULT_SETTINGS, overhang: 0 };
    expect(roofSurfaceArea(buildBuildingModel({ sections: [s], settings }))).toBeCloseTo(192);
  });

  it('level neighbors share no overhang', () => {
    const a = createSection({ x: 0, y: 0, w: 10, d: 10 }, { pitch: 0 });
    const b = createSection({ x: 10, y: 0, w: 10, d: 10 }, { pitch: 0 });
    const area = roofSurfaceArea(buildBuildingModel({ sections: [a, b], settings: DEFAULT_SETTINGS }));
    expect(area).toBeCloseTo(24 * 14);
  });
});

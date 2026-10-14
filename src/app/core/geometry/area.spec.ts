import { createSection } from '../model/defaults';
import { areaSummary } from './area';

describe('areaSummary', () => {
  it('splits heated, unheated and covered (patio) floor area, ignoring overhangs', () => {
    const house = createSection({ x: 0, y: 0, w: 20, d: 10 });
    const garage = { ...createSection({ x: 0, y: 10, w: 12, d: 10 }), unheated: true };
    const patio = {
      ...createSection({ x: 20, y: 0, w: 8, d: 10 }),
      unheated: true,
      patio: { enabled: true, postSpacing: 8 },
    };
    expect(areaSummary([house, garage, patio])).toEqual({ heated: 200, unheated: 120, covered: 80, total: 400 });
  });
});

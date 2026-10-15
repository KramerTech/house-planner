import { STORY } from '../model/defaults';
import { CATALOG_BY_ID, STAIR_CODE, stairLayout, stairOpeningLocal } from './catalog';

describe('stair layout', () => {
  it('stays within code for any story height', () => {
    for (let rise = 8; rise <= 14; rise += 0.25) {
      const s = stairLayout(rise);
      expect(s.riser).toBeLessThanOrEqual(STAIR_CODE.maxRiser + 1e-9);
      expect(s.tread).toBeGreaterThanOrEqual(STAIR_CODE.minTread);
      expect(s.landing).toBeGreaterThanOrEqual(STAIR_CODE.minLanding);
      expect(s.riser * s.risers).toBeCloseTo(rise);
    }
  });

  it('lays out a 10′ story: 16 risers of 7½", 15 treads, 36" landings at both ends', () => {
    const s = stairLayout(10);
    expect(s.risers).toBe(16);
    expect(s.riser * 12).toBeCloseTo(7.5);
    expect(s.treads).toBe(15);
    expect(s.length).toBeCloseTo(15 * (10 / 12) + 6);
  });
});

describe('stair opening', () => {
  it('leaves 8′ of headroom over every riser it does not open', () => {
    const stairs = CATALOG_BY_ID.get('stairs')!;
    for (const rise of [9, 10, 11, 12]) {
      const lay = stairLayout(rise);
      const open = stairOpeningLocal(stairs, rise, 8)!;
      const flightStart = lay.length / 2 - lay.landing;
      for (let r = 1; r <= lay.risers; r++) {
        const y = flightStart - (r - 1) * lay.tread; // riser r's position (climbing toward −y)
        const covered = y <= open.y1 + 1e-9 && y >= open.y0 - 1e-9;
        if (!covered) expect(rise - STORY.deckThickness - r * lay.riser).toBeGreaterThanOrEqual(8 - 1e-9);
      }
      // It starts at the top landing.
      expect(open.y0).toBeCloseTo(-lay.length / 2 + lay.landing);
    }
  });
});

describe('toilet clearance', () => {
  it('takes up its code clearance: 15″ each side of center, 21″ clear in front', () => {
    const t = CATALOG_BY_ID.get('toilet')!;
    expect(t.w * 12).toBeCloseTo(30);
    expect(t.d * 12).toBeCloseTo(28 + 21);
    // The fixture sits against the back; the front 21″ is only the 1″ clearance pad.
    const fixture = t.parts.filter((p) => p.z1 > 1 / 12);
    expect(Math.min(...fixture.map((p) => p.y0))).toBeCloseTo(-t.d / 2);
    expect((t.d / 2 - Math.max(...fixture.map((p) => p.y1))) * 12).toBeCloseTo(21);
  });
});

describe('sectionals', () => {
  it('comes in mirror-image left and right hands', () => {
    const right = CATALOG_BY_ID.get('sectional')!;
    const left = CATALOG_BY_ID.get('sectional-left')!;
    const key = (p: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }) =>
      [p.x0, p.x1, p.y0, p.y1, p.z0, p.z1].map((v) => v.toFixed(3)).join();
    const mirrored = right.parts.map((p) => key({ ...p, x0: -p.x1, x1: -p.x0 })).sort();
    expect(left.parts.map(key).sort()).toEqual(mirrored);
    // Chaise (the return, reaching the front) on the right when facing it: +x for the right hand.
    const chaise = (s: typeof right) => s.parts.filter((p) => p.y1 >= s.d / 2 - 1e-9 && p.z1 === 2.75)[0];
    expect(chaise(right).x0).toBeGreaterThan(0);
    expect(chaise(left).x1).toBeLessThan(0);
  });
});

import { RoofPiece } from '../build/building-model';
import { mergeRoofPieces } from './piece-merge';

function roof(footprint: RoofPiece['footprint'], plane = { base: 10, gx: 0, gy: -0.2 }): RoofPiece {
  return { kind: 'roof', sectionId: 's', footprint, plane, verticalThickness: 0.5 };
}

describe('mergeRoofPieces', () => {
  it('combines footprints of roofs sharing the same plane', () => {
    const a = roof([{ x0: 0, y0: 0, x1: 10, y1: 10 }]);
    const b = roof([{ x0: 10, y0: 0, x1: 20, y1: 10 }]);
    const merged = mergeRoofPieces([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].footprint).toHaveLength(2);
  });

  it('keeps roofs with different planes separate', () => {
    const a = roof([{ x0: 0, y0: 0, x1: 10, y1: 10 }], { base: 10, gx: 0, gy: -0.2 });
    const b = roof([{ x0: 10, y0: 0, x1: 20, y1: 10 }], { base: 9, gx: 0, gy: -0.2 });
    expect(mergeRoofPieces([a, b])).toHaveLength(2);
  });
});

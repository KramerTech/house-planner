import { DoubleSide, EdgesGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { PrismPiece } from '../build/building-model';
import { GeometryAccumulator } from './geometry-accumulator';
import { addMergedPrisms } from './merged-prisms';

function wall(x0: number, x1: number, y0: number, y1: number, top = 8, bottom = 0): PrismPiece {
  return {
    kind: 'wall',
    sectionId: 's',
    footprint: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    bottom: [bottom, bottom, bottom, bottom],
    top: [top, top, top, top],
  };
}

function build(pieces: PrismPiece[]) {
  const acc = new GeometryAccumulator();
  addMergedPrisms(acc, pieces);
  const geometry = acc.toGeometry();
  const e = new EdgesGeometry(geometry, 20).getAttribute('position');
  const edges: [Vector3, Vector3][] = [];
  for (let i = 0; i < e.count; i += 2) {
    edges.push([new Vector3(e.getX(i), e.getY(i), e.getZ(i)), new Vector3(e.getX(i + 1), e.getY(i + 1), e.getZ(i + 1))]);
  }
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  const hit = (origin: Vector3, dir: Vector3) => new Raycaster(origin, dir).intersectObject(mesh)[0];
  return { edges, hit };
}

/** Outline edges lying entirely on the vertical line world X = x, plan y = z (world Z). */
const verticalEdgesAt = (edges: [Vector3, Vector3][], x: number, z: number) =>
  edges
    .filter(([a, b]) => a.x === x && b.x === x && a.z === z && b.z === z)
    .map(([a, b]) => [Math.min(a.y, b.y), Math.max(a.y, b.y)]);

describe('addMergedPrisms', () => {
  it('closes a lone wall on all four sides', () => {
    const { hit } = build([wall(0, 10, 0, 0.5)]);
    expect(hit(new Vector3(5, 4, -10), new Vector3(0, 0, 1))?.face?.normal.z).toBe(-1);
    expect(hit(new Vector3(5, 4, 10), new Vector3(0, 0, -1))?.face?.normal.z).toBe(1);
    expect(hit(new Vector3(-10, 4, 0.25), new Vector3(1, 0, 0))?.face?.normal.x).toBe(-1);
    expect(hit(new Vector3(20, 4, 0.25), new Vector3(-1, 0, 0))?.face?.normal.x).toBe(1);
  });

  it('draws no seam where two same-height walls continue along one line', () => {
    const { edges } = build([wall(0, 10, 0, 0.5), wall(10, 20, 0, 0.5)]);
    expect(edges.filter(([a, b]) => a.x === 10 && b.x === 10)).toHaveLength(0);
  });

  it('draws no seam for E/W-oriented walls either', () => {
    const { edges } = build([wall(0, 0.5, 0, 10), wall(0, 0.5, 10, 20)]);
    expect(edges.filter(([a, b]) => a.z === 10 && b.z === 10)).toHaveLength(0);
  });

  it('at a height step, outlines only the step itself — no seam below it', () => {
    // The short wall's end runs 0→8 and the tall wall's 0→11. Unless the tall side
    // is split at 8 so both share that edge exactly, EdgesGeometry sees two
    // unrelated boundary edges and draws a line down the flat face.
    const { edges } = build([wall(0, 10, 0, 0.5, 8), wall(10, 20, 0, 0.5, 11)]);
    expect(verticalEdgesAt(edges, 10, 0)).toEqual([[8, 11]]);
    expect(verticalEdgesAt(edges, 10, 0.5)).toEqual([[8, 11]]);
  });

  it('at a height step, closes the taller wall’s exposed end above the shorter one', () => {
    const { hit } = build([wall(0, 10, 0, 0.5, 8), wall(10, 20, 0, 0.5, 11)]);
    const h = hit(new Vector3(-10, 9.5, 0.25), new Vector3(1, 0, 0));
    expect(h?.point.x).toBeCloseTo(10);
    expect(h?.face?.normal.x).toBe(-1);
  });

  it('merges an inset wall with the ends of the walls it sits between into one face', () => {
    // A box corner: the E wall sits between the N and S walls. Its outer face and the
    // N/S walls' end caps all lie on x=10 and should read as one face, no seams.
    const n = wall(0, 10, 0, 0.5);
    const e = wall(9.5, 10, 0.5, 9.5);
    const s = wall(0, 10, 9.5, 10);
    const { edges } = build([n, e, s]);
    expect(verticalEdgesAt(edges, 10, 0.5)).toHaveLength(0);
    expect(verticalEdgesAt(edges, 10, 9.5)).toHaveLength(0);
  });

  it('draws no seam across the top where two same-height walls join (visible with the roof off)', () => {
    const { edges } = build([wall(0, 10, 0, 0.5), wall(10, 20, 0, 0.5)]);
    const acrossTop = edges.filter(([a, b]) => a.y === 8 && b.y === 8 && a.x === 10 && b.x === 10);
    expect(acrossTop).toHaveLength(0);
  });

  it('draws no seam across the top at a box corner', () => {
    // N wall top spans x 0..10, the inset E wall's top meets its inside edge at y=0.5.
    const { edges } = build([wall(0, 10, 0, 0.5), wall(9.5, 10, 0.5, 9.5), wall(0, 10, 9.5, 10)]);
    const onTop = (z: number) => edges.filter(([a, b]) => a.y === 8 && b.y === 8 && a.z === z && b.z === z);
    // The only top edges along y=0.5 are the N wall's inside edge, stopping where the E wall begins.
    for (const [a, b] of onTop(0.5)) expect(Math.max(a.x, b.x)).toBeLessThanOrEqual(9.5);
    for (const [a, b] of onTop(9.5)) expect(Math.max(a.x, b.x)).toBeLessThanOrEqual(9.5);
  });

  it('merges adjacent floor slabs into one slab with no seam on top or along the shared side', () => {
    const slab = (x0: number, x1: number): PrismPiece => ({ ...wall(x0, x1, 0, 10, 0), bottom: [-0.3, -0.3, -0.3, -0.3] });
    const { edges, hit } = build([slab(0, 10), slab(10, 20)]);
    expect(edges.filter(([a, b]) => a.x === 10 && b.x === 10)).toHaveLength(0);
    // Still closed along the outer edges.
    expect(hit(new Vector3(5, -0.15, -10), new Vector3(0, 0, 1))?.face?.normal.z).toBe(-1);
  });

  it('removes faces buried where two pieces overlap', () => {
    // Both walls claim the corner square x 0..0.5, y 0..0.5. The second wall's inner
    // face (x=0.5) runs through it; left in, its end would draw a line on the first
    // wall's outer face at x=0.5.
    const { edges } = build([wall(0, 10, 0, 0.5), wall(0, 0.5, 0, 10)]);
    expect(verticalEdgesAt(edges, 0.5, 0)).toHaveLength(0);
  });

  it('removes the buried part of a sloped underside, not just whole faces', () => {
    // A raised wall standing on a pitched roof (sloped bottom) whose end runs into a
    // perpendicular raised wall. Its underside's buried end used to stay, drawing the
    // pitched roofline on past the corner across the other wall's outer face.
    const onPitchedRoof: PrismPiece = { ...wall(10, 10.5, 0.5, 10, 14), bottom: [11.5, 11.625, 11.625, 11.5] };
    const crossWall = wall(10, 19.5, 9.5, 10, 14, 9);
    const { edges } = build([onPitchedRoof, crossWall]);
    const slopedOnFace = edges.filter(([a, b]) => a.z === 10 && b.z === 10 && a.x !== b.x && a.y !== b.y);
    expect(slopedOnFace).toHaveLength(0);
  });

  it('leaves walls on different planes alone', () => {
    const { edges } = build([wall(0, 10, 0, 0.5), wall(0, 10, 5, 5.5)]);
    expect(verticalEdgesAt(edges, 0, 0)).toEqual([[0, 8]]);
    expect(verticalEdgesAt(edges, 0, 5)).toEqual([[0, 8]]);
  });
});

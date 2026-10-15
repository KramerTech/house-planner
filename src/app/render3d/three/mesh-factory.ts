import { BufferGeometry, EdgesGeometry, Float32BufferAttribute, Group, LineSegments, Material, Matrix4, Mesh, Object3D, ShapeUtils, Vector2, Vector3 } from 'three';
import { BuildingModel, PrismPiece, RoofPiece, SkylightPiece, WindowPiece } from '../build/building-model';
import { GeometryAccumulator } from './geometry-accumulator';
import { MaterialSet, tinted } from './materials';
import { addPrism, addRoof } from './piece-geometry';
import { mergeRoofPieces } from './piece-merge';
import { addMergedPrisms } from './merged-prisms';

/** Edges sharper than this angle (degrees) get an outline. */
const EDGE_THRESHOLD_DEG = 20;

/**
 * Converts a BuildingModel into a three.js group. Pieces are batched into one mesh
 * (plus one outline) per kind — per color for furniture — keeping draw calls low
 * regardless of building size. Walls, foundations, partitions, slabs, decks and roofs are merged
 * along shared planes first (see merged-prisms.ts and piece-merge.ts) so a plane
 * that spans several pieces renders as one surface instead of a chain of
 * separately-capped segments. Doors are merged per color; furniture is left unmerged so pieces stay distinct.
 */
export function createBuildingObject(model: BuildingModel, materials: MaterialSet): Group {
  const group = new Group();
  group.name = 'building';

  const batches = new Map<string, { acc: GeometryAccumulator; material: Material }>();
  const batch = (name: string, material: Material): GeometryAccumulator => {
    let b = batches.get(name);
    if (!b) batches.set(name, (b = { acc: new GeometryAccumulator(), material }));
    return b.acc;
  };

  const prisms = (kind: PrismPiece['kind']) => model.pieces.filter((p): p is PrismPiece => p.kind === kind);
  for (const kind of ['wall', 'foundation', 'partition', 'slab', 'deck'] as const) {
    const pieces = prisms(kind);
    if (pieces.length) addMergedPrisms(batch(kind, materials.surfaces[kind]), pieces);
  }
  for (const roof of mergeRoofPieces(model.pieces.filter((p): p is RoofPiece => p.kind === 'roof'))) {
    addRoof(batch('roof', materials.surfaces.roof), roof);
  }
  for (const sky of model.pieces.filter((p): p is SkylightPiece => p.kind === 'skylight')) {
    addRoof(batch('skylight', materials.surfaces.skylight), { ...sky, kind: 'roof' });
  }
  const windows = model.pieces.filter((p): p is WindowPiece => p.kind === 'window');
  for (const w of windows) addWindow(batch('window', materials.surfaces.window), w);
  for (const post of prisms('post')) addPrism(batch('post', materials.surfaces.post), post);
  for (const item of prisms('furniture')) {
    const color = item.color ?? '#9aa3ab';
    addPrism(batch(`furniture:${color}`, tinted(materials, color)), item);
  }
  // Doors are built from overlapping parts (a six-panel leaf's frame over its core),
  // so they're merged per color for the recessed panels to read cleanly — each open
  // leaf on its own, closed, then turned into place on its hinges.
  const doorGroups = new Map<string, PrismPiece[]>();
  for (const door of prisms('door')) {
    const t = door.turn;
    const key = `${door.color ?? '#eef0f1'}|${t ? `${t.x},${t.y},${t.angle}` : ''}`;
    doorGroups.set(key, [...(doorGroups.get(key) ?? []), door]);
  }
  for (const pieces of doorGroups.values()) {
    const { color = '#eef0f1', turn } = pieces[0];
    const acc = batch(`door:${color}`, tinted(materials, color));
    if (!turn) {
      addMergedPrisms(acc, pieces);
      continue;
    }
    const closed = new GeometryAccumulator();
    addMergedPrisms(closed, pieces);
    acc.append(closed, turnMatrix(turn));
  }

  for (const [name, { acc, material }] of batches) {
    if (acc.isEmpty) continue;
    const geometry = acc.toGeometry();
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const outline = new LineSegments(new EdgesGeometry(geometry, EDGE_THRESHOLD_DEG), materials.edges);
    outline.name = `${name}-edges`;
    group.add(outline);
  }

  const bars = windowBars(windows);
  if (bars) {
    const lines = new LineSegments(bars, materials.bars);
    lines.name = 'window-bars';
    group.add(lines);
  }
  return group;
}

/**
 * A plan turn about a vertical axis as a world transform. Plan (x, y) is world
 * (X, Z), so turning from +x toward +y is a negative rotation about world Y.
 */
function turnMatrix({ x, y, angle }: NonNullable<PrismPiece['turn']>): Matrix4 {
  return new Matrix4()
    .makeTranslation(x, 0, y)
    .multiply(new Matrix4().makeRotationY(-angle))
    .multiply(new Matrix4().makeTranslation(-x, 0, -y));
}

/** World position of a point on a window's glass: u along the wall, height z, and `e` across it. */
function windowPoint(w: WindowPiece, u: number, z: number, e: number): Vector3 {
  return w.axis === 'x' ? new Vector3(u, z, e) : new Vector3(e, z, u);
}

/** A window's glass: its outline extruded across the wall, faces and edges. */
function addWindow(acc: GeometryAccumulator, w: WindowPiece): void {
  const pts = w.outline.map(([u, z]) => new Vector2(u, z));
  if (pts.length < 3) return;
  const [e0, e1] = [w.across - w.depth / 2, w.across + w.depth / 2];
  const normal = (sign: number) => windowPoint(w, 0, 0, sign);
  for (const [a, b, c] of ShapeUtils.triangulateShape(pts, [])) {
    for (const [e, sign] of [
      [e0, -1],
      [e1, 1],
    ]) {
      acc.triangle(windowPoint(w, pts[a].x, pts[a].y, e), windowPoint(w, pts[b].x, pts[b].y, e), windowPoint(w, pts[c].x, pts[c].y, e), normal(sign));
    }
  }
  // Sides: each edge's outward normal in the (u, z) plane, from the outline's winding.
  const turn = ShapeUtils.isClockWise(pts) ? -1 : 1;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    const out = windowPoint(w, (q.y - p.y) * turn, -(q.x - p.x) * turn, 0);
    acc.quad(windowPoint(w, p.x, p.y, e0), windowPoint(w, q.x, q.y, e0), windowPoint(w, q.x, q.y, e1), windowPoint(w, p.x, p.y, e1), out);
  });
}

/** Every window's sash and grille lines, on both faces of its glass, as one line set. */
function windowBars(windows: readonly WindowPiece[]): BufferGeometry | null {
  const positions: number[] = [];
  for (const w of windows) {
    for (const e of [w.across - w.depth / 2 - 0.01, w.across + w.depth / 2 + 0.01]) {
      for (const [[ua, za], [ub, zb]] of w.bars) {
        const a = windowPoint(w, ua, za, e);
        const b = windowPoint(w, ub, zb, e);
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
  }
  if (positions.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
}

/** Frees GPU geometry owned by an object tree. Materials are shared and disposed separately. */
export function disposeObjectGeometry(root: Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof Mesh || obj instanceof LineSegments) obj.geometry.dispose();
  });
}

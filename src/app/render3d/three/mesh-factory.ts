import { EdgesGeometry, Group, LineSegments, Mesh, Object3D } from 'three';
import { BuildingModel, BuildingPiece, PieceKind } from '../build/building-model';
import { GeometryAccumulator } from './geometry-accumulator';
import { MaterialSet } from './materials';
import { addPrism, addRoof } from './piece-geometry';

/** Edges sharper than this angle (degrees) get an outline. */
const EDGE_THRESHOLD_DEG = 20;

type PieceWriter<P extends BuildingPiece = BuildingPiece> = (acc: GeometryAccumulator, piece: P) => void;

/**
 * How each piece kind is turned into triangles. New piece kinds register a writer here;
 * the type below forces every kind in the model to have one.
 */
const WRITERS: { [K in PieceKind]: PieceWriter<Extract<BuildingPiece, { kind: K }>> } = {
  wall: addPrism,
  post: addPrism,
  slab: addPrism,
  roof: addRoof,
};

/**
 * Converts a BuildingModel into a three.js group. Pieces are batched into one mesh
 * (plus one outline) per kind, keeping draw calls low regardless of building size.
 */
export function createBuildingObject(model: BuildingModel, materials: MaterialSet): Group {
  const group = new Group();
  group.name = 'building';

  const accumulators = new Map<PieceKind, GeometryAccumulator>();
  for (const piece of model.pieces) {
    let acc = accumulators.get(piece.kind);
    if (!acc) accumulators.set(piece.kind, (acc = new GeometryAccumulator()));
    (WRITERS[piece.kind] as PieceWriter)(acc, piece);
  }

  for (const [kind, acc] of accumulators) {
    if (acc.isEmpty) continue;
    const geometry = acc.toGeometry();
    const mesh = new Mesh(geometry, materials.surfaces[kind]);
    mesh.name = kind;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const outline = new LineSegments(new EdgesGeometry(geometry, EDGE_THRESHOLD_DEG), materials.edges);
    outline.name = `${kind}-edges`;
    group.add(outline);
  }
  return group;
}

/** Frees GPU geometry owned by an object tree. Materials are shared and disposed separately. */
export function disposeObjectGeometry(root: Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof Mesh || obj instanceof LineSegments) obj.geometry.dispose();
  });
}

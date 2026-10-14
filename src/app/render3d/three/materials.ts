import { Color, LineBasicMaterial, Material, MeshStandardMaterial } from 'three';
import { PieceKind } from '../build/building-model';

export interface MaterialSet {
  surfaces: Record<PieceKind, Material>;
  edges: LineBasicMaterial;
  ground: MeshStandardMaterial;
}

export function createMaterials(): MaterialSet {
  const standard = (color: string, roughness = 0.85, metalness = 0) =>
    new MeshStandardMaterial({ color: new Color(color), roughness, metalness });
  return {
    surfaces: {
      wall: standard('#ece6da'),
      post: standard('#9b7652'),
      roof: standard('#56616c', 0.6, 0.15),
      slab: standard('#a9a8a3', 0.95),
    },
    edges: new LineBasicMaterial({ color: '#1f2428', transparent: true, opacity: 0.35 }),
    ground: standard('#c9d3c0', 1),
  };
}

export function disposeMaterials(set: MaterialSet): void {
  Object.values(set.surfaces).forEach((m) => m.dispose());
  set.edges.dispose();
  set.ground.dispose();
}

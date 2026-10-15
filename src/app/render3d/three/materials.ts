import { Color, FrontSide, LineBasicMaterial, Material, MeshStandardMaterial } from 'three';
import { PieceKind } from '../build/building-model';

export interface MaterialSet {
  surfaces: Record<PieceKind, Material>;
  /** Furniture materials by color, created on demand and kept for reuse. */
  tints: Map<string, Material>;
  edges: LineBasicMaterial;
  /** Window sash and grille lines. */
  bars: LineBasicMaterial;
  ground: MeshStandardMaterial;
}

const standard = (color: string, roughness = 0.85, metalness = 0) =>
  new MeshStandardMaterial({ color: new Color(color), roughness, metalness });

// By default three.js casts shadows from back faces, which for a wall is the side
// facing away from the sun — flush with the floor behind it, so the floor at the
// wall's base falls within the shadow bias and shows as a bright line. Casting
// from the sun-facing side puts the occluder a full wall thickness away instead;
// the light's normalBias keeps lit faces from shadowing themselves.
const caster = (color: string, roughness?: number, metalness?: number) => {
  const m = standard(color, roughness, metalness);
  m.shadowSide = FrontSide;
  return m;
};

export function createMaterials(): MaterialSet {
  return {
    surfaces: {
      wall: caster('#ece6da'),
      post: caster('#9b7652'),
      roof: caster('#56616c', 0.6, 0.15),
      slab: caster('#a9a8a3', 0.95),
      foundation: caster('#b8b5ad', 0.95),
      door: caster('#eef0f1', 0.6),
      window: standard('#6fa8d6', 0.25, 0.1),
      skylight: standard('#6fa8d6', 0.25, 0.1),
      partition: caster('#f6f3ed'),
      deck: caster('#c9b597', 0.9),
      furniture: caster('#9aa3ab'),
    },
    tints: new Map(),
    edges: new LineBasicMaterial({ color: '#1f2428', transparent: true, opacity: 0.35 }),
    bars: new LineBasicMaterial({ color: '#f7f8f6' }),
    ground: standard('#c9d3c0', 1),
  };
}

export function tinted(set: MaterialSet, color: string): Material {
  let m = set.tints.get(color);
  if (!m) set.tints.set(color, (m = caster(color, 0.8)));
  return m;
}

export function disposeMaterials(set: MaterialSet): void {
  Object.values(set.surfaces).forEach((m) => m.dispose());
  set.tints.forEach((m) => m.dispose());
  set.edges.dispose();
  set.bars.dispose();
  set.ground.dispose();
}

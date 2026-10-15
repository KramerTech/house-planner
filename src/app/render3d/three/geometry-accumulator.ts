import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';

const _ab = new Vector3();
const _ac = new Vector3();
const _n = new Vector3();

/**
 * Collects flat-shaded triangles into a single non-indexed BufferGeometry. Faces are
 * given an outward hint and the winding is fixed up automatically, so builders never
 * have to reason about vertex order.
 */
export class GeometryAccumulator {
  private readonly positions: number[] = [];

  get isEmpty(): boolean {
    return this.positions.length === 0;
  }

  triangle(a: Vector3, b: Vector3, c: Vector3, outward: Vector3): void {
    _ab.subVectors(b, a);
    _ac.subVectors(c, a);
    _n.crossVectors(_ab, _ac);
    if (_n.lengthSq() < 1e-12) return; // degenerate
    const [p, q, r] = _n.dot(outward) >= 0 ? [a, b, c] : [a, c, b];
    this.positions.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
  }

  /** Planar (or near-planar) quad a-b-c-d in perimeter order. */
  quad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, outward: Vector3): void {
    this.triangle(a, b, c, outward);
    this.triangle(a, c, d, outward);
  }

  /** Appends another accumulator's triangles, each vertex moved by `m`. */
  append(other: GeometryAccumulator, m: Matrix4): void {
    const p = other.positions;
    for (let i = 0; i < p.length; i += 3) {
      _ab.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
      this.positions.push(_ab.x, _ab.y, _ab.z);
    }
  }

  toGeometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.computeVertexNormals(); // non-indexed → flat normals
    geometry.computeBoundingSphere();
    return geometry;
  }
}

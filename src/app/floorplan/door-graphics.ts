import { Box } from '../core/floorplan/region';
import { Axis } from '../core/floorplan/wall-graph';
import { Door } from '../core/model/types';

/** SVG paths (plan units) for drawing a door in its wall. */
export interface DoorGraphics {
  /** The opening through the wall, painted over the wall in floor color. */
  gap: Box;
  /** Jambs, leaves, slabs. */
  solid: string;
  /** Swing arcs. */
  arc: string;
  /** Hidden parts (a pocket door's pocket). */
  dashed: string;
}

/**
 * Standard plan symbols: a swing door is a leaf drawn open 90° with its swing arc;
 * double doors are two half-width leaves; a pocket door slides into a dashed pocket
 * in the wall; a barn door is a slab on the wall face; a cased opening is just the gap;
 * an overhead garage door is its closed panel just inside the wall, with the door's
 * travel when open (up along the ceiling, as deep as the door is tall) dashed.
 */
export function doorGraphics(
  axis: Axis,
  at: number,
  c0: number,
  c1: number,
  door: Pick<Door, 'width' | 'kind' | 'swing' | 'hinge' | 'height'>,
): DoorGraphics {
  const pt = (along: number, across: number) => (axis === 'x' ? `${along} ${across}` : `${across} ${along}`);
  const a0 = at - door.width / 2;
  const a1 = at + door.width / 2;
  const face = door.swing > 0 ? c1 : c0;
  const gap: Box = axis === 'x' ? { x0: a0, x1: a1, y0: c0, y1: c1 } : { x0: c0, x1: c1, y0: a0, y1: a1 };
  let solid = `M ${pt(a0, c0)} L ${pt(a0, c1)} M ${pt(a1, c0)} L ${pt(a1, c1)}`;
  let arc = '';
  let dashed = '';

  const leaf = (hingeAt: number, freeAt: number, len: number) => {
    solid += ` M ${pt(hingeAt, face)} L ${pt(hingeAt, face + door.swing * len)}`;
    const dir = Math.sign(freeAt - hingeAt);
    const steps = 16;
    arc += ` M ${pt(hingeAt, face + door.swing * len)}`;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * (Math.PI / 2);
      arc += ` L ${pt(hingeAt + dir * len * Math.sin(t), face + door.swing * len * Math.cos(t))}`;
    }
  };

  switch (door.kind) {
    case 'single': {
      const [h, f] = door.hinge > 0 ? [a1, a0] : [a0, a1];
      leaf(h, f, door.width);
      break;
    }
    case 'double':
      leaf(a0, at, door.width / 2);
      leaf(a1, at, door.width / 2);
      break;
    case 'pocket': {
      // The pocket lies in the wall beyond the hinge end; the slab shows a little.
      const mid = (c0 + c1) / 2;
      const [p0, p1] = door.hinge > 0 ? [a1, a1 + door.width] : [a0 - door.width, a0];
      dashed = `M ${pt(p0, mid - 0.06)} L ${pt(p1, mid - 0.06)} L ${pt(p1, mid + 0.06)} L ${pt(p0, mid + 0.06)} Z`;
      const showing = door.width * 0.2;
      solid += door.hinge > 0 ? ` M ${pt(a1, mid)} L ${pt(a1 - showing, mid)}` : ` M ${pt(a0, mid)} L ${pt(a0 + showing, mid)}`;
      break;
    }
    case 'barn': {
      const f0 = face + door.swing * 0.08;
      const f1 = face + door.swing * 0.22;
      // The slab is drawn closed; its track runs on past the side it slides open toward.
      const [s0, s1] = [a0 - 0.15, a1 + 0.15];
      solid += ` M ${pt(s0, f0)} L ${pt(s1, f0)} L ${pt(s1, f1)} L ${pt(s0, f1)} Z`;
      const [t0, t1] = door.hinge > 0 ? [s0, s1 + door.width] : [s0 - door.width, s1];
      dashed = ` M ${pt(t0, f1)} L ${pt(t1, f1)}`;
      break;
    }
    case 'opening':
      break;
    case 'garage': {
      const panel = face - door.swing * 0.17;
      solid += ` M ${pt(a0, panel)} L ${pt(a1, panel)} L ${pt(a1, face)} L ${pt(a0, face)} Z`;
      const reach = face + door.swing * (door.height ?? 7);
      dashed = ` M ${pt(a0, face)} L ${pt(a0, reach)} L ${pt(a1, reach)} L ${pt(a1, face)}`;
      break;
    }
  }
  return { gap, solid, arc, dashed };
}

/**
 * Parses a typed length in feet: "12", "12.5", "12'", "12'6", "12' 6\"", "12-6",
 * "12 6" (feet and inches) or "6\"" (inches only). Null if it can't be read.
 */
export function parseLength(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  const inches = s.match(/^(\d+(?:\.\d+)?)\s*"$/);
  if (inches) return Number(inches[1]) / 12;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*'?\s*(?:[-\s]\s*)?(?:(\d+(?:\.\d+)?)\s*"?)?$/);
  if (!m) return null;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
}

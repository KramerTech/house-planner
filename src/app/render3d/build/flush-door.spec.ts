import { describe, expect, it } from 'vitest';
import { floorRegion } from '../../core/floorplan/floor-region';
import { addWall, clampAlong } from '../../core/floorplan/wall-graph';
import { createFloor, createSection, DEFAULT_SETTINGS } from '../../core/model/defaults';
import { buildBuildingModel } from './building-builder';
import { PrismPiece } from './building-model';

const settings = DEFAULT_SETTINGS;
const ti = settings.interiorWallThickness;
const sections = [createSection({ x: 0, y: 0, w: 16, d: 12 })];
const width = 32 / 12;
const slivers = (pieces: unknown[]) =>
  (pieces as PrismPiece[]).filter((p) => {
    if (p.kind !== 'wall' && p.kind !== 'partition') return false;
    const xs = p.footprint.map((q) => q.x);
    const ys = p.footprint.map((q) => q.y);
    return Math.max(...xs) - Math.min(...xs) < 1e-3 || Math.max(...ys) - Math.min(...ys) < 1e-3;
  });

describe('doors snapped flush against a wall', () => {
  it('leave the exterior wall they meet whole', () => {
    const outer = floorRegion(sections, settings, 0).outer.find((s) => s.side === 'N')!;
    const at = clampAlong(-100, width, outer.from + settings.wallThickness, outer.to - settings.wallThickness);
    const ground = { ...createFloor(), doors: [{ id: 'd', host: { side: 'N' as const, coord: -0.25 }, at, width, kind: 'single' as const, swing: 1 as const, hinge: 1 as const }] };
    const model = buildBuildingModel({ sections, settings, floors: [ground] }, { mode: 'floorplan', floorId: ground.id });
    expect(at - width / 2).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(slivers(model.pieces)).toEqual([]);
  });

  it('leave the interior wall they meet whole', () => {
    let ground = addWall(createFloor(), { x: 8, y: 0.25 }, { x: 8, y: 11.75 }, ti);
    ground = addWall(ground, { x: 0.25, y: 6 }, { x: 8, y: 6 }, ti);
    const host = ground.walls.find((w) => {
      const a = ground.nodes.find((n) => n.id === w.a)!;
      const b = ground.nodes.find((n) => n.id === w.b)!;
      return a.x === 8 && b.x === 8 && Math.min(a.y, b.y) === 0.25;
    })!;
    const at = clampAlong(100, width, 0.25 + ti / 2, 6 - ti / 2);
    ground = { ...ground, doors: [{ id: 'd', host: { wallId: host.id }, at, width, kind: 'single', swing: 1, hinge: 1 }] };
    const model = buildBuildingModel({ sections, settings, floors: [ground] }, { mode: 'floorplan', floorId: ground.id });
    expect(at + width / 2).toBeLessThanOrEqual(6 - ti / 2 + 1e-9);
    expect(slivers(model.pieces)).toEqual([]);
  });
});

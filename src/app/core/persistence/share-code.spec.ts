import { describe, expect, it } from 'vitest';
import { createFloor, createSection, DEFAULT_SETTINGS } from '../model/defaults';
import { Floor, Section } from '../model/types';
import { decodeShareCode, encodeShareCode, SharedDesign } from './share-code';

function furnishedFloors(): Floor[] {
  const ground = createFloor();
  ground.nodes = [
    { id: 'n1', x: 8, y: 0.5 },
    { id: 'n2', x: 8, y: 11.5 },
  ];
  ground.walls = [{ id: 'w1', a: 'n1', b: 'n2' }];
  ground.doors = [
    { id: 'd1', host: { wallId: 'w1' }, at: 6, width: 2.5, kind: 'pocket', swing: -1, hinge: 1 },
    { id: 'd2', host: { side: 'S', coord: 12 }, at: 4, width: 3, kind: 'single', swing: -1, hinge: -1 },
  ];
  ground.items = [{ id: 'i1', type: 'bed-queen', x: 4, y: 5, rotation: 90 }];
  ground.roomNames = [
    { id: 'r1', x: 4, y: 5, name: 'Primary bedroom' },
    { id: 'r2', x: 14, y: 5, name: 'Garage', unheated: true },
  ];
  const upper = createFloor(10);
  upper.openings = [{ id: 'o1', x0: 1, y0: 1, x1: 4, y1: 12 }];
  return [ground, upper];
}

function design(): SharedDesign {
  const root = createSection({ x: 0, y: 0, w: 16, d: 12 });
  const east = createSection({ x: 16, y: 0, w: 10, d: 12 }, { slopeDir: 'E', pitch: 2.5, lowWallHeight: 10.75 });
  const patio: Section = {
    ...createSection({ x: 0, y: 12, w: 26, d: 8 }),
    unheated: true,
    patio: { enabled: true, postSpacing: 6.5 },
  };
  return {
    name: 'Cabin “A”',
    rootId: root.id,
    // Root deliberately not first.
    sections: [east, root, patio],
    floors: [createFloor()],
    windows: [],
    skylights: [],
    settings: { ...DEFAULT_SETTINGS, overhang: 1.5 },
    camera: { position: [30.123, 20, -15.06], target: [8, 0, 6] },
  };
}

const strip = (s: Section) => ({ rect: s.rect, roof: s.roof, unheated: s.unheated, patio: s.patio });

describe('share codes', () => {
  it('round-trips a design, root first, with fresh ids', async () => {
    const d = design();
    const code = await encodeShareCode(d);
    expect(code).toMatch(/^[zj][A-Za-z0-9_-]+$/);
    const out = await decodeShareCode(code);
    expect(out.name).toBe(d.name);
    expect(out.settings).toEqual(d.settings);
    expect(out.camera).toEqual({ position: [30.1, 20, -15.1], target: [8, 0, 6] });
    expect(out.rootId).toBe(out.sections[0].id);
    const root = d.sections.find((s) => s.id === d.rootId)!;
    expect(out.sections.map(strip)).toEqual([root, ...d.sections.filter((s) => s !== root)].map(strip));
    expect(out.sections.some((s) => d.sections.some((o) => o.id === s.id))).toBe(false);
  });

  it('round-trips floors: walls, doors, furniture, openings and room names', async () => {
    const d = { ...design(), floors: furnishedFloors() };
    const out = await decodeShareCode(await encodeShareCode(d));
    const [ground, upper] = out.floors;
    expect(out.floors.map((f) => f.elevation)).toEqual([0, 10]);
    expect(ground.nodes.map(({ x, y }) => [x, y])).toEqual([[8, 0.5], [8, 11.5]]);
    expect(ground.walls).toHaveLength(1);
    expect(ground.doors[0]).toMatchObject({ host: { wallId: ground.walls[0].id }, at: 6, width: 2.5, kind: 'pocket', swing: -1 });
    expect(ground.doors[1]).toMatchObject({ host: { side: 'S', coord: 12 }, at: 4, kind: 'single' });
    expect(ground.items[0]).toMatchObject({ type: 'bed-queen', x: 4, y: 5, rotation: 90 });
    expect(upper.openings[0]).toMatchObject({ x0: 1, y0: 1, x1: 4, y1: 12 });
    expect(ground.roomNames[0]).toMatchObject({ x: 4, y: 5, name: 'Primary bedroom' });
    expect(ground.roomNames[0].unheated).toBeUndefined();
    expect(ground.roomNames[1]).toMatchObject({ x: 14, y: 5, name: 'Garage', unheated: true });
  });

  it('round-trips a basement, undug areas, room dividers and furniture groups', async () => {
    const [ground, upper] = furnishedFloors();
    ground.walls = [{ ...ground.walls[0], divider: true }];
    ground.doors = ground.doors.filter((d) => !('wallId' in d.host));
    ground.items = [...ground.items, { id: 'i2', type: 'nightstand', x: 1, y: 1, rotation: 0 }, { id: 'i3', type: 'nightstand', x: 7, y: 1, rotation: 0 }];
    ground.groups = [
      { id: 'g1', members: ['i2', 'i3'] },
      { id: 'g2', members: ['i1', 'g1'] },
    ];
    ground.doors.push({ id: 'gd', host: { side: 'S', coord: 12 }, at: 9, width: 16, kind: 'garage', swing: -1, hinge: 1, height: 8 });
    const basement = createFloor(-9.5);
    basement.unexcavated = [{ id: 'u1', x0: 16, y0: 0, x1: 26, y1: 12 }];
    const out = await decodeShareCode(await encodeShareCode({ ...design(), floors: [basement, ground, upper] }));
    expect(out.floors.map((f) => f.elevation)).toEqual([-9.5, 0, 10]);
    expect(out.floors[0].unexcavated[0]).toMatchObject({ x0: 16, y0: 0, x1: 26, y1: 12 });
    const g = out.floors[1];
    expect(g.walls[0].divider).toBe(true);
    expect(g.doors.find((d) => d.kind === 'garage')).toMatchObject({ width: 16, height: 8 });
    expect(g.groups).toHaveLength(2);
    const [inner, outer] = g.groups;
    expect(inner.members).toEqual([g.items[1].id, g.items[2].id]);
    expect(outer.members).toEqual([g.items[0].id, inner.id]);
  });

  it('round-trips windows of every shape, and skylights', async () => {
    const d: SharedDesign = {
      ...design(),
      windows: [
        { id: 'a', host: { side: 'S', coord: 12.25 }, shape: { t: 'rect', u: 2, z: 3, w: 3, h: 4 }, style: 'double-hung', grille: { cols: 3, rows: 2 } },
        { id: 'b', host: { side: 'E', coord: 26.25 }, shape: { t: 'circle', u: 6, z: 8, r: 1 }, style: 'fixed', grille: { cols: 1, rows: 1 } },
        { id: 'c', host: { side: 'N', coord: -0.25 }, shape: { t: 'arch', u: 4, z: 2, w: 3, h: 6 }, style: 'casement', grille: { cols: 1, rows: 1 } },
        { id: 'd', host: { side: 'W', coord: -0.25 }, shape: { t: 'poly', pts: [[1, 6], [4, 6], [2.5, 8]] }, style: 'fixed', grille: { cols: 1, rows: 1 } },
        { id: 'e', host: { side: 'S', coord: 12.25 }, shape: { t: 'roofline', u: 8, z: 4, w: 4, h: 3, top: -0.25, bottom: 0.125, lower: true }, style: 'slider', grille: { cols: 2, rows: 1 } },
      ],
      skylights: [{ id: 'k', x0: 3, y0: 2, x1: 5, y1: 6 }],
    };
    const out = await decodeShareCode(await encodeShareCode(d));
    expect(out.windows.map(({ host, shape, style, grille }) => ({ host, shape, style, grille }))).toEqual(
      d.windows.map(({ host, shape, style, grille }) => ({ host, shape, style, grille })),
    );
    expect(out.skylights[0]).toMatchObject({ x0: 3, y0: 2, x1: 5, y1: 6 });
  });

  it('is compact', async () => {
    const d = design();
    expect((await encodeShareCode(d)).length).toBeLessThan(JSON.stringify(d).length / 3);
  });

  it('tolerates whitespace from pasting', async () => {
    const code = await encodeShareCode(design());
    const wrapped = ` ${code.slice(0, 20)}\n${code.slice(20)} `;
    expect((await decodeShareCode(wrapped)).sections).toHaveLength(3);
  });

  it('rejects garbage and invalid layouts', async () => {
    await expect(decodeShareCode('hello')).rejects.toThrow();
    await expect(decodeShareCode('zAAAA')).rejects.toThrow();
    const d = design();
    d.sections[0].rect.x = 100; // disconnect the east section
    await expect(decodeShareCode(await encodeShareCode(d))).rejects.toThrow(/disconnected/);
  });
});

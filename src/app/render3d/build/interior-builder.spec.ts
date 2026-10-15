import { createFloor, createSection, DEFAULT_SETTINGS, SLAB_THICKNESS, STORY } from '../../core/model/defaults';
import { Floor, HouseWindow } from '../../core/model/types';
import { addWall } from '../../core/floorplan/wall-graph';
import { CATALOG_BY_ID, itemShape } from '../../core/floorplan/catalog';
import { buildBuildingModel } from './building-builder';
import { PrismPiece, WindowPiece } from './building-model';
import { DOOR_COLORS } from './door-builder';

const settings = DEFAULT_SETTINGS;
const ti = settings.interiorWallThickness;
// 20×12, flat roof with 20′ walls so an upper floor at 10′ has full headroom.
const sections = [createSection({ x: 0, y: 0, w: 20, d: 12 }, { pitch: 0, lowWallHeight: 20 })];

const prisms = (pieces: unknown[], kind: PrismPiece['kind']) => (pieces as PrismPiece[]).filter((p) => p.kind === kind);
const maxTop = (ps: PrismPiece[]) => Math.max(...ps.flatMap((p) => p.top));

function floors(): Floor[] {
  let ground = createFloor();
  ground = addWall(ground, { x: 10, y: 0.25 }, { x: 10, y: 11.75 }, ti);
  ground.doors = [
    { id: 'd', host: { wallId: ground.walls[0].id }, at: 6, width: 3, kind: 'single', swing: 1, hinge: 1 },
    { id: 'front', host: { side: 'S', coord: 12.25 }, at: 5, width: 3, kind: 'single', swing: -1, hinge: 1 },
  ];
  ground.items = [
    { id: 'bed', type: 'bed-queen', x: 5, y: 5, rotation: 0 },
    { id: 'st', type: 'stairs', x: 15, y: 6, rotation: 0 },
  ];
  const upper = createFloor(10);
  upper.openings = [{ id: 'o', x0: 13.5, y0: 0.25, x1: 16.5, y1: 11.75 }];
  return [ground, upper];
}

/** Pieces whose plan footprint contains (x, y). */
const at = (ps: PrismPiece[], x: number, y: number) =>
  ps.filter((p) => {
    const xs = p.footprint.map((q) => q.x);
    const ys = p.footprint.map((q) => q.y);
    return x > Math.min(...xs) && x < Math.max(...xs) && y > Math.min(...ys) && y < Math.max(...ys);
  });

describe('exterior view with floors', () => {
  const model = () => buildBuildingModel({ sections, settings, floors: floors() });

  it('cuts exterior doors through the wall, leaving a header above', () => {
    const walls = prisms(model().pieces, 'wall');
    const atDoor = at(walls, 5, 12);
    expect(atDoor).toHaveLength(1);
    expect(Math.min(...atDoor[0].bottom)).toBeCloseTo(STORY.doorHeight);
  });

  it('shows upper decks but no interior walls or furniture', () => {
    const { pieces } = model();
    expect(prisms(pieces, 'partition')).toHaveLength(0);
    expect(prisms(pieces, 'furniture')).toHaveLength(0);
    const decks = prisms(pieces, 'deck');
    expect(decks.length).toBeGreaterThan(0);
    expect(at(decks, 15, 6)).toHaveLength(0); // the opening
    expect(at(decks, 5, 6)).toHaveLength(1);
  });
});

describe('windows view', () => {
  // A 10′ one-story wing to the east (flat roof at 9′) beside the 20′-tall house.
  const wing = createSection({ x: 20, y: 0, w: 10, d: 12 }, { pitch: 0, lowWallHeight: 9 });
  const build = () => {
    const [ground, upper] = floors();
    const g = addWall(ground, { x: 25, y: 0.25 }, { x: 25, y: 11.75 }, ti);
    return buildBuildingModel({ sections: [...sections, wing], settings, floors: [g, upper] }, { mode: 'windows' });
  };

  it('builds interior walls full height: to the deck above, or the roof where there is no floor above', () => {
    const parts = prisms(build().pieces, 'partition');
    expect(at(parts, 10, 3).map((p) => maxTop([p]))).toEqual([10 - STORY.deckThickness]);
    expect(at(parts, 10, 6).map((p) => Math.min(...p.bottom))).toEqual([STORY.doorHeight]); // header over the door
    expect(at(parts, 25, 6).map((p) => maxTop([p]))).toEqual([9]);
  });

  it('keeps the roof and hangs every door, but leaves furniture out', () => {
    const { pieces } = build();
    expect(pieces.some((p) => p.kind === 'roof')).toBe(true);
    expect(prisms(pieces, 'furniture')).toHaveLength(0);
    expect(prisms(pieces, 'door').some((p) => p.sectionId === 'd')).toBe(true);
  });
});

describe('six-panel doors', () => {
  // A door's pieces carry its id.
  const leaf = (pieces: unknown[], id: string) =>
    prisms(pieces, 'door').filter((p) => p.sectionId === id && p.color !== DOOR_COLORS.hardware);

  it('hangs brown exterior doors in Exterior mode, but no interior ones', () => {
    const { pieces } = buildBuildingModel({ sections, settings, floors: floors() });
    const front = leaf(pieces, 'front');
    expect(front.length).toBeGreaterThan(0);
    expect(new Set(front.map((p) => p.color))).toEqual(new Set([DOOR_COLORS.exterior]));
    expect(maxTop(front)).toBeCloseTo(STORY.doorHeight);
    expect(leaf(pieces, 'd')).toHaveLength(0);
  });

  it('builds a leaf as a frame over a recessed core, with a knob each side', () => {
    const fs = floors();
    const { pieces } = buildBuildingModel({ sections, settings, floors: fs }, { mode: 'floorplan', floorId: fs[1].id });
    const parts = prisms(pieces, 'door').filter((p) => p.sectionId === 'd');
    const leafParts = parts.filter((p) => p.color === DOOR_COLORS.interior);
    // Core, two stiles, four rails, three mullions.
    expect(leafParts).toHaveLength(10);
    const xs = (p: PrismPiece) => p.footprint.map((q) => q.x);
    const thickness = (p: PrismPiece) => Math.max(...xs(p)) - Math.min(...xs(p));
    const [core, ...frame] = [...leafParts].sort((a, b) => thickness(a) - thickness(b));
    expect(frame.every((p) => thickness(p) > thickness(core))).toBe(true);
    expect(parts.filter((p) => p.color === DOOR_COLORS.hardware)).toHaveLength(2);
  });

  it('stands interior swing doors open 45° on their hinges, toward the swing side', () => {
    const fs = floors();
    const { pieces } = buildBuildingModel({ sections, settings, floors: fs }, { mode: 'windows' });
    expect(leaf(pieces, 'front').every((p) => !p.turn)).toBe(true); // exterior: closed
    // 'd' is in the wall on x = 10, 4.5..7.5 along it, hinged at y = 7.5, swinging east.
    const d = leaf(pieces, 'd');
    const turned = d.flatMap((p) => {
      const { x, y, angle } = p.turn!;
      return p.footprint.map((q) => ({
        x: x + Math.cos(angle) * (q.x - x) - Math.sin(angle) * (q.y - y),
        y: y + Math.sin(angle) * (q.x - x) + Math.cos(angle) * (q.y - y),
      }));
    });
    // The leaf's latch end, 3′ out from the hinge, and its back corner a leaf's thickness further.
    const reach = 3 * Math.SQRT1_2;
    const back = (1.375 / 12) * Math.SQRT1_2;
    expect(Math.max(...turned.map((q) => q.x))).toBeCloseTo(10 + ti / 2 + reach, 2);
    expect(Math.min(...turned.map((q) => q.y))).toBeCloseTo(7.5 - reach - back, 2);
    expect(Math.max(...turned.map((q) => q.y))).toBeLessThan(7.5 + 0.1); // the hinge end stays put
  });

  it('cuts the active floor’s interior doors off with its low walls', () => {
    const fs = floors();
    const { pieces } = buildBuildingModel({ sections, settings, floors: fs }, { mode: 'floorplan', floorId: fs[0].id });
    expect(maxTop(leaf(pieces, 'd'))).toBeCloseTo(STORY.partitionPreviewHeight);
    expect(maxTop(leaf(pieces, 'front'))).toBeCloseTo(STORY.doorHeight);
  });
});

describe('garage doors', () => {
  // A 16′ × 8′ garage door centered in the south wall.
  const build = (view?: 'floorplan') => {
    const ground = createFloor();
    ground.doors = [{ id: 'g', host: { side: 'S', coord: 12.25 }, at: 10, width: 16, kind: 'garage', swing: -1, hinge: 1, height: 8 }];
    return buildBuildingModel({ sections, settings, floors: [ground] }, view ? { mode: 'floorplan', floorId: ground.id } : undefined);
  };

  it('cuts its full size through the wall', () => {
    const walls = prisms(build().pieces, 'wall');
    expect(at(walls, 10, 12).map((p) => Math.min(...p.bottom))).toEqual([8]);
    expect(at(walls, 1, 12).map((p) => Math.min(...p.bottom))).toEqual([0]); // past its end (it spans x 2..18)
  });

  it('fills the opening with a sectional door just inside the wall', () => {
    const door = prisms(build().pieces, 'door');
    expect(door).toHaveLength(4 + 3); // four sections, three grooves
    expect(Math.min(...door.flatMap((p) => p.bottom))).toBeCloseTo(0);
    expect(maxTop(door)).toBeCloseTo(8);
    // Within the wall's thickness, against its inside face (y = 11.75).
    const ys = door.flatMap((p) => p.footprint.map((q) => q.y));
    expect(Math.min(...ys)).toBeCloseTo(11.75);
    expect(Math.max(...ys)).toBeCloseTo(11.75 + 2 / 12);
    expect(prisms(build('floorplan').pieces, 'door')).toHaveLength(7);
  });
});

describe('floorplan view', () => {
  const view = (i: number) => {
    const fs = floors();
    return buildBuildingModel({ sections, settings, floors: fs }, { mode: 'floorplan', floorId: fs[i].id });
  };

  it('removes roofs and cuts everything 9′ above the active floor', () => {
    const { pieces } = view(0);
    expect(pieces.some((p) => p.kind === 'roof')).toBe(false);
    expect(maxTop(prisms(pieces, 'wall'))).toBeCloseTo(9);
  });

  it('keeps the active floor’s interior walls low, with door gaps', () => {
    const parts = prisms(view(0).pieces, 'partition');
    expect(maxTop(parts)).toBeCloseTo(STORY.partitionPreviewHeight);
    expect(at(parts, 10, 6)).toHaveLength(0); // the doorway
  });

  it('builds floors below the active one full height, with door headers', () => {
    const { pieces } = view(1);
    const parts = prisms(pieces, 'partition');
    expect(maxTop(parts)).toBeCloseTo(10 - STORY.deckThickness);
    expect(at(parts, 10, 6).map((p) => Math.min(...p.bottom))).toEqual([STORY.doorHeight]);
    expect(maxTop(prisms(pieces, 'wall'))).toBeCloseTo(19);
  });

});

describe('knee walls', () => {
  // Slopes south from 21′ at the north wall to 15′ at the south: a floor at 10′ has
  // 8′ of headroom down to y = 6, where it gets a knee wall (centered on y = 6).
  const sloped = [createSection({ x: 0, y: 0, w: 20, d: 12 }, { slopeDir: 'S', pitch: 6, lowWallHeight: 15 })];
  const build = (openings: Floor['openings']) => {
    const ground = createFloor();
    const upper = { ...createFloor(10), openings };
    return buildBuildingModel({ sections: sloped, settings, floors: [ground, upper] }, { mode: 'floorplan', floorId: upper.id });
  };
  const kneeAt = (pieces: unknown[], x: number) => at(prisms(pieces, 'wall'), x, 6).filter((p) => Math.max(...p.top) > 12);

  it('walls off an upper floor where its headroom runs out', () => {
    expect(kneeAt(build([]).pieces, 4)).toHaveLength(1);
  });

  it('leaves the wall out wherever the floor is open to below', () => {
    // The opening stops at the knee wall's inside face; touching is enough.
    const { pieces } = build([{ id: 'o', x0: 2, x1: 6, y0: 0.25, y1: 5.75 }]);
    expect(kneeAt(pieces, 4)).toHaveLength(0);
    expect(kneeAt(pieces, 10)).toHaveLength(1);
  });
});

describe('stairs', () => {
  // 12×24 with 20′ walls; stairs along the west wall climbing north from y = 21.25.
  // A 10′ rise: 16 risers, 15 treads of 10", 3′ landings → y 2.75..21.25, flight 5.75..18.25.
  const tall = [createSection({ x: 0, y: 0, w: 12, d: 24 }, { pitch: 0, lowWallHeight: 20 })];
  const stair = { id: 'st', type: 'stairs', x: 3, y: 12, rotation: 0 as const };
  const build = (withUpper = true) => {
    const ground = { ...createFloor(), items: [stair] };
    const floors = withUpper ? [ground, createFloor(10)] : [ground];
    return buildBuildingModel({ sections: tall, settings, floors }, { mode: 'floorplan', floorId: floors.at(-1)!.id });
  };
  const stairPieces = (pieces: unknown[]) => prisms(pieces, 'furniture').filter((p) => p.footprint.every((q) => q.x >= 1.5 && q.x <= 4.5));

  it('climbs to the floor above with a landing pad at the bottom', () => {
    const steps = stairPieces(build(true).pieces);
    expect(maxTop(steps)).toBeCloseTo(10 - 10 / 16);
    expect(at(steps, 3, 20).map((p) => Math.max(...p.top))).toEqual([1 / 12]);
  });

  it('leaves the space under the flight open, each step reaching down to the one two below', () => {
    const steps = stairPieces(build(true).pieces).filter((p) => maxTop([p]) > 1 / 12);
    const riser = 10 / 16;
    const sorted = [...steps].sort((a, b) => maxTop([a]) - maxTop([b]));
    sorted.forEach((p, i) => expect(Math.min(...p.bottom)).toBeCloseTo(Math.max(0, i - 1) * riser));
    // Under the top step there's room to stand: over 7' clear.
    expect(Math.min(...sorted.at(-1)!.bottom)).toBeGreaterThan(7);
  });

  it('opens the floor above over the flight, leaving the top landing as floor', () => {
    const decks = prisms(build(true).pieces, 'deck');
    expect(at(decks, 3, 4.5)).toHaveLength(1); // top landing: the upper floor itself
    expect(at(decks, 3, 10)).toHaveLength(0); // over the flight: open
    expect(at(decks, 3, 18)).toHaveLength(1); // over the lowest step, 8′ clear already
    // The upper floor is the landing, so the stair adds no platform of its own.
    expect(at(stairPieces(build(true).pieces), 3, 4.5)).toHaveLength(0);
  });

  it('gets its own top platform when there is no floor above yet', () => {
    const cat = CATALOG_BY_ID.get('stairs')!;
    const platform = (floorAbove: boolean) => itemShape(cat, 10, floorAbove).parts.filter((p) => p.z0 === 9 && p.z1 === 10);
    expect(platform(false)).toHaveLength(1);
    expect(platform(true)).toHaveLength(0);
  });
});

describe('basement', () => {
  // The 20×12 house, its east 5′ left undug; stairs in the basement climb north at x = 3.
  const build = (active?: 'basement' | 'ground') => {
    const basement = createFloor(-9);
    basement.unexcavated = [{ id: 'u', x0: 15, y0: -2, x1: 22, y1: 14 }];
    basement.items = [{ id: 'st', type: 'stairs', x: 3, y: 6, rotation: 0 }];
    let ground = createFloor();
    ground = addWall(ground, { x: 10, y: 0.25 }, { x: 10, y: 11.75 }, ti, true); // a room divider
    const fs = [basement, ground];
    const view = active ? { mode: 'floorplan' as const, floorId: fs[active === 'basement' ? 0 : 1].id } : undefined;
    return buildBuildingModel({ sections, settings, floors: fs }, view);
  };

  it('digs out the basement’s footprint, not the undug part', () => {
    expect(build().excavation).toEqual([{ x0: -0.25, y0: -0.25, x1: 15.25, y1: 12.25 }]);
  });

  it('stands on concrete foundation walls, including along the undug edge', () => {
    const walls = prisms(build().pieces, 'foundation');
    for (const [x, y] of [
      [0, 6],
      [15, 6],
      [7, 0],
      [7, 12],
    ]) {
      const hit = at(walls, x, y);
      expect(hit).toHaveLength(1);
      expect(Math.min(...hit[0].bottom)).toBeCloseTo(-9);
      expect(maxTop(hit)).toBeCloseTo(-SLAB_THICKNESS);
    }
    expect(at(walls, 7, 6)).toHaveLength(0);
    expect(at(prisms(build().pieces, 'slab'), 7, 6).map((p) => Math.min(...p.bottom))).toEqual([-9 - SLAB_THICKNESS]);
  });

  it('frames the ground floor over the dug part, open over the stairs, and keeps the slab elsewhere', () => {
    const { pieces } = build();
    const slabsAt = (x: number, y: number) => at(prisms(pieces, 'slab'), x, y).filter((p) => maxTop([p]) > -0.01);
    expect(slabsAt(7, 6)).toHaveLength(0);
    expect(slabsAt(18, 6)).toHaveLength(1); // undug: slab on grade
    const decks = prisms(pieces, 'deck');
    expect(at(decks, 7, 6).map((p) => [Math.min(...p.bottom), maxTop([p])])).toEqual([[-STORY.deckThickness, 0]]);
    expect(at(decks, 3, 6)).toHaveLength(0); // over the flight
  });

  it('shows the basement in plan cut at ground level, with nothing above', () => {
    const { pieces } = build('basement');
    expect(prisms(pieces, 'wall')).toHaveLength(0);
    expect(prisms(pieces, 'deck')).toHaveLength(0);
    expect(maxTop(prisms(pieces, 'foundation'))).toBeCloseTo(-SLAB_THICKNESS);
    expect(prisms(pieces, 'furniture').length).toBeGreaterThan(0);
  });

  it('does not build room dividers', () => {
    expect(prisms(build('ground').pieces, 'partition')).toHaveLength(0);
  });
});

describe('windows and skylights', () => {
  const window: HouseWindow = {
    id: 'w',
    host: { side: 'S', coord: 12.25 },
    shape: { t: 'rect', u: 4, z: 3, w: 3, h: 9 },
    style: 'double-hung',
    grille: { cols: 2, rows: 1 },
  };
  const skylight = { id: 'k', x0: 4, y0: 4, x1: 6, y1: 8 };
  const build = (view?: 'floorplan') => {
    const ground = createFloor();
    return buildBuildingModel(
      { sections, settings, floors: [ground], windows: [window], skylights: [skylight] },
      view ? { mode: 'floorplan', floorId: ground.id } : undefined,
    );
  };

  it('puts glass through the wall, proud of both faces, without cutting it', () => {
    const { pieces } = build();
    const glass = pieces.filter((p): p is WindowPiece => p.kind === 'window');
    expect(glass).toHaveLength(1);
    expect(glass[0].axis).toBe('x');
    expect(glass[0].across).toBeCloseTo(12); // the wall's centerline
    expect(glass[0].depth).toBeGreaterThan(settings.wallThickness);
    expect(glass[0].bars).toHaveLength(2); // the meeting rail and one grille bar
    expect(at(prisms(pieces, 'wall'), 5, 12).map((p) => Math.min(...p.bottom))).toEqual([0]);
  });

  it('cuts windows off with the walls in Floorplan mode, and drops skylights with the roof', () => {
    const { pieces } = build('floorplan');
    const glass = pieces.find((p): p is WindowPiece => p.kind === 'window')!;
    expect(Math.max(...glass.outline.map((p) => p[1]))).toBeCloseTo(STORY.cutHeight);
    expect(pieces.some((p) => p.kind === 'skylight')).toBe(false);
    expect(build().pieces.filter((p) => p.kind === 'skylight')).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { createFloor } from '../model/defaults';
import { Floor, FurnitureItem } from '../model/types';
import { copyGroups, group, isGroup, pruneGroups, rotateAbout, ungroup, unitItems, unitsOf } from './groups';

const item = (id: string, x = 0, y = 0): FurnitureItem => ({ id, type: 'nightstand', x, y, rotation: 0 });

function furnished(): Floor {
  return { ...createFloor(), items: ['a', 'b', 'c', 'd'].map((id) => item(id)) };
}

describe('furniture groups', () => {
  it('selects a whole group from any piece, and nests groups', () => {
    let f = group(furnished(), ['a', 'b']);
    const ab = f.groups[0].id;
    expect(unitItems('a', f.groups)).toEqual(['a', 'b']);
    expect(unitItems('c', f.groups)).toEqual(['c']);

    f = group(f, unitsOf(['a', 'b', 'c'], f.groups));
    expect(f.groups[1].members).toEqual([ab, 'c']);
    expect(unitItems('b', f.groups)).toEqual(['a', 'b', 'c']);
    expect(unitsOf(['a', 'b', 'c', 'd'], f.groups)).toEqual([f.groups[1].id, 'd']);
  });

  it('ungroups one level at a time', () => {
    let f = group(furnished(), ['a', 'b']);
    f = group(f, [f.groups[0].id, 'c']);
    const outer = f.groups[1].id;
    f = ungroup(f, outer);
    expect(isGroup(outer, f.groups)).toBe(false);
    expect(unitItems('a', f.groups)).toEqual(['a', 'b']);
    expect(unitItems('c', f.groups)).toEqual(['c']);
  });

  it('dissolves groups left with one member after a delete', () => {
    let f = group(furnished(), ['a', 'b']);
    f = group(f, [f.groups[0].id, 'c']);
    f = pruneGroups({ ...f, items: f.items.filter((i) => i.id !== 'b') });
    // {a, b} became just a, which takes its place in the outer group.
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0].members).toEqual(['a', 'c']);
    f = pruneGroups({ ...f, items: f.items.filter((i) => i.id !== 'c') });
    expect(f.groups).toEqual([]);
  });

  it('copies group structure for duplicated furniture', () => {
    let f = group(furnished(), ['a', 'b']);
    f = group(f, [f.groups[0].id, 'c']);
    const ids = new Map([
      ['a', 'a2'],
      ['b', 'b2'],
      ['c', 'c2'],
    ]);
    const copies = copyGroups([f.groups[1].id], f.groups, ids);
    expect(copies).toHaveLength(2);
    const all = [...f.groups, ...copies];
    expect(unitItems('a2', all)).toEqual(['a2', 'b2', 'c2']);
    expect(unitItems('a', all)).toEqual(['a', 'b', 'c']);
  });

  it('turns pieces together, keeping their relative positions', () => {
    // Two pieces side by side along x, turned about their middle, end up stacked along y.
    const out = rotateAbout([item('a', 0, 0), item('b', 4, 0)], 2, 0);
    expect(out.map(({ x, y, rotation }) => ({ x, y, rotation }))).toEqual([
      { x: 2, y: -2, rotation: 90 },
      { x: 2, y: 2, rotation: 90 },
    ]);
    // A single piece turned about its own center stays put.
    expect(rotateAbout([item('a', 3, 5)], 3, 5)[0]).toMatchObject({ x: 3, y: 5, rotation: 90 });
  });
});

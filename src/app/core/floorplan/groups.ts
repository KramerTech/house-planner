import { newId } from '../model/defaults';
import { Floor, FurnitureItem, ItemGroup } from '../model/types';

/**
 * Furniture groups form a forest: each group's members are items or other groups.
 * A "unit" is a top-level member — an ungrouped item, or a group nobody contains —
 * and is what a click selects, so grouped furniture picks, moves and rotates as one.
 */

/** Which group each item or group belongs to. */
export function parents(groups: readonly ItemGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) for (const m of g.members) out.set(m, g.id);
  return out;
}

/** The top-level unit an item (or group) is part of. */
export function rootOf(id: string, groups: readonly ItemGroup[]): string {
  const up = parents(groups);
  let cur = id;
  for (let guard = 0; up.has(cur) && guard < 1000; guard++) cur = up.get(cur)!;
  return cur;
}

/** The items under an item or group id (an item is its own only leaf). */
export function leaves(id: string, groups: readonly ItemGroup[]): string[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out: string[] = [];
  const visit = (x: string, depth: number) => {
    const g = byId.get(x);
    if (!g) out.push(x);
    else if (depth < 1000) g.members.forEach((m) => visit(m, depth + 1));
  };
  visit(id, 0);
  return out;
}

/** The items selected by clicking an item: everything in its top-level unit. */
export const unitItems = (itemId: string, groups: readonly ItemGroup[]) => leaves(rootOf(itemId, groups), groups);

/** The distinct top-level units a set of items belongs to, in first-seen order. */
export function unitsOf(itemIds: readonly string[], groups: readonly ItemGroup[]): string[] {
  return [...new Set(itemIds.map((id) => rootOf(id, groups)))];
}

export const isGroup = (id: string, groups: readonly ItemGroup[]) => groups.some((g) => g.id === id);

/** Groups the given top-level units together. */
export function group(floor: Floor, units: readonly string[]): Floor {
  if (units.length < 2) return floor;
  return { ...floor, groups: [...floor.groups, { id: newId(), members: [...units] }] };
}

/** Dissolves a group: its members become units of the group it was in (if any). */
export function ungroup(floor: Floor, groupId: string): Floor {
  const g = floor.groups.find((x) => x.id === groupId);
  if (!g) return floor;
  const groups = floor.groups
    .filter((x) => x !== g)
    .map((x) => (x.members.includes(groupId) ? { ...x, members: x.members.flatMap((m) => (m === groupId ? g.members : [m])) } : x));
  return { ...floor, groups };
}

/**
 * Drops members that no longer exist, and groups left with fewer than two members
 * (a lone survivor takes the group's place in its parent).
 */
export function pruneGroups(floor: Floor): Floor {
  const items = new Set(floor.items.map((i) => i.id));
  let groups = floor.groups;
  for (let changed = true; changed; ) {
    changed = false;
    const ids = new Set(groups.map((g) => g.id));
    groups = groups.map((g) => {
      const members = g.members.filter((m) => items.has(m) || ids.has(m));
      if (members.length !== g.members.length) changed = true;
      return members.length === g.members.length ? g : { ...g, members };
    });
    const small = groups.find((g) => g.members.length < 2);
    if (small) {
      const keep = small.members[0];
      groups = groups
        .filter((g) => g !== small)
        .map((g) => (g.members.includes(small.id) ? { ...g, members: g.members.flatMap((m) => (m === small.id ? (keep ? [keep] : []) : [m])) } : g));
      changed = true;
    }
  }
  return groups === floor.groups ? floor : { ...floor, groups };
}

/**
 * Copies of the groups under the given units, for duplicated furniture: `itemIds`
 * maps each original item to its copy.
 */
export function copyGroups(units: readonly string[], groups: readonly ItemGroup[], itemIds: ReadonlyMap<string, string>): ItemGroup[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out: ItemGroup[] = [];
  const copy = (id: string): string => {
    const g = byId.get(id);
    if (!g) return itemIds.get(id) ?? id;
    const clone: ItemGroup = { id: newId(), members: g.members.map(copy) };
    out.push(clone);
    return clone.id;
  };
  units.forEach(copy);
  return out;
}

/**
 * Turns furniture a quarter turn clockwise (in plan) about a point, keeping the
 * pieces where they are relative to one another.
 */
export function rotateAbout(items: readonly FurnitureItem[], cx: number, cy: number): FurnitureItem[] {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return items.map((it) => ({
    ...it,
    x: r(cx - (it.y - cy)),
    y: r(cy + (it.x - cx)),
    rotation: ((it.rotation + 90) % 360) as FurnitureItem['rotation'],
  }));
}

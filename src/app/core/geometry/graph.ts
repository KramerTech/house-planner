import { Section } from '../model/types';
import { sharedEdgeLength } from './rect';

/** True if two sections share a positive length of edge. */
export function areAdjacent(a: Section, b: Section): boolean {
  return sharedEdgeLength(a.rect, b.rect) > 0;
}

/** Ids of every section reachable from `rootId` through shared edges. */
export function reachableFrom(sections: readonly Section[], rootId: string): Set<string> {
  const seen = new Set<string>();
  const root = sections.find((s) => s.id === rootId);
  if (!root) return seen;
  const queue: Section[] = [root];
  seen.add(root.id);
  while (queue.length) {
    const cur = queue.pop()!;
    for (const other of sections) {
      if (!seen.has(other.id) && areAdjacent(cur, other)) {
        seen.add(other.id);
        queue.push(other);
      }
    }
  }
  return seen;
}

export function isConnected(sections: readonly Section[], rootId: string): boolean {
  return reachableFrom(sections, rootId).size === sections.length;
}

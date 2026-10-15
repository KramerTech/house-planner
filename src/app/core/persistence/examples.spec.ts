import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, createSection } from '../model/defaults';
import { loadExamplesOnce } from './examples';
import { ProjectRepository } from './project-repository';
import { encodeShareCode } from './share-code';

/** A bare-bones localStorage for Node. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
  };
}

const code = (name: string) => {
  const p = createProject(name);
  const s = createSection({ x: 0, y: 0, w: 20, d: 12 });
  return encodeShareCode({ name, rootId: s.id, sections: [s], floors: p.floors, settings: p.settings, camera: null, windows: [], skylights: [] });
};

describe('example projects', () => {
  let codes: string[];
  beforeEach(async () => {
    globalThis.localStorage = memoryStorage();
    codes = await Promise.all(['Example 2', 'Example 10', 'Example 1'].map(code));
  });
  const names = (repo: ProjectRepository) => repo.listProjects().map((p) => p.name);
  const opening = (repo: ProjectRepository) => repo.listProjects().find((p) => p.id === repo.lastOpenId())?.name;

  /** A fetch that serves `codes` and counts how often it's asked. */
  const server = (body: unknown[] | null) => {
    const f = Object.assign(async () => (f.calls++, body), { calls: 0 });
    return f;
  };

  it('are added in name order on a first visit, which opens the first of them', async () => {
    const repo = new ProjectRepository();
    await loadExamplesOnce(repo, server(codes));
    expect(names(repo)).toEqual(['Example 1', 'Example 2', 'Example 10']);
    expect(opening(repo)).toBe('Example 1');
  });

  it('load once: never fetched again, so deleted ones stay deleted and later ones never come', async () => {
    const repo = new ProjectRepository();
    await loadExamplesOnce(repo, server(codes));
    repo.deleteProject(repo.listProjects().find((p) => p.name === 'Example 2')!.id);
    const later = server([...codes, await code('Example 3')]);
    await loadExamplesOnce(repo, later);
    expect(later.calls).toBe(0);
    expect(names(repo)).toEqual(['Example 1', 'Example 10']);
  });

  it('come once to an existing user too, leaving their open project open and skipping bad save strings', async () => {
    const repo = new ProjectRepository();
    const mine = createProject('My cabin');
    repo.saveProject(mine);
    repo.setLastOpenId(mine.id);
    await loadExamplesOnce(repo, server(['not a save string', 42, ...codes]));
    expect(names(repo)).toHaveLength(4);
    expect(opening(repo)).toBe('My cabin');
  });

  it('are tried again next time if they could not be fetched', async () => {
    const repo = new ProjectRepository();
    await loadExamplesOnce(repo, server(null));
    expect(repo.examplesLoaded()).toBe(false);
    await loadExamplesOnce(repo, server(codes));
    expect(names(repo)).toHaveLength(3);
    expect(repo.examplesLoaded()).toBe(true);
  });
});

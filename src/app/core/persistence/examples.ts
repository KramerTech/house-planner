import { createProject } from '../model/defaults';
import { Project } from '../model/types';
import { ProjectRepository } from './project-repository';
import { decodeShareCode, SharedDesign } from './share-code';

/**
 * Example projects a browser is given once: a JSON array of save strings, served
 * next to the app (public/examples.json). Relative, so it follows the base href.
 */
export const EXAMPLES_URL = 'examples.json';
/** Startup waits this long for the examples at most (ms), then goes on without them. */
const EXAMPLES_TIMEOUT_MS = 5000;

/** The examples file's save strings, or null if it's missing, unreadable or too slow. */
export async function fetchExamples(url = EXAMPLES_URL, timeoutMs = EXAMPLES_TIMEOUT_MS): Promise<unknown[] | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) return null;
    const codes: unknown = await res.json();
    return Array.isArray(codes) ? codes : null;
  } catch {
    return null; // no examples file, offline, or timed out
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gives this browser the example projects, once: the first time it runs the app
 * (or the first time since examples were added, for someone already using it),
 * before the project store starts. After that a flag in storage says they're
 * loaded, and startup doesn't wait on them again; they're ordinary projects from
 * then on, deleted like any other. If they can't be fetched, the next visit tries
 * again.
 */
export async function loadExamplesOnce(repo: ProjectRepository, fetchCodes: () => Promise<unknown[] | null> = fetchExamples): Promise<void> {
  if (repo.examplesLoaded()) return;
  const codes = await fetchCodes();
  if (!codes) return;
  await addExamples(repo, codes);
  repo.markExamplesLoaded();
}

/**
 * Saves the example projects, listed in name order. For a browser with no projects
 * yet, the first by name ("Example 1" before "Example 2", and before "Example 10")
 * is made the one to open, so a first visit opens it instead of a blank project.
 */
export async function addExamples(repo: ProjectRepository, codes: readonly unknown[]): Promise<void> {
  const firstVisit = repo.listProjects().length === 0;
  const designs: SharedDesign[] = [];
  for (const code of codes) {
    if (typeof code !== 'string') continue;
    try {
      designs.push(await decodeShareCode(code));
    } catch (err) {
      console.warn('Skipped an example project whose save string would not load.', err);
    }
  }
  if (!designs.length) return;

  designs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // The picker lists the most recently updated first, so stagger them to list in name order.
  const now = Date.now();
  const examples = designs.map(({ name, ...snapshot }, i): Project => ({ ...createProject(name), ...snapshot, createdAt: now - i, updatedAt: now - i }));
  for (const p of examples) repo.saveProject(p);
  if (firstVisit) repo.setLastOpenId(examples[0].id);
}

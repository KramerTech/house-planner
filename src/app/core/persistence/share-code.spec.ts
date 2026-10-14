import { describe, expect, it } from 'vitest';
import { createSection, DEFAULT_SETTINGS } from '../model/defaults';
import { Section } from '../model/types';
import { decodeShareCode, encodeShareCode, SharedDesign } from './share-code';

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

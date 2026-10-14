import { migrateProject } from '../persistence/project-repository';

describe('migrateProject', () => {
  it('upgrades a v1 project with no camera or checkpoints', () => {
    const v1 = {
      schemaVersion: 1,
      id: 'p',
      name: 'Old',
      rootId: 'a',
      sections: [{ id: 'a', rect: { x: 0, y: 0, w: 10, d: 10 }, roof: { slopeDir: 'S', pitch: 3, lowWallHeight: 9 }, patio: { enabled: false, postSpacing: 8 } }],
      settings: { overhang: 2 },
    };
    const p = migrateProject(v1)!;
    expect(p.schemaVersion).toBe(3);
    expect(p.camera).toBeNull();
    expect(p.checkpoints).toEqual([]);
    expect(p.activeCheckpointId).toBeNull();
    expect(p.settings.roofThickness).toBe(0.5);
  });

  it('marks existing patios as unheated', () => {
    const roof = { slopeDir: 'S', pitch: 3, lowWallHeight: 9 };
    const p = migrateProject({
      id: 'p',
      rootId: 'a',
      sections: [
        { id: 'a', rect: { x: 0, y: 0, w: 10, d: 10 }, roof, patio: { enabled: false, postSpacing: 8 } },
        { id: 'b', rect: { x: 10, y: 0, w: 10, d: 10 }, roof, patio: { enabled: true, postSpacing: 8 } },
      ],
    })!;
    expect(p.sections.map((s) => s.unheated)).toEqual([false, true]);
  });

  it('drops a dangling active checkpoint id', () => {
    const p = migrateProject({ id: 'p', rootId: 'a', sections: [], checkpoints: [], activeCheckpointId: 'gone' })!;
    expect(p.activeCheckpointId).toBeNull();
  });
});

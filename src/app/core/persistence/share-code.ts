import { validateLayout } from '../geometry/constraints';
import { DEFAULT_PATIO, DEFAULT_SETTINGS, newId, PATIO_LIMITS, ROOF_LIMITS } from '../model/defaults';
import { CameraState, DesignSnapshot, ProjectSettings, Section, SIDES } from '../model/types';

/**
 * Compact, copy-pasteable encoding of a design for sharing between browsers.
 *
 * Only the current design travels (name, sections, settings, camera); checkpoints and
 * ids don't. The design is packed into positional arrays, deflated, and base64url
 * encoded. The first character says how the body is encoded, so the format can grow:
 *   'z' — deflate-raw compressed JSON
 *   'j' — uncompressed JSON (used when compression doesn't help)
 *
 * Packed layout (version 1):
 *   [1, name, settings | 0, camera | 0, ...sections]
 *   settings: [roofThickness, overhang, wallThickness, postSize, defaultSectionDepth], 0 = defaults
 *   camera:   [px, py, pz, tx, ty, tz] rounded to 0.1 ft, 0 = none
 *   section:  [x, y, w, d, slope (index into N/E/S/W), pitch, lowWallHeight, flags, postSpacing?]
 *             flags: 1 = unheated, 2 = patio. postSpacing omitted when default.
 *   The root section is always first.
 */

const FORMAT_VERSION = 1;
const SETTINGS_KEYS: (keyof ProjectSettings)[] = [
  'roofThickness',
  'overhang',
  'wallThickness',
  'postSize',
  'defaultSectionDepth',
];

export interface SharedDesign extends DesignSnapshot {
  name: string;
}

type PackedSection = number[];
type Packed = [number, string, number[] | 0, number[] | 0, ...PackedSection[]];

const round1 = (v: number) => Math.round(v * 10) / 10;

export async function encodeShareCode(design: SharedDesign): Promise<string> {
  const root = design.sections.find((s) => s.id === design.rootId);
  if (!root) throw new Error('Design has no root section');
  const ordered = [root, ...design.sections.filter((s) => s !== root)];
  const settings = SETTINGS_KEYS.map((k) => design.settings[k]);
  const packed: Packed = [
    FORMAT_VERSION,
    design.name,
    SETTINGS_KEYS.every((k) => design.settings[k] === DEFAULT_SETTINGS[k]) ? 0 : settings,
    design.camera ? [...design.camera.position, ...design.camera.target].map(round1) : 0,
    ...ordered.map(packSection),
  ];
  const json = new TextEncoder().encode(JSON.stringify(packed));
  const deflated = await pipe(json, new CompressionStream('deflate-raw'));
  return deflated.length < json.length ? 'z' + toBase64Url(deflated) : 'j' + toBase64Url(json);
}

/** Decodes and validates a share code. Throws an Error with a user-readable message if it's unusable. */
export async function decodeShareCode(code: string): Promise<SharedDesign> {
  const clean = code.replace(/\s+/g, '');
  const kind = clean[0];
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(clean.slice(1));
    if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    else if (kind !== 'j') throw new Error();
  } catch {
    throw new Error('That doesn’t look like a share code.');
  }
  let packed: unknown;
  try {
    packed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('The share code is damaged or incomplete.');
  }
  return unpack(packed);
}

function packSection(s: Section): PackedSection {
  const { x, y, w, d } = s.rect;
  const flags = (s.unheated ? 1 : 0) | (s.patio.enabled ? 2 : 0);
  const out = [x, y, w, d, SIDES.indexOf(s.roof.slopeDir), s.roof.pitch, s.roof.lowWallHeight, flags];
  if (s.patio.postSpacing !== DEFAULT_PATIO.postSpacing) out.push(s.patio.postSpacing);
  return out;
}

function unpack(packed: unknown): SharedDesign {
  if (!Array.isArray(packed) || typeof packed[0] !== 'number') throw new Error('The share code is damaged.');
  if (packed[0] > FORMAT_VERSION) throw new Error('This share code is from a newer version of Home Designer.');
  const [, name, rawSettings, rawCamera, ...rawSections] = packed as Packed;

  const settings: ProjectSettings = { ...DEFAULT_SETTINGS };
  if (Array.isArray(rawSettings)) {
    SETTINGS_KEYS.forEach((k, i) => {
      if (isNum(rawSettings[i]) && rawSettings[i] > 0) settings[k] = rawSettings[i];
    });
  }

  let camera: CameraState | null = null;
  if (Array.isArray(rawCamera) && rawCamera.length === 6 && rawCamera.every(isNum)) {
    camera = {
      position: rawCamera.slice(0, 3) as CameraState['position'],
      target: rawCamera.slice(3, 6) as CameraState['target'],
    };
  }

  const sections = rawSections.map(unpackSection);
  if (sections.length === 0) throw new Error('The share code has no sections.');
  const rootId = sections[0].id;
  const violation = validateLayout(sections, rootId);
  if (violation) throw new Error(`The shared layout is invalid: ${violation}`);

  return { name: typeof name === 'string' && name.trim() ? name : 'Shared design', rootId, sections, settings, camera };
}

function unpackSection(raw: unknown): Section {
  if (!Array.isArray(raw) || raw.length < 8 || !raw.every(isNum)) throw new Error('The share code is damaged.');
  const [x, y, w, d, slope, pitch, low, flags, spacing] = raw as number[];
  const unheated = (flags & 1) !== 0;
  return {
    id: newId(),
    rect: { x, y, w, d },
    roof: {
      slopeDir: SIDES[slope] ?? 'S',
      pitch: clamp(pitch, ROOF_LIMITS.pitch.min, ROOF_LIMITS.pitch.max),
      lowWallHeight: clamp(low, ROOF_LIMITS.lowWallHeight.min, ROOF_LIMITS.lowWallHeight.max),
    },
    unheated,
    patio: {
      enabled: unheated && (flags & 2) !== 0,
      postSpacing:
        spacing === undefined
          ? DEFAULT_PATIO.postSpacing
          : clamp(spacing, PATIO_LIMITS.postSpacing.min, PATIO_LIMITS.postSpacing.max),
    },
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

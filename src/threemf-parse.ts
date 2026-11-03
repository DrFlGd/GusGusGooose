// Parses a 3MF (plain or Bambu/Prusa project) into printed parts as
// world-space meshes, with negative parts flagged so the caller can subtract
// them. Pure (no Node APIs) so the browser app can share it. No XML library:
// the 3MF mesh schema is regular enough for regexes.

import type { IndexedMesh } from './stl.ts';
import { unzip } from './zip-read.ts';

export interface Part {
  name: string;
  /** 'negative' parts are holes to subtract from the normal ones */
  kind: 'normal' | 'negative' | 'modifier';
  /** world-space mesh */
  mesh: IndexedMesh;
  /** the part's own mesh, before any transform */
  local: IndexedMesh;
  /** local → world */
  transform: Xf;
  /** id of the top-level build object this part belongs to */
  group: string;
  /** 1-based extruder/filament slot from the project settings, when present */
  extruder?: number;
  /** filament colour for that slot (#rrggbb), when the project file has it */
  color?: string;
}

/** 3MF transform: 12 numbers, row-vector convention (p' = p·M + t). */
export type Xf = number[];
export const IDENTITY: Xf = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface RawObject {
  id: string;
  type: string;
  mesh?: IndexedMesh;
  components: { objectId: string; path?: string; transform: Xf }[];
}

/**
 * Parses an unzipped 3MF: `files` maps each zip entry path (with a leading
 * slash, e.g. `/3D/3dmodel.model`) to its text. Only `.model` files and
 * `model_settings.config` are read.
 */
export function partsFromFiles(files: Map<string, string>): Part[] {
  const objects = new Map<string, RawObject>(); // key: `${file}#${id}`
  const buildItems: { objectId: string; path: string; transform: Xf }[] = [];
  let rootModel = '';
  for (const [rel, xml] of files) {
    if (!rel.endsWith('.model')) continue;
    for (const o of parseObjects(xml)) objects.set(`${rel}#${o.id}`, o);
    const build = xml.match(/<build[^>]*>([\s\S]*?)<\/build>/);
    if (build && build[1].includes('<item')) {
      rootModel = rel;
      for (const item of build[1].matchAll(/<item\s+([^>]*)\/?>/g)) {
        const a = attrs(item[1]);
        buildItems.push({ objectId: a.objectid, path: a['p:path'] ?? rel, transform: parseXf(a.transform) });
      }
    }
  }
  // part names and subtypes from the Bambu/Prusa model settings, when present
  const settings = [...files].find(([k]) => k.endsWith('model_settings.config'))?.[1];
  const names = partNames(settings);
  const colours = filamentColours([...files].find(([k]) => k.endsWith('project_settings.config'))?.[1]);

  const parts: Part[] = [];
  let group = '';
  const visit = (objectId: string, path: string, xf: Xf) => {
    const o = objects.get(`${path}#${objectId}`);
    if (!o) throw new Error(`3MF references missing object ${objectId} in ${path}`);
    if (o.mesh) {
      const meta = names.get(objectId);
      const kind: Part['kind'] = meta?.subtype === 'negative_part' ? 'negative'
        : meta?.subtype === 'modifier_part' ? 'modifier'
        : o.type === 'other' ? 'negative' : 'normal';
      const extruder = meta?.extruder;
      parts.push({ name: meta?.name ?? `object ${objectId}`, kind, mesh: transformMesh(o.mesh, xf), local: o.mesh, transform: xf, group, extruder, color: extruder ? colours[extruder - 1] : undefined });
    }
    for (const c of o.components) visit(c.objectId, c.path ?? path, compose(c.transform, xf));
  };
  for (const item of buildItems) { group = item.objectId; visit(item.objectId, item.path, item.transform); }
  if (!parts.length) throw new Error(`no printable parts found in the 3MF (root model ${rootModel || 'not found'})`);
  return parts;
}

/** Reads a 3MF from its bytes (browser or Node), unzipping with DecompressionStream. */
export async function parse3mf(data: ArrayBuffer | Uint8Array): Promise<Part[]> {
  const entries = await unzip(data);
  const files = new Map<string, string>();
  const dec = new TextDecoder();
  for (const [name, bytes] of entries) {
    if (name.endsWith('.model') || name.endsWith('_settings.config')) files.set('/' + name.replace(/^\/+/, ''), dec.decode(bytes));
  }
  return partsFromFiles(files);
}

function parseObjects(xml: string): RawObject[] {
  const out: RawObject[] = [];
  for (const m of xml.matchAll(/<object\s+([^>]*)>([\s\S]*?)<\/object>/g)) {
    const a = attrs(m[1]);
    const body = m[2];
    const o: RawObject = { id: a.id, type: a.type ?? 'model', components: [] };
    const meshXml = body.match(/<mesh>([\s\S]*?)<\/mesh>/);
    if (meshXml) {
      const verts: number[] = [];
      for (const v of meshXml[1].matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) verts.push(+v[1], +v[2], +v[3]);
      const tris: number[] = [];
      for (const t of meshXml[1].matchAll(/<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g)) tris.push(+t[1], +t[2], +t[3]);
      o.mesh = { positions: Float32Array.from(verts), triangles: Uint32Array.from(tris) };
    }
    for (const c of body.matchAll(/<component\s+([^>]*)\/?>/g)) {
      const ca = attrs(c[1]);
      o.components.push({ objectId: ca.objectid, path: ca['p:path'], transform: parseXf(ca.transform) });
    }
    out.push(o);
  }
  return out;
}

function partNames(xml?: string): Map<string, { name: string; subtype?: string; extruder?: number }> {
  const map = new Map<string, { name: string; subtype?: string; extruder?: number }>();
  if (!xml) return map;
  for (const p of xml.matchAll(/<part\s+id="(\d+)"(?:\s+subtype="(\w+)")?[^>]*>([\s\S]*?)<\/part>/g)) {
    const name = p[3].match(/<metadata key="name" value="([^"]*)"/)?.[1] ?? `part ${p[1]}`;
    const ex = p[3].match(/<metadata key="extruder" value="(\d+)"/)?.[1];
    map.set(p[1], { name, subtype: p[2], extruder: ex ? Number(ex) : undefined });
  }
  return map;
}

/** The `filament_colour` list from a Bambu/Orca project_settings.config, as #rrggbb strings. */
export function filamentColours(json?: string): string[] {
  const m = json?.match(/"filament_colour"\s*:\s*\[([^\]]*)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/"(#[0-9a-fA-F]{6})/g)].map((x) => x[1].toLowerCase());
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function parseXf(s?: string): Xf {
  if (!s) return IDENTITY;
  const n = s.trim().split(/\s+/).map(Number);
  return n.length === 12 ? n : IDENTITY;
}

/** first `a` then `b`, both row-vector 3x4 */
export function compose(a: Xf, b: Xf): Xf {
  const r: Xf = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
}

export function invert(x: Xf): Xf {
  const [a, b, c, d, e, f, g, h, i] = x;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const r = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  const t = x.slice(9);
  const tx = -(t[0] * r[0] + t[1] * r[3] + t[2] * r[6]);
  const ty = -(t[0] * r[1] + t[1] * r[4] + t[2] * r[7]);
  const tz = -(t[0] * r[2] + t[1] * r[5] + t[2] * r[8]);
  return [...r, tx, ty, tz];
}

export function applyXf(xf: Xf, p: [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  return [x * xf[0] + y * xf[3] + z * xf[6] + xf[9], x * xf[1] + y * xf[4] + z * xf[7] + xf[10], x * xf[2] + y * xf[5] + z * xf[8] + xf[11]];
}

export function transformMesh(m: IndexedMesh, xf: Xf): IndexedMesh {
  const p = m.positions;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = x * xf[0] + y * xf[3] + z * xf[6] + xf[9];
    out[i + 1] = x * xf[1] + y * xf[4] + z * xf[7] + xf[10];
    out[i + 2] = x * xf[2] + y * xf[5] + z * xf[8] + xf[11];
  }
  let triangles = m.triangles;
  // a mirroring transform flips winding
  const det = xf[0] * (xf[4] * xf[8] - xf[5] * xf[7]) - xf[1] * (xf[3] * xf[8] - xf[5] * xf[6]) + xf[2] * (xf[3] * xf[7] - xf[4] * xf[6]);
  if (det < 0) {
    triangles = Uint32Array.from(triangles);
    for (let i = 0; i < triangles.length; i += 3) { const t = triangles[i + 1]; triangles[i + 1] = triangles[i + 2]; triangles[i + 2] = t; }
  }
  return { positions: out, triangles };
}

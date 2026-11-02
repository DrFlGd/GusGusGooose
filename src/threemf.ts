// Reads a 3MF (plain or Bambu/Prusa project) and returns each printed part
// as a world-space mesh, with negative parts flagged so the caller can
// subtract them. No XML library: the 3MF mesh schema is regular enough for
// regexes, and this keeps the browser build dependency-free.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexedMesh } from './stl.ts';

export interface Part {
  name: string;
  /** 'negative' parts are holes to subtract from the normal ones */
  kind: 'normal' | 'negative' | 'modifier';
  mesh: IndexedMesh;
}

/** 3MF transform: 12 numbers, row-vector convention (p' = p·M + t). */
type Xf = number[];
const IDENTITY: Xf = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface RawObject {
  id: string;
  type: string;
  mesh?: IndexedMesh;
  components: { objectId: string; path?: string; transform: Xf }[];
}

export function read3mf(path: string): Part[] {
  const dir = mkdtempSync(join(tmpdir(), '3mf-'));
  execFileSync('unzip', ['-o', '-q', path, '-d', dir]);
  const files = walk(dir).filter((f) => f.endsWith('.model'));
  const objects = new Map<string, RawObject>(); // key: `${file}#${id}`
  const buildItems: { objectId: string; path: string; transform: Xf }[] = [];
  let rootModel = '';
  for (const file of files) {
    const rel = '/' + file.slice(dir.length + 1).replace(/\\/g, '/');
    const xml = readFileSync(file, 'utf8');
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
  const names = partNames(dir);

  const parts: Part[] = [];
  const visit = (objectId: string, path: string, xf: Xf) => {
    const o = objects.get(`${path}#${objectId}`);
    if (!o) throw new Error(`3MF references missing object ${objectId} in ${path}`);
    if (o.mesh) {
      const meta = names.get(objectId);
      const kind: Part['kind'] = meta?.subtype === 'negative_part' ? 'negative'
        : meta?.subtype === 'modifier_part' ? 'modifier'
        : o.type === 'other' ? 'negative' : 'normal';
      parts.push({ name: meta?.name ?? `object ${objectId}`, kind, mesh: transformMesh(o.mesh, xf) });
    }
    for (const c of o.components) visit(c.objectId, c.path ?? path, compose(c.transform, xf));
  };
  for (const item of buildItems) visit(item.objectId, item.path, item.transform);
  if (!parts.length) throw new Error(`no printable parts found in ${path} (root model ${rootModel || 'not found'})`);
  return parts;
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

function partNames(dir: string): Map<string, { name: string; subtype?: string }> {
  const map = new Map<string, { name: string; subtype?: string }>();
  const settings = walk(dir).find((f) => f.endsWith('model_settings.config'));
  if (!settings) return map;
  const xml = readFileSync(settings, 'utf8');
  for (const p of xml.matchAll(/<part\s+id="(\d+)"(?:\s+subtype="(\w+)")?[^>]*>([\s\S]*?)<\/part>/g)) {
    const name = p[3].match(/<metadata key="name" value="([^"]*)"/)?.[1] ?? `part ${p[1]}`;
    map.set(p[1], { name, subtype: p[2] });
  }
  return map;
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
function compose(a: Xf, b: Xf): Xf {
  const r: Xf = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
}

function transformMesh(m: IndexedMesh, xf: Xf): IndexedMesh {
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

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

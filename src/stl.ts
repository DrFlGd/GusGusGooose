// Minimal STL reader/writer. Reads binary or ASCII, returns a welded
// indexed triangle mesh (shared vertices), which is what Manifold needs.

import { readFileSync, writeFileSync } from 'node:fs';

export interface IndexedMesh {
  /** xyz per vertex, flat */
  positions: Float32Array;
  /** 3 vertex indices per triangle, flat */
  triangles: Uint32Array;
}

const WELD_DECIMALS = 4; // 0.1 µm; welds identical vertices, keeps real gaps

export function readStl(path: string): IndexedMesh {
  const buf = readFileSync(path);
  const soup = looksAscii(buf) ? parseAscii(buf.toString('latin1')) : parseBinary(buf);
  return weld(soup);
}

export function writeStl(path: string, mesh: IndexedMesh): void {
  const triCount = mesh.triangles.length / 3;
  const out = Buffer.alloc(84 + triCount * 50);
  out.write('GusGusGoose fit export', 0, 'latin1');
  out.writeUInt32LE(triCount, 80);
  let o = 84;
  const p = mesh.positions;
  const t = mesh.triangles;
  for (let i = 0; i < triCount; i++) {
    const a = t[i * 3] * 3, b = t[i * 3 + 1] * 3, c = t[i * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    out.writeFloatLE(nx, o); out.writeFloatLE(ny, o + 4); out.writeFloatLE(nz, o + 8);
    o += 12;
    for (const idx of [a, b, c]) {
      out.writeFloatLE(p[idx], o); out.writeFloatLE(p[idx + 1], o + 4); out.writeFloatLE(p[idx + 2], o + 8);
      o += 12;
    }
    out.writeUInt16LE(0, o);
    o += 2;
  }
  writeFileSync(path, out);
}

function looksAscii(buf: Buffer): boolean {
  if (buf.length < 84) return true;
  if (buf.subarray(0, 5).toString('latin1') !== 'solid') return false;
  // A binary file can start with "solid" too; trust the triangle count instead.
  const n = buf.readUInt32LE(80);
  return 84 + n * 50 !== buf.length;
}

function parseBinary(buf: Buffer): Float32Array {
  const n = buf.readUInt32LE(80);
  const soup = new Float32Array(n * 9);
  let o = 84 + 12;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 9; k++) {
      soup[i * 9 + k] = buf.readFloatLE(o);
      o += 4;
    }
    o += 2 + 12; // attribute bytes + next normal
  }
  return soup;
}

function parseAscii(text: string): Float32Array {
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const vals: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  return Float32Array.from(vals);
}

/** Triangle soup (9 floats per triangle) → indexed mesh with shared vertices. */
export function weld(soup: Float32Array): IndexedMesh {
  const scale = 10 ** WELD_DECIMALS;
  const index = new Map<string, number>();
  const positions: number[] = [];
  const triangles = new Uint32Array(soup.length / 3);
  for (let v = 0; v < soup.length / 3; v++) {
    const x = soup[v * 3], y = soup[v * 3 + 1], z = soup[v * 3 + 2];
    const key = `${Math.round(x * scale)},${Math.round(y * scale)},${Math.round(z * scale)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      index.set(key, id);
      positions.push(x, y, z);
    }
    triangles[v] = id;
  }
  // Drop degenerate triangles produced by welding.
  const kept: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
    if (a !== b && b !== c && a !== c) kept.push(a, b, c);
  }
  return { positions: Float32Array.from(positions), triangles: Uint32Array.from(kept) };
}

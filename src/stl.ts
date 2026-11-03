// Minimal STL parser/serializer, pure (no Node APIs) so the browser app can
// share it. Reads binary or ASCII, returns a welded indexed triangle mesh
// (shared vertices), which is what Manifold needs. File helpers live in
// stl-node.ts.

export interface IndexedMesh {
  /** xyz per vertex, flat */
  positions: Float32Array;
  /** 3 vertex indices per triangle, flat */
  triangles: Uint32Array;
}

const WELD_DECIMALS = 4; // 0.1 µm; welds identical vertices, keeps real gaps

export function parseStl(data: ArrayBuffer | Uint8Array): IndexedMesh {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const soup = looksAscii(bytes) ? parseAscii(latin1(bytes)) : parseBinary(bytes);
  return weld(soup);
}

export function serializeStl(mesh: IndexedMesh): Uint8Array {
  const triCount = mesh.triangles.length / 3;
  const out = new Uint8Array(84 + triCount * 50);
  const view = new DataView(out.buffer);
  const header = 'GusGusGoose fit export';
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  view.setUint32(80, triCount, true);
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
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const idx of [a, b, c]) {
      view.setFloat32(o, p[idx], true); view.setFloat32(o + 4, p[idx + 1], true); view.setFloat32(o + 8, p[idx + 2], true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return out;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

function looksAscii(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return true;
  if (latin1(bytes.subarray(0, 5)) !== 'solid') return false;
  // A binary file can start with "solid" too; trust the triangle count instead.
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
  return 84 + n * 50 !== bytes.length;
}

function parseBinary(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const n = view.getUint32(80, true);
  const soup = new Float32Array(n * 9);
  let o = 84 + 12;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 9; k++) {
      soup[i * 9 + k] = view.getFloat32(o, true);
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

/**
 * Which triangles of `mesh` survive an STL round trip (serializeStl then
 * parseStl): welding at WELD_DECIMALS drops triangles whose corners merge.
 * Lets per-triangle data written next to an STL stay aligned with it.
 */
export function survivesRoundTrip(mesh: IndexedMesh): boolean[] {
  const scale = 10 ** WELD_DECIMALS;
  const key = (v: number) => {
    const f = Math.fround; // the STL stores float32
    return `${Math.round(f(mesh.positions[v * 3]) * scale)},${Math.round(f(mesh.positions[v * 3 + 1]) * scale)},${Math.round(f(mesh.positions[v * 3 + 2]) * scale)}`;
  };
  const out: boolean[] = [];
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = key(mesh.triangles[i]), b = key(mesh.triangles[i + 1]), c = key(mesh.triangles[i + 2]);
    out.push(a !== b && b !== c && a !== c);
  }
  return out;
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

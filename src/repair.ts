// Rebuilds a broken mesh (edges shared by more than two faces, overlapping
// shells, holes) as one watertight solid, the way a voxel remesh does:
// the mesh is rasterised into a grid of inside/outside samples by casting
// a ray up every column and counting signed crossings, and the surface of
// that grid is extracted again with Manifold's level-set marcher. Details
// smaller than a voxel are lost; everything else survives, and the result
// is always manifold and is simplified so it is not heavier than it needs
// to be. Pure, shared by the CLI and the browser app.

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import { manifold } from './fit.ts';

export interface RepairOptions {
  /** grid pitch, mm; default from the model's size (about 1/160 of its longest side, 0.4 to 1.5 mm) */
  voxel?: number;
}

/** A sensible voxel size for a model of this extent. */
export function voxelFor(size: number): number {
  return Math.min(1.5, Math.max(0.4, size / 160));
}

/**
 * Occupancy of the mesh on a grid: `inside[(i * ny + j) * nz + k]` is 1
 * where the point (x0 + i v, y0 + j v, z0 + k v) is inside. Inside means
 * the winding number of the mesh along the +z ray is not zero, which holds
 * up for overlapping shells and doubled faces as long as the faces point
 * outward; a mesh with mixed orientation falls back to crossing parity.
 */
export function rasterise(mesh: IndexedMesh, v: number) {
  const P = mesh.positions, T = mesh.triangles;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    minX = Math.min(minX, P[i]); maxX = Math.max(maxX, P[i]);
    minY = Math.min(minY, P[i + 1]); maxY = Math.max(maxY, P[i + 1]);
    minZ = Math.min(minZ, P[i + 2]); maxZ = Math.max(maxZ, P[i + 2]);
  }
  const pad = 2;
  const x0 = minX - pad * v, y0 = minY - pad * v, z0 = minZ - pad * v;
  const nx = Math.ceil((maxX - x0) / v) + pad + 1, ny = Math.ceil((maxY - y0) / v) + pad + 1, nz = Math.ceil((maxZ - z0) / v) + pad + 1;
  // bucket the triangles by the columns their footprint covers (CSR layout)
  const nt = T.length / 3;
  const count = new Int32Array(nx * ny + 1);
  const range = (t: number) => {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const lx = Math.min(P[a], P[b], P[c]), hx = Math.max(P[a], P[b], P[c]);
    const ly = Math.min(P[a + 1], P[b + 1], P[c + 1]), hy = Math.max(P[a + 1], P[b + 1], P[c + 1]);
    return [Math.max(0, Math.floor((lx - x0) / v)), Math.min(nx - 1, Math.ceil((hx - x0) / v)), Math.max(0, Math.floor((ly - y0) / v)), Math.min(ny - 1, Math.ceil((hy - y0) / v))];
  };
  for (let t = 0; t < nt; t++) {
    const [i0, i1, j0, j1] = range(t);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) count[i * ny + j + 1]++;
  }
  for (let c = 1; c < count.length; c++) count[c] += count[c - 1];
  const fill = Int32Array.from(count.subarray(0, nx * ny));
  const items = new Int32Array(count[nx * ny]);
  for (let t = 0; t < nt; t++) {
    const [i0, i1, j0, j1] = range(t);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) items[fill[i * ny + j]++] = t;
  }
  const inside = new Uint8Array(nx * ny * nz);
  const zs: number[] = [], signs: number[] = [];
  let mixed = 0, consistent = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const col = i * ny + j;
    const x = x0 + i * v, y = y0 + j * v;
    zs.length = 0; signs.length = 0;
    for (let n = count[col]; n < count[col + 1]; n++) {
      const t = items[n];
      const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
      const ax = P[a] - x, ay = P[a + 1] - y, bx = P[b] - x, by = P[b + 1] - y, cx = P[c] - x, cy = P[c + 1] - y;
      // the column hits the triangle's footprint when the point is on the same side of all three edges
      const e0 = ax * by - ay * bx, e1 = bx * cy - by * cx, e2 = cx * ay - cy * ax;
      const area = e0 + e1 + e2;
      if (area === 0) continue;
      if ((e0 < 0 || e1 < 0 || e2 < 0) && (e0 > 0 || e1 > 0 || e2 > 0)) continue;
      // barycentric height of the crossing; the face's z normal sign comes from the signed footprint area
      const z = (e1 * P[a + 2] + e2 * P[b + 2] + e0 * P[c + 2]) / area;
      zs.push(z); signs.push(area > 0 ? 1 : -1);
    }
    if (!zs.length) continue;
    const order = zs.map((_, n) => n).sort((p, q) => zs[p] - zs[q]);
    // walk up the column: winding = signed crossings still above the point
    let winding = 0, parity = 0;
    for (const s of signs) winding += s;
    let n = 0;
    const total = signs.length;
    for (let k = 0; k < nz; k++) {
      const z = z0 + k * v;
      while (n < total && zs[order[n]] <= z) { winding -= signs[order[n]]; parity++; n++; }
      const above = total - n;
      if (above === 0) break;
      const w = winding !== 0, par = (above & 1) === 1;
      if (w !== par) mixed++; else consistent++;
      inside[col * nz + k] = w ? 1 : 0;
    }
  }
  // a mesh whose faces do not agree on which way is out gives a winding that disagrees with parity everywhere: use parity then
  if (mixed > consistent) {
    inside.fill(0);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const col = i * ny + j;
      const x = x0 + i * v, y = y0 + j * v;
      zs.length = 0;
      for (let n = count[col]; n < count[col + 1]; n++) {
        const t = items[n];
        const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
        const ax = P[a] - x, ay = P[a + 1] - y, bx = P[b] - x, by = P[b + 1] - y, cx = P[c] - x, cy = P[c + 1] - y;
        const e0 = ax * by - ay * bx, e1 = bx * cy - by * cx, e2 = cx * ay - cy * ax;
        const area = e0 + e1 + e2;
        if (area === 0 || ((e0 < 0 || e1 < 0 || e2 < 0) && (e0 > 0 || e1 > 0 || e2 > 0))) continue;
        zs.push((e1 * P[a + 2] + e2 * P[b + 2] + e0 * P[c + 2]) / area);
      }
      zs.sort((p, q) => p - q);
      let n = 0;
      for (let k = 0; k < nz; k++) {
        const z = z0 + k * v;
        while (n < zs.length && zs[n] <= z) n++;
        if (((zs.length - n) & 1) === 1) inside[col * nz + k] = 1;
      }
    }
  }
  return { inside, nx, ny, nz, x0, y0, z0, v };
}

/**
 * The mesh rebuilt as one watertight solid on a voxel grid. The grid is
 * blurred once so the surface is not stepped, and the level set is pulled
 * back by a fraction of a voxel so the result is not fatter than the input.
 */
export async function voxelRebuild(mesh: IndexedMesh, opts: RepairOptions = {}): Promise<{ solid: ManifoldT; voxel: number }> {
  const { Manifold } = await manifold();
  const P = mesh.positions;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], P[i + d]); hi[d] = Math.max(hi[d], P[i + d]); }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const v = opts.voxel ?? voxelFor(size);
  const g = rasterise(mesh, v);
  const { nx, ny, nz } = g;
  // one box blur, as a float field: 1 inside, 0 outside
  const field = new Float32Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => g.inside[(i * ny + j) * nz + k];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    let s = 0, n = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      const ii = i + di, jj = j + dj, kk = k + dk;
      if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) { n++; continue; }
      s += at(ii, jj, kk); n++;
    }
    field[(i * ny + j) * nz + k] = s / n;
  }
  const sample = (p: [number, number, number] | Float32Array | number[]) => {
    // trilinear read of the field; outside the grid is outside the model
    const fx = (p[0] - g.x0) / v, fy = (p[1] - g.y0) / v, fz = (p[2] - g.z0) / v;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return -0.5;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), tx = fx - i, ty = fy - j, tz = fz - k;
    const f = (a: number, b: number, c: number) => field[((i + a) * ny + j + b) * nz + k + c];
    const c00 = f(0, 0, 0) * (1 - tx) + f(1, 0, 0) * tx, c10 = f(0, 1, 0) * (1 - tx) + f(1, 1, 0) * tx;
    const c01 = f(0, 0, 1) * (1 - tx) + f(1, 0, 1) * tx, c11 = f(0, 1, 1) * (1 - tx) + f(1, 1, 1) * tx;
    const c0 = c00 * (1 - ty) + c10 * ty, c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz - 0.5;
  };
  const bounds = { min: [g.x0, g.y0, g.z0] as [number, number, number], max: [g.x0 + (nx - 1) * v, g.y0 + (ny - 1) * v, g.z0 + (nz - 1) * v] as [number, number, number] };
  // the marcher emits a triangle or two per surface voxel, most of them slivers on near-flat runs: merge those within a
  // fraction of a voxel (a tenth of the triangles at 0.66 mm), so the booleans downstream have less to chew on
  const solid = Manifold.levelSet(sample as (p: [number, number, number]) => number, bounds, v, 0).simplify(0.3 * v);
  return { solid, voxel: v };
}

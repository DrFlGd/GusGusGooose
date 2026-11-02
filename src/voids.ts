// Finds the cylindrical magnet voids already cut into the goose model and
// reports each one's mouth centre, outward axis, diameter and depth.
//
// Method: group triangles into smooth patches (adjacent normals within
// SMOOTH_DEG), then keep the patches that look like the inside wall of a
// cylinder: every normal perpendicular to one axis, normals wrapping all the
// way round, constant radius, normals pointing in toward the axis.

import type { IndexedMesh } from './stl.ts';

export interface MagnetVoid {
  /** centre of the void's mouth, on the goose surface */
  center: [number, number, number];
  /** unit vector pointing out of the void, away from the goose */
  axis: [number, number, number];
  diameter: number;
  depth: number;
  /** centre of the void floor */
  floor: [number, number, number];
  /** triangles in the cylindrical wall, for debugging */
  wallFaces: number;
}

const SMOOTH_DEG = 30;
const MAX_RADIUS = 15;
const MIN_WALL_FACES = 8;

type V3 = [number, number, number];

export function findVoids(mesh: IndexedMesh): MagnetVoid[] {
  const { positions: P, triangles: T } = mesh;
  const nTri = T.length / 3;
  const normals = new Float64Array(nTri * 3);
  const centroids = new Float64Array(nTri * 3);
  for (let i = 0; i < nTri; i++) {
    const a = T[i * 3] * 3, b = T[i * 3 + 1] * 3, c = T[i * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[i * 3] = nx / len; normals[i * 3 + 1] = ny / len; normals[i * 3 + 2] = nz / len;
    centroids[i * 3] = (P[a] + P[b] + P[c]) / 3;
    centroids[i * 3 + 1] = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    centroids[i * 3 + 2] = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
  }

  // edge → faces
  const edgeFaces = new Map<string, number[]>();
  const edgeKey = (u: number, v: number) => (u < v ? `${u},${v}` : `${v},${u}`);
  for (let i = 0; i < nTri; i++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(T[i * 3 + k], T[i * 3 + ((k + 1) % 3)]);
      const list = edgeFaces.get(key);
      if (list) list.push(i); else edgeFaces.set(key, [i]);
    }
  }
  const neighbours = (i: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k < 3; k++) {
      for (const f of edgeFaces.get(edgeKey(T[i * 3 + k], T[i * 3 + ((k + 1) % 3)])) ?? []) {
        if (f !== i) out.push(f);
      }
    }
    return out;
  };

  // smooth patches by flood fill
  const cosSmooth = Math.cos((SMOOTH_DEG * Math.PI) / 180);
  const patchOf = new Int32Array(nTri).fill(-1);
  const patches: number[][] = [];
  for (let seed = 0; seed < nTri; seed++) {
    if (patchOf[seed] !== -1) continue;
    const id = patches.length;
    const faces: number[] = [];
    const stack = [seed];
    patchOf[seed] = id;
    while (stack.length) {
      const f = stack.pop()!;
      faces.push(f);
      for (const g of neighbours(f)) {
        if (patchOf[g] !== -1) continue;
        const d = normals[f * 3] * normals[g * 3] + normals[f * 3 + 1] * normals[g * 3 + 1] + normals[f * 3 + 2] * normals[g * 3 + 2];
        if (d >= cosSmooth) { patchOf[g] = id; stack.push(g); }
      }
    }
    patches.push(faces);
  }

  const voids: MagnetVoid[] = [];
  const debug = !!process.env.GOOSE_DEBUG;
  const reject = (faces: number[], why: string) => { if (debug && faces.length >= MIN_WALL_FACES) console.log(`  patch ${faces.length} faces: ${why}`); };
  for (const faces of patches) {
    if (faces.length < MIN_WALL_FACES) continue;
    const axis = cylinderAxis(faces, normals);
    if (!axis) { reject(faces, 'no axis'); continue; }
    // all normals perpendicular to the axis, and wrapping the full circle
    let maxDot = 0;
    const meanN: V3 = [0, 0, 0];
    for (const f of faces) {
      const n: V3 = [normals[f * 3], normals[f * 3 + 1], normals[f * 3 + 2]];
      maxDot = Math.max(maxDot, Math.abs(dot(n, axis)));
      meanN[0] += n[0]; meanN[1] += n[1]; meanN[2] += n[2];
    }
    if (maxDot > 0.2) { if (faces.length < 400) reject(faces, `maxDot ${maxDot.toFixed(2)}`); continue; }
    if (norm(meanN) / faces.length > 0.3) { reject(faces, `meanN ${(norm(meanN) / faces.length).toFixed(2)}`); continue; }

    // a point on the axis = mean of face centroids
    const c0: V3 = [0, 0, 0];
    for (const f of faces) { c0[0] += centroids[f * 3]; c0[1] += centroids[f * 3 + 1]; c0[2] += centroids[f * 3 + 2]; }
    c0[0] /= faces.length; c0[1] /= faces.length; c0[2] /= faces.length;

    // radius from wall vertices, must be consistent; normals must point inward
    const verts = new Set<number>();
    for (const f of faces) { verts.add(T[f * 3]); verts.add(T[f * 3 + 1]); verts.add(T[f * 3 + 2]); }
    let rSum = 0, rSq = 0, tMin = Infinity, tMax = -Infinity;
    for (const v of verts) {
      const p: V3 = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      const d = sub(p, c0);
      const t = dot(d, axis);
      const r = norm(sub(d, scale(axis, t)));
      rSum += r; rSq += r * r; tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
    }
    const rMean = rSum / verts.size;
    const rStd = Math.sqrt(Math.max(0, rSq / verts.size - rMean * rMean));
    if (rMean > MAX_RADIUS || rStd / rMean > 0.08) { reject(faces, `rMean ${rMean.toFixed(2)} rStd/r ${(rStd / rMean).toFixed(2)}`); continue; }
    let inward = 0;
    for (const f of faces) {
      const d = sub([centroids[f * 3], centroids[f * 3 + 1], centroids[f * 3 + 2]], c0);
      const radial = sub(d, scale(axis, dot(d, axis)));
      if (dot(radial, [normals[f * 3], normals[f * 3 + 1], normals[f * 3 + 2]]) < 0) inward++;
    }
    if (inward < faces.length * 0.9) { reject(faces, `inward ${inward}/${faces.length} r ${rMean.toFixed(2)}`); continue; }

    // which end is the floor? a neighbouring face whose normal runs along the
    // axis and whose centroid lies inside the cylinder (the rim around the
    // mouth also has axis-aligned normals, but sits outside the radius)
    const wallSet = new Set(faces);
    let floorT = NaN;
    for (const f of faces) {
      for (const g of neighbours(f)) {
        if (wallSet.has(g)) continue;
        const n: V3 = [normals[g * 3], normals[g * 3 + 1], normals[g * 3 + 2]];
        if (Math.abs(dot(n, axis)) < 0.9) continue;
        const d = sub([centroids[g * 3], centroids[g * 3 + 1], centroids[g * 3 + 2]], c0);
        const t = dot(d, axis);
        const r = norm(sub(d, scale(axis, t)));
        if (r < rMean * 0.95) { floorT = t; break; }
      }
      if (!Number.isNaN(floorT)) break;
    }
    if (Number.isNaN(floorT)) { reject(faces, `no floor, r ${rMean.toFixed(2)} depth ${(tMax - tMin).toFixed(2)} at ${c0.map((v) => v.toFixed(1))}`); continue; } // open tube, not a pocket
    // orient axis so it points from the floor toward the mouth
    const out = Math.abs(floorT - tMin) < Math.abs(floorT - tMax) ? axis : scale(axis, -1);
    const tFloor = out === axis ? tMin : -tMax;
    const tMouth = out === axis ? tMax : -tMin;
    voids.push({
      center: add(c0, scale(out, tMouth)) as V3,
      floor: add(c0, scale(out, tFloor)) as V3,
      axis: out as V3,
      diameter: rMean * 2,
      depth: tMouth - tFloor,
      wallFaces: faces.length,
    });
  }
  return voids;
}

/** Direction perpendicular to all the patch normals: smallest eigenvector of the normal covariance. */
function cylinderAxis(faces: number[], normals: Float64Array): V3 | null {
  // 3x3 covariance of normals
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const f of faces) {
    const n = [normals[f * 3], normals[f * 3 + 1], normals[f * 3 + 2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += n[i] * n[j];
  }
  // power iteration on (trace*I - M) finds the smallest eigenvector of M
  const tr = m[0] + m[4] + m[8];
  const A = m.map((v, k) => (k % 4 === 0 ? tr - v : -v));
  let v: V3 = [0.3, 0.5, 0.8];
  for (let it = 0; it < 60; it++) {
    const w: V3 = [
      A[0] * v[0] + A[1] * v[1] + A[2] * v[2],
      A[3] * v[0] + A[4] * v[1] + A[5] * v[2],
      A[6] * v[0] + A[7] * v[1] + A[8] * v[2],
    ];
    const l = norm(w);
    if (l < 1e-12) return null;
    v = scale(w, 1 / l) as V3;
  }
  return v;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/** Guess which goose point each void is, from where its axis points. */
export function suggestNames(voids: MagnetVoid[]): Record<string, number> {
  const names: Record<string, number> = {};
  const taken = new Set<number>();
  const pick = (name: string, score: (v: MagnetVoid) => number) => {
    let best = -1, bestScore = -Infinity;
    voids.forEach((v, i) => {
      if (taken.has(i)) return;
      const s = score(v);
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best >= 0) { names[name] = best; taken.add(best); }
  };
  pick('head', (v) => v.axis[2]);
  pick('left_wing', (v) => v.axis[1]);
  pick('right_wing', (v) => -v.axis[1]);
  pick('beak', (v) => Math.abs(v.axis[0]));
  return names;
}

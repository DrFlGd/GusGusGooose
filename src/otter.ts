// The sea otter desk character (Jerred, 2026-11-09): his "Otter Solid Eyes"
// model painted after the concept art (dark brown body, light brown head and
// belly, black eyes, nose, smile and freckles), its bottom trimmed flat so it
// stands on a desk, a magnet seat in the top of the head and one on the chest
// between the paws (the same 10 x 4 mm magnets as the goose), and a slide-in
// channel from the flat base up to each seat with a key that fills it, as on
// the goose (src/slots.ts). Pure (no Node APIs): the CLI (build-otter.ts)
// makes the app's otter files from the source model, and the app builds the
// slide-in print from those files with the same code.

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import type { BuildObject, Material, MeshPart } from './threemf-write.ts';
import type { VoidPrimitive } from './map-voids.ts';
import type { MagnetVoid } from './voids.ts';
import type { FitProfile } from './fit.ts';
import { DEFAULT_PROFILE, fromManifold, fromManifoldTagged, manifold, toManifoldTagged } from './fit.ts';
import { buildChannel, DEFAULT_SLOTS, outerFace, seatSolid, type Channel, type SlotOptions, type V3 } from './slots.ts';
import { layFlat } from './slots-build.ts';
import { CORNERS, encodePaint } from './paint-tree.ts';

/** mm cut off the bottom of the source model: the feet soles, belly and tail tip become one flat footing (two pieces: body and tail). */
export const OTTER_TRIM = 2.5;

/** The concept art's palette, sampled from its paint swatches. Filament 1 is the dark brown (the object's own), 2 light brown, 3 black. */
export const OTTER_MATERIALS: Material[] = [
  { name: 'dark brown', color: '#65321c' },
  { name: 'light brown', color: '#e99c60' },
  { name: 'black', color: '#1a1a1a' },
];
export const DARK = 0, LIGHT = 1, BLACK = 2;

/** The goose's magnets: 10 x 4 mm discs in 10.2 x 4.2 mm seats. */
export const MAGNET_SEAT = { diameter: 10.2, depth: 4.2 };
/** least plastic over a seat's outer face, anywhere over the magnet, mm */
export const SEAT_SKIN = 1.2;

// ---------- mesh helpers ----------

interface FaceData {
  normals: Float32Array;
  centroids: Float32Array;
  adjacency: number[][];
  /** mean normal change per unit distance to the edge neighbours: + convex, − concave */
  curvature: Float32Array;
}

function faceData(mesh: IndexedMesh): FaceData {
  const P = mesh.positions, T = mesh.triangles, n = T.length / 3;
  const normals = new Float32Array(n * 3), centroids = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / l; normals[t * 3 + 1] = ny / l; normals[t * 3 + 2] = nz / l;
    for (let k = 0; k < 3; k++) centroids[t * 3 + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
  }
  const edges = new Map<number, number>();
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  const nv = P.length / 3;
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const a = T[t * 3 + k], b = T[t * 3 + (k + 1) % 3];
    const key = a < b ? a * nv + b : b * nv + a;
    const o = edges.get(key);
    if (o === undefined) edges.set(key, t); else { adjacency[t].push(o); adjacency[o].push(t); }
  }
  const curvature = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (const o of adjacency[t]) {
      const d0 = centroids[o * 3] - centroids[t * 3], d1 = centroids[o * 3 + 1] - centroids[t * 3 + 1], d2 = centroids[o * 3 + 2] - centroids[t * 3 + 2];
      const dl2 = d0 * d0 + d1 * d1 + d2 * d2 || 1;
      s += ((normals[o * 3] - normals[t * 3]) * d0 + (normals[o * 3 + 1] - normals[t * 3 + 1]) * d1 + (normals[o * 3 + 2] - normals[t * 3 + 2]) * d2) / dl2;
    }
    curvature[t] = s / Math.max(1, adjacency[t].length);
  }
  return { normals, centroids, adjacency, curvature };
}

/** The first face a ray hits: distance along the (unit) direction and the face, or face −1. */
export function rayHit(mesh: IndexedMesh, o: V3, d: V3): { t: number; face: number } {
  const P = mesh.positions, T = mesh.triangles;
  let best = Infinity, face = -1;
  for (let f = 0; f < T.length; f += 3) {
    const a = T[f] * 3, b = T[f + 1] * 3, c = T[f + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 0 && t < best) { best = t; face = f / 3; }
  }
  return { t: best, face };
}

// ---------- paint ----------

/**
 * Seeds for the paint, in the source model's frame (z up, facing −y, 68 x 101
 * x 125 mm, x centre 34): rays from the front (F x,z), back (B), above (U x,y)
 * and sides (L/R y,z) onto the region each colour starts from.
 */
const SEEDS: [number, 'F' | 'B' | 'U' | 'L' | 'R', number, number][] = [
  // light brown: face, cheeks, chin, chest, belly, top and back of the head, head sides
  [LIGHT, 'F', 34, 118], [LIGHT, 'F', 34, 86], [LIGHT, 'F', 12, 96], [LIGHT, 'F', 56, 96], [LIGHT, 'F', 34, 66], [LIGHT, 'F', 34, 40], [LIGHT, 'F', 34, 20],
  [LIGHT, 'U', 34, 50], [LIGHT, 'B', 34, 110], [LIGHT, 'L', 40, 105], [LIGHT, 'R', 40, 105],
  // dark brown: back, sides, paws, feet, tail, ears
  [DARK, 'B', 34, 70], [DARK, 'B', 34, 40], [DARK, 'L', 55, 40], [DARK, 'R', 55, 40], [DARK, 'F', 18, 66], [DARK, 'F', 50, 66], [DARK, 'F', 12, 6], [DARK, 'F', 56, 6],
  [DARK, 'U', 34, 90], [DARK, 'F', 4, 108], [DARK, 'F', 64, 108], [DARK, 'L', 46, 110], [DARK, 'R', 46, 110],
  // black: eyes and nose
  [BLACK, 'F', 21, 107], [BLACK, 'F', 46.5, 107], [BLACK, 'F', 34, 102],
];

/** The face the paint's dots and smile are looked for in (source frame): the front of the head, below the eyes. */
const inFaceZone = (c: Float32Array, t: number) => c[t * 3 + 1] < 32 && c[t * 3 + 2] > 78 && c[t * 3 + 2] < 104;
const inMouthZone = (c: Float32Array, t: number) => c[t * 3 + 1] < 14 && c[t * 3 + 2] > 78 && c[t * 3 + 2] < 99 && c[t * 3] > 14 && c[t * 3] < 54;

/**
 * Paints the source model: per-triangle DARK, LIGHT or BLACK. The colour
 * borders follow the sculpt: a watershed from the seeds over the surface,
 * flooding in order of curvature, so the regions meet along the creases the
 * model has there (the tufted neckline and belly edge, the eye and nose
 * rims). The freckles are the small bumps on the cheeks, the smile the
 * groove under the nose; a mode filter then smooths every border.
 */
export function paintOtter(mesh: IndexedMesh): Uint8Array {
  const { centroids: cen, adjacency: adj, curvature: curv } = faceData(mesh);
  const n = mesh.triangles.length / 3;
  // the barrier: the strongest bend in a face's ring, so a hairline crease still stops the flood
  const bar = new Float32Array(n);
  for (let t = 0; t < n; t++) { let b = Math.abs(curv[t]); for (const o of adj[t]) b = Math.max(b, Math.abs(curv[o])); bar[t] = b; }
  const cast = (dir: string, a: number, b: number) => {
    const [o, d]: [V3, V3] = dir === 'F' ? [[a, -50, b], [0, 1, 0]] : dir === 'B' ? [[a, 200, b], [0, -1, 0]] : dir === 'U' ? [[a, b, 250], [0, 0, -1]] : dir === 'L' ? [[-50, a, b], [1, 0, 0]] : [[150, a, b], [-1, 0, 0]];
    return rayHit(mesh, o, d).face;
  };
  const label = new Int8Array(n).fill(-1);
  // a binary min-heap of [barrier, face, label]
  const heap: [number, number, number][] = [];
  const push = (e: [number, number, number]) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; }
    }
    return top;
  };
  for (const [l, dir, a, b] of SEEDS) { const f = cast(dir, a, b); if (f >= 0) push([0, f, l]); }
  while (heap.length) {
    const [, t, l] = pop();
    if (label[t] >= 0) continue;
    label[t] = l;
    for (const o of adj[t]) if (label[o] < 0) push([bar[o], o, l]);
  }
  const out = new Uint8Array(n);
  for (let t = 0; t < n; t++) out[t] = label[t] < 0 ? DARK : label[t];

  // components of the faces `pick` accepts, flooding only through accepted faces
  const components = (pick: (t: number) => boolean) => {
    const seen = new Uint8Array(n), comps: number[][] = [];
    for (let s = 0; s < n; s++) {
      if (seen[s] || !pick(s)) continue;
      const comp = [s]; seen[s] = 1;
      for (let i = 0; i < comp.length; i++) for (const o of adj[comp[i]]) if (!seen[o] && pick(o)) { seen[o] = 1; comp.push(o); }
      comps.push(comp);
    }
    return comps;
  };
  // freckles: the small, sharply convex bumps on the cheeks, painted as round dots as wide as the bump
  const face = (t: number) => out[t] === LIGHT && inFaceZone(cen, t);
  for (const comp of components((t) => face(t) && curv[t] >= 0.5)) {
    if (comp.length < 3) continue;
    const c = [0, 1, 2].map((k) => comp.reduce((s, t) => s + cen[t * 3 + k], 0) / comp.length);
    const dist = (t: number) => Math.hypot(cen[t * 3] - c[0], cen[t * 3 + 1] - c[1], cen[t * 3 + 2] - c[2]);
    const r = Math.min(1.3, Math.max(0.6, Math.max(...comp.map(dist)) + 0.15));
    const q = [...comp], inq = new Set(q);
    for (let i = 0; i < q.length; i++) for (const o of adj[q[i]]) if (!inq.has(o) && face(o) && dist(o) < r) { inq.add(o); q.push(o); }
    for (const t of q) out[t] = BLACK;
  }
  // the smile: the groove under the nose and along the muzzle, widened by a ring of faces so it reads as a line in print
  const smile: number[] = [];
  for (const comp of components((t) => out[t] === LIGHT && inMouthZone(cen, t) && curv[t] <= -0.3)) {
    if (comp.length >= 6) for (const t of comp) { out[t] = BLACK; smile.push(t); }
  }
  for (const t of smile) for (const o of adj[t]) if (out[o] === LIGHT && inMouthZone(cen, o)) out[o] = BLACK;
  // a mode filter: a face whose neighbours mostly share another colour takes it (spikes off a border, notches into it)
  for (let pass = 0; pass < 2; pass++) {
    const prev = out.slice();
    for (let t = 0; t < n; t++) {
      const [a, b, c] = adj[t];
      if (c === undefined) continue;
      const la = prev[a], lb = prev[b], lc = prev[c];
      const major = la === lb || la === lc ? la : lb === lc ? lb : prev[t];
      if (major !== prev[t]) out[t] = major;
    }
  }
  return out;
}

/** Whole-face slicer paint codes: the palette index m is filament m + 1, and the dark brown (filament 1) is the object's own, so it carries none. */
export function wholeFaceCodes(faceMaterial: Uint8Array): string[] {
  const codes = OTTER_MATERIALS.map((_, m) => (m === 0 ? '' : encodePaint({ v: CORNERS, material: m }, (k) => (k === 0 ? 0 : k + 1))));
  return Array.from(faceMaterial, (m) => codes[m] ?? '');
}

// ---------- magnet seats ----------

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The seat as the slot code knows it, from a profile point: a cylinder whose first axis is as near x as the axis allows. */
export function seatFromPoint(name: string, p: MagnetVoid): VoidPrimitive {
  const axis = unit(p.axis);
  const helper: V3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e0 = unit(sub(helper, [axis[0] * dot(helper, axis), axis[1] * dot(helper, axis), axis[2] * dot(helper, axis)]));
  const e1 = cross(axis, e0);
  const face = p.faceCenter ?? p.center;
  return { name, anchor: 'otter', kind: 'cylinder', center: add(face, axis, -p.depth / 2), axes: [e0, e1, axis], size: [p.diameter, p.diameter, p.depth], mesh: { positions: new Float32Array(0), triangles: new Uint32Array(0) } };
}

/**
 * Places a seat under the surface point `q0`, its axis `n` (outward): sinks
 * the seat's outer face until the plastic over it is at least `skin`
 * everywhere over the magnet (rays along −n over the face's disc).
 */
export function placeSeat(mesh: IndexedMesh, q0: V3, n: V3, skin = SEAT_SKIN, seat = MAGNET_SEAT): MagnetVoid {
  const axis = unit(n);
  const helper: V3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e0 = unit(sub(helper, [axis[0] * dot(helper, axis), axis[1] * dot(helper, axis), axis[2] * dot(helper, axis)]));
  const e1 = cross(axis, e0);
  // surface heights over the disc, relative to q0 along the axis
  let lowest = Infinity;
  const r = seat.diameter / 2 + 0.2;
  for (const rr of [0, r / 2, r]) for (let j = 0; j < (rr ? 24 : 1); j++) {
    const th = (j / 24) * Math.PI * 2;
    const p = add(add(q0, e0, rr * Math.cos(th)), e1, rr * Math.sin(th));
    const hit = rayHit(mesh, add(p, axis, 30), [-axis[0], -axis[1], -axis[2]]);
    if (hit.face >= 0) lowest = Math.min(lowest, 30 - hit.t);
  }
  const face = add(q0, axis, lowest - skin);
  const centreHit = rayHit(mesh, add(face, axis, 30), [-axis[0], -axis[1], -axis[2]]);
  const skinAtCentre = 30 - centreHit.t;
  return {
    center: add(face, axis, skinAtCentre),
    floor: add(face, axis, -seat.depth),
    axis,
    mode: 'embedded',
    faceCenter: face,
    skin: skinAtCentre,
    diameter: seat.diameter,
    depth: seat.depth,
    shape: 'cylinder',
    wallFaces: 0,
  };
}

/** Least-squares surface normal over the patch of `mesh` a set of rays from the front hits: outward, unit. */
function frontNormal(mesh: IndexedMesh, x0: number, z0: number, half: number): { point: V3; normal: V3 } {
  const pts: V3[] = [];
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const x = x0 + (i / 2) * half, z = z0 + (j / 2) * half;
    const hit = rayHit(mesh, [x, -50, z], [0, 1, 0]);
    if (hit.face >= 0) pts.push([x, hit.t - 50, z]);
  }
  // y = a + b (x − x0) + c (z − z0)
  let sxx = 0, sxz = 0, szz = 0, sxy = 0, szy = 0, sy = 0;
  for (const [x, y, z] of pts) { const dx = x - x0, dz = z - z0; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; sxy += dx * y; szy += dz * y; sy += y; }
  const det = sxx * szz - sxz * sxz;
  const b = (sxy * szz - szy * sxz) / det, c = (szy * sxx - sxy * sxz) / det;
  const centre = rayHit(mesh, [x0, -50, z0], [0, 1, 0]);
  return { point: [x0, centre.t - 50, z0], normal: unit([b, -1, c]) };
}

/**
 * The two seats, found on the trimmed model: under the highest point of the
 * head, axis straight up; and on the chest between the paws (x 34, 62 mm up
 * after the trim, where the chest is widest between them), axis square to
 * the chest there (it faces forward and a little up).
 */
export function otterSeats(mesh: IndexedMesh): Record<string, MagnetVoid> {
  // the top of the head: the highest point near the middle
  // the highest point on the middle plane (the model is symmetric about x = 34)
  let apex: V3 = [34, 42, -Infinity];
  for (let y = 34; y <= 50; y += 0.5) {
    const hit = rayHit(mesh, [34, y, 250], [0, 0, -1]);
    if (hit.face >= 0 && 250 - hit.t > apex[2]) apex = [34, y, 250 - hit.t];
  }
  const head = placeSeat(mesh, apex, [0, 0, 1]);
  const chestAt = frontNormal(mesh, 34, 62, 4.5);
  const chest = placeSeat(mesh, chestAt.point, [0, chestAt.normal[1], chestAt.normal[2]]);
  return { head, chest };
}

// ---------- the body ----------

export interface OtterBody {
  /** painted, trimmed, the seats cut: what accessories fit against */
  body: ManifoldT;
  /** the same before the seats were cut */
  solid: ManifoldT;
  faceMaterial: Uint8Array;
  mesh: IndexedMesh;
  profile: FitProfile;
  firstID: number;
}

/**
 * From the painted source model: trims the bottom flat (z = 0 afterwards; the
 * cut is dark brown), places the seats and cuts them.
 */
export async function buildOtterBody(source: IndexedMesh, paint: Uint8Array, log = (s: string) => console.log(s)): Promise<OtterBody> {
  const { Manifold } = await manifold();
  const firstID = Manifold.reserveIDs(OTTER_MATERIALS.length);
  const tagged = await toManifoldTagged(source, paint, firstID);
  const solid = tagged.trimByPlane([0, 0, 1], OTTER_TRIM).translate([0, 0, -OTTER_TRIM]);
  const trimmed = fromManifoldTagged(solid, firstID, OTTER_MATERIALS.length, DARK);
  const bb = solid.boundingBox();
  log(`  trimmed ${OTTER_TRIM} mm off the bottom: ${(bb.max[0] - bb.min[0]).toFixed(1)} x ${(bb.max[1] - bb.min[1]).toFixed(1)} x ${bb.max[2].toFixed(1)} mm, footing ${solid.slice(0.01).area().toFixed(0)} mm² in ${solid.slice(0.01).toPolygons().length} pieces`);
  const points = otterSeats(trimmed.mesh);
  const voids: ManifoldT[] = [];
  for (const [name, p] of Object.entries(points)) {
    const seat = seatFromPoint(name, p);
    voids.push(seatSolid(Manifold, seat, 0, outerFace(seat, p.axis)));
    const f = (v: readonly number[]) => v.map((x) => x.toFixed(1)).join(', ');
    log(`  ${name.padEnd(6)} seat ${p.diameter} x ${p.depth} mm, face at (${f(p.faceCenter!)}), axis (${p.axis.map((x) => x.toFixed(3)).join(', ')}), skin ${p.skin!.toFixed(2)} mm at the centre (${SEAT_SKIN} least)`);
  }
  const body = solid.subtract(Manifold.union(voids));
  const out = fromManifoldTagged(body, firstID, OTTER_MATERIALS.length, DARK);
  const profile: FitProfile = { ...DEFAULT_PROFILE, points, forward: [0, -1, 0] };
  return { body, solid, faceMaterial: out.faceMaterial, mesh: out.mesh, profile, firstID };
}

// ---------- slide-in channels ----------

/**
 * Where each channel comes out on the flat base (trimmed frame), chosen by
 * scanning the body (2026-11-09): the chest channel runs down and back from
 * its seat to the body's footing behind the gap between the feet; the head
 * channel runs down the middle of the body to the tail's root, behind it, so
 * the two never meet. Both mouths are under the otter.
 */
export const OTTER_MOUTHS: Record<string, V3> = {
  head: [34, 70.5, 0],
  chest: [34, 45, 0],
};

export interface OtterSlotsBuild {
  options: SlotOptions;
  materials: Material[];
  /** the otter with its seats and channels cut */
  body: ManifoldT;
  /** the otter before any void was cut */
  bodySolid: ManifoldT;
  channels: Record<string, Channel>;
  notes: string[];
}

/**
 * The slide-in print from the app's otter (`body`, seats already cut, and its
 * profile). The keys fill the channels from the base up to the magnet and are
 * flush with the base. No tongue: nothing covers these mouths but the desk.
 */
export async function buildOtterSlots(body: ManifoldT, profile: FitProfile, options: SlotOptions = DEFAULT_SLOTS, log = (s: string) => console.log(s)): Promise<OtterSlotsBuild> {
  const { Manifold } = await manifold();
  const notes: string[] = [];
  // the solid otter: the seats filled again (a hair proud of their walls, so no sliver is left)
  const seats = Object.entries(profile.points).filter(([name]) => OTTER_MOUTHS[name]).map(([name, p]) => ({ name, p, seat: seatFromPoint(name, p) }));
  const fill = seats.map(({ seat, p }) => seatSolid(Manifold, seat, 0.02, outerFace(seat, p.axis)).translate(p.axis.map((v) => v * 0.02) as V3));
  const bodySolid = fill.length ? Manifold.union([body, ...fill]) : body;
  const channels: Record<string, Channel> = {};
  for (const { name, p, seat } of seats) {
    const ch = buildChannel(Manifold, { seat, mouth: OTTER_MOUTHS[name], drop: 0, tongue: false }, p.axis, bodySolid, { ...options, tongue: null });
    channels[name] = ch;
    const outside = ch.cut.subtract(bodySolid).decompose().filter((m) => m.volume() > 0.3);
    log(`  ${name.padEnd(6)} channel ${ch.length.toFixed(1)} mm to the base at (${OTTER_MOUTHS[name].join(', ')}), bore ${ch.bore[0].toFixed(1)} x ${ch.bore[1].toFixed(1)} mm, ${outside.length} opening${outside.length === 1 ? '' : 's'}; key ${ch.key.volume().toFixed(0)} mm³`);
    if (outside.length !== 1) notes.push(`${name}: the channel opens ${outside.length} times; it should open once, in the base.`);
  }
  const cuts = Object.values(channels).map((c) => c.cut);
  const names = Object.keys(channels);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    if (channels[names[i]].cut.intersect(channels[names[j]].cut).volume() > 1e-6) notes.push(`The ${names[i]} and ${names[j]} channels meet.`);
  }
  const cut = cuts.length ? body.subtract(Manifold.union(cuts)) : body;
  return { options, materials: OTTER_MATERIALS, body: cut, bodySolid, channels, notes };
}

/**
 * Which way a key lies on the plate: flat keys on a side ('square' end); the
 * upright version and the swept keys stand as they sit in the otter, the end
 * that is part of the base on the plate, so it has the base's finish.
 */
export function otterKeyDown(ch: Channel): V3 {
  if (ch.options.style === 'flat' && ch.options.keyEnd === 'square') return ch.frame.through;
  return [0, 0, -1];
}

/** The print: the otter where it stands, the keys side by side beside it, long sides along y. `otter` is the cut body's mesh and paint. */
export function layoutOtter(b: OtterSlotsBuild, otter: { mesh: IndexedMesh; faceMaterial: Uint8Array }): BuildObject[] {
  const bb = b.body.boundingBox();
  const yMid = (bb.min[1] + bb.max[1]) / 2;
  let x = bb.max[0] + 15;
  const keys = Object.entries(b.channels).map(([name, ch]) => {
    let flat = layFlat(ch.key, otterKeyDown(ch), 0, 0);
    let kb = flat.boundingBox();
    if (kb.max[0] - kb.min[0] > kb.max[1] - kb.min[1]) { flat = flat.rotate([0, 0, 90]); kb = flat.boundingBox(); }
    const w = kb.max[0] - kb.min[0];
    flat = flat.translate([x - kb.min[0], yMid - (kb.min[1] + kb.max[1]) / 2, -kb.min[2]]);
    x += w + 8;
    const part: MeshPart = { name: `key ${name}`, mesh: fromManifold(flat), material: DARK };
    return { name: `key ${name}`, parts: [part] };
  });
  return [{ name: 'otter', parts: [{ name: 'otter', mesh: otter.mesh, material: DARK, faceMaterial: otter.faceMaterial, paintCodes: wholeFaceCodes(otter.faceMaterial) }] }, ...keys];
}

/** The cut otter's mesh and paint, for export. */
export function otterPaint(b: OtterSlotsBuild, firstID: number): { mesh: IndexedMesh; faceMaterial: Uint8Array } {
  return fromManifoldTagged(b.body, firstID, OTTER_MATERIALS.length, DARK);
}

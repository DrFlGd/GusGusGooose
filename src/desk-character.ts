// What the desk characters other than the goose share (the sea otter, the
// bear): mesh helpers for painting a sculpt and placing magnet seats under
// its skin, and the slide-in print built from a character's body, its fit
// profile and a plan for each seat's channel. Pure (no Node APIs): the CLI
// (build-character.ts) makes each character's app files with it, and the app
// builds the slide-in print with the same code.

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import type { BuildObject, Material, MeshPart } from './threemf-write.ts';
import type { VoidPrimitive } from './map-voids.ts';
import type { MagnetVoid } from './voids.ts';
import type { FitProfile } from './fit.ts';
import { fromManifold, fromManifoldTagged, manifold } from './fit.ts';
import { buildChannel, outerFace, seatSolid, DEFAULT_SLOTS, type Channel, type SlotOptions, type V3 } from './slots.ts';
import { layFlat } from './slots-build.ts';
import { CORNERS, encodePaint } from './paint-tree.ts';

/** The goose's magnets: 10 x 4 mm discs in 10.2 x 4.2 mm seats. */
export const MAGNET_SEAT = { diameter: 10.2, depth: 4.2 };
/** least plastic over a seat's outer face, anywhere over the magnet, mm */
export const SEAT_SKIN = 1.2;

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------- mesh helpers ----------

export interface FaceData {
  normals: Float32Array;
  centroids: Float32Array;
  areas: Float32Array;
  adjacency: number[][];
  /** mean normal change per unit distance to the edge neighbours: + convex, − concave */
  curvature: Float32Array;
}

export function faceData(mesh: IndexedMesh): FaceData {
  const P = mesh.positions, T = mesh.triangles, n = T.length / 3;
  const normals = new Float32Array(n * 3), centroids = new Float32Array(n * 3), areas = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    areas[t] = l / 2;
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
  return { normals, centroids, areas, adjacency, curvature };
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

/**
 * A watershed over the surface from seed faces: each region floods in order
 * of the barrier (the strongest bend in a face's ring, so a hairline crease
 * still stops the flood), so regions meet along the creases the sculpt has.
 * Returns a label per face, −1 where no seed reached.
 */
export function watershed(fd: FaceData, seeds: { face: number; label: number }[]): Int8Array {
  const { adjacency: adj, curvature: curv } = fd;
  const n = adj.length;
  const bar = new Float32Array(n);
  for (let t = 0; t < n; t++) { let b = Math.abs(curv[t]); for (const o of adj[t]) b = Math.max(b, Math.abs(curv[o])); bar[t] = b; }
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
  for (const s of seeds) if (s.face >= 0) push([0, s.face, s.label]);
  while (heap.length) {
    const [, t, l] = pop();
    if (label[t] >= 0) continue;
    label[t] = l;
    for (const o of adj[t]) if (label[o] < 0) push([bar[o], o, l]);
  }
  return label;
}

/** A mode filter: a face whose neighbours mostly share another colour takes it (spikes off a border, notches into it). */
export function modeFilter(fd: FaceData, paint: Uint8Array, passes = 2): void {
  for (let pass = 0; pass < passes; pass++) {
    const prev = paint.slice();
    for (let t = 0; t < paint.length; t++) {
      const [a, b, c] = fd.adjacency[t];
      if (c === undefined) continue;
      const la = prev[a], lb = prev[b], lc = prev[c];
      const major = la === lb || la === lc ? la : lb === lc ? lb : prev[t];
      if (major !== prev[t]) paint[t] = major;
    }
  }
}

/**
 * Smooths the borders between colours at a set scale: each face near a
 * border takes the colour that covers most area within `radius` mm of it
 * (over the surface's own neighbourhood), so a notch or a tooth narrower than
 * about a nozzle goes, whatever the triangles' sizes.
 */
export function smoothBorders(fd: FaceData, paint: Uint8Array, radius = 0.5, passes = 2): void {
  const C = fd.centroids, A = fd.areas, n = paint.length, r2 = radius * radius;
  const stamp = new Int32Array(n).fill(-1);
  let mark = 0;
  const around = (t: number, visit: (o: number) => void) => {
    mark++;
    const stack = [t];
    stamp[t] = mark;
    while (stack.length) {
      const f = stack.pop()!;
      visit(f);
      for (const o of fd.adjacency[f]) {
        if (stamp[o] === mark) continue;
        stamp[o] = mark;
        const d0 = C[o * 3] - C[t * 3], d1 = C[o * 3 + 1] - C[t * 3 + 1], d2 = C[o * 3 + 2] - C[t * 3 + 2];
        if (d0 * d0 + d1 * d1 + d2 * d2 <= r2) stack.push(o);
      }
    }
  };
  for (let pass = 0; pass < passes; pass++) {
    const prev = paint.slice();
    const near = new Set<number>();
    for (let t = 0; t < n; t++) if (fd.adjacency[t].some((o) => prev[o] !== prev[t])) around(t, (o) => near.add(o));
    for (const t of near) {
      const area = new Float64Array(256);
      around(t, (o) => { area[prev[o]] += A[o]; });
      let best = prev[t];
      for (let l = 0; l < 256; l++) if (area[l] > area[best]) best = l;
      paint[t] = best;
    }
  }
}

/** Whole-face slicer paint codes: palette index m is filament m + 1, and m = 0 (filament 1) is the object's own, so it carries none. */
export function wholeFaceCodes(faceMaterial: Uint8Array): string[] {
  const codes: string[] = [];
  return Array.from(faceMaterial, (m) => (m === 0 ? '' : (codes[m] ??= encodePaint({ v: CORNERS, material: m }, (k) => (k === 0 ? 0 : k + 1)))));
}

/** The triangles of `mesh` whose bounds meet the box (lo, hi): rays that stay in the box hit the same faces, faster. */
export function cropMesh(mesh: IndexedMesh, lo: V3, hi: V3): IndexedMesh {
  const P = mesh.positions, T = mesh.triangles;
  const keep: number[] = [];
  for (let f = 0; f < T.length; f += 3) {
    let inBox = true;
    for (let k = 0; k < 3 && inBox; k++) {
      const a = P[T[f] * 3 + k], b = P[T[f + 1] * 3 + k], c = P[T[f + 2] * 3 + k];
      if (Math.max(a, b, c) < lo[k] || Math.min(a, b, c) > hi[k]) inBox = false;
    }
    if (inBox) keep.push(T[f], T[f + 1], T[f + 2]);
  }
  return { positions: P, triangles: Uint32Array.from(keep) };
}

/** Whether a point is inside the (closed) mesh: an odd number of crossings along a ray. */
export function insideMesh(mesh: IndexedMesh, o: V3): boolean {
  const P = mesh.positions, T = mesh.triangles;
  // a direction no edge lines up with
  const d = unit([0.1234, 0.2345, 0.9640]);
  let n = 0;
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
    if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) n++;
  }
  return n % 2 === 1;
}

// ---------- magnet seats ----------

/** The seat as the slot code knows it, from a profile point: a cylinder whose first axis is as near x as the axis allows. */
export function seatFromPoint(name: string, p: MagnetVoid): VoidPrimitive {
  const axis = unit(p.axis);
  const helper: V3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e0 = unit(sub(helper, [axis[0] * dot(helper, axis), axis[1] * dot(helper, axis), axis[2] * dot(helper, axis)]));
  const e1 = cross(axis, e0);
  const face = p.faceCenter ?? p.center;
  return { name, anchor: 'character', kind: 'cylinder', center: add(face, axis, -p.depth / 2), axes: [e0, e1, axis], size: [p.diameter, p.diameter, p.depth], mesh: { positions: new Float32Array(0), triangles: new Uint32Array(0) } };
}

/**
 * Places a seat under the surface point `q0`, its axis `n` (outward): sinks
 * the seat's outer face until the plastic over it is at least `skin`
 * everywhere over the magnet (rays along −n over the face's disc, cast from
 * `reach` mm outside, so a limb further out than that is not taken for the
 * skin; with `inside`, rays that would start inside the body are skipped).
 */
export function placeSeat(mesh: IndexedMesh, q0: V3, n: V3, skin = SEAT_SKIN, seat = MAGNET_SEAT, reach = 30, inside = false): MagnetVoid {
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
    const start = add(p, axis, reach);
    // a ray that starts inside the body is over solid (a seat at the root of a limb): no skin to keep there
    if (inside && insideMesh(mesh, start)) continue;
    const hit = rayHit(mesh, start, [-axis[0], -axis[1], -axis[2]]);
    if (hit.face >= 0) lowest = Math.min(lowest, reach - hit.t);
  }
  const face = add(q0, axis, lowest - skin);
  const centreHit = rayHit(mesh, add(face, axis, reach), [-axis[0], -axis[1], -axis[2]]);
  const skinAtCentre = reach - centreHit.t;
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

/** Least-squares surface normal over the patch a grid of rays along `dir` hits around `at` (spanning ±`half` along `u` and `v`): outward, unit, with the centre hit. */
export function patchNormal(mesh: IndexedMesh, at: V3, dir: V3, u: V3, v: V3, half: number): { point: V3; normal: V3 } {
  const d = unit(dir), w = unit(cross(u, v));
  const pts: V3[] = [];
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const o = add(add(add(at, u, (i / 2) * half), v, (j / 2) * half), d, -50);
    const hit = rayHit(mesh, o, d);
    if (hit.face >= 0) pts.push(add(o, d, hit.t));
  }
  // the plane through the points: h = a + b s + c t in the (u, v, w) frame
  let ss = 0, st = 0, tt = 0, sh = 0, th = 0;
  const local = pts.map((p) => { const q = sub(p, at); return [dot(q, u), dot(q, v), dot(q, w)]; });
  const mh = local.reduce((s, q) => s + q[2], 0) / local.length;
  const ms = local.reduce((s, q) => s + q[0], 0) / local.length, mt = local.reduce((s, q) => s + q[1], 0) / local.length;
  for (const [s, t, h] of local) { ss += (s - ms) ** 2; st += (s - ms) * (t - mt); tt += (t - mt) ** 2; sh += (s - ms) * (h - mh); th += (t - mt) * (h - mh); }
  const det = ss * tt - st * st;
  const b = (sh * tt - th * st) / det, c = (th * ss - sh * st) / det;
  let normal = unit(add(add(scaleV(u, -b), v, -c), w, 1));
  if (dot(normal, d) > 0) normal = scaleV(normal, -1);
  const centre = rayHit(mesh, add(at, d, -50), d);
  return { point: add(add(at, d, -50), d, centre.t), normal };
}
const scaleV = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

// ---------- slide-in channels ----------

/**
 * How a seat's channel runs: straight from the seat to `mouth` (a point on
 * the surface, usually the flat base), or first `drop` mm along `dropAxis`
 * and then straight to the mouth, for a seat no straight line leaves inside
 * the body (the key fills the second leg only).
 */
export interface ChannelPlan {
  mouth: V3;
  drop?: number;
  dropAxis?: V3;
  /** points the seat's centre passes through before the straight leg (see ChannelSpec.via) */
  via?: V3[];
  /** false for a channel whose key must keep a square inner end in the upright version (its mouth is not in the base, so it does not print standing) */
  levelEnd?: boolean;
}

export interface CharacterSlotsBuild {
  options: SlotOptions;
  materials: Material[];
  /** the character with its seats and channels cut */
  body: ManifoldT;
  /** the character before any void was cut */
  bodySolid: ManifoldT;
  channels: Record<string, Channel>;
  notes: string[];
}

/**
 * The slide-in print from a character's body (`body`, seats already cut) and
 * its profile: a channel for each seat that has a plan, and a key that fills
 * it from the mouth up to the magnet, flush with the surface. No tongue:
 * nothing covers these mouths but the desk (or the character's own chin).
 */
export async function buildCharacterSlots(body: ManifoldT, profile: FitProfile, plans: Record<string, ChannelPlan>, materials: Material[], options: SlotOptions = DEFAULT_SLOTS, log = (s: string) => console.log(s)): Promise<CharacterSlotsBuild> {
  const { Manifold } = await manifold();
  const notes: string[] = [];
  // the solid character: the seats filled again (a hair proud of their walls, so no sliver is left)
  const seats = Object.entries(profile.points).filter(([name]) => plans[name]).map(([name, p]) => ({ name, p, seat: seatFromPoint(name, p) }));
  const fill = seats.map(({ seat, p }) => seatSolid(Manifold, seat, 0.02, outerFace(seat, p.axis)).translate(p.axis.map((v) => v * 0.02) as V3));
  const bodySolid = fill.length ? Manifold.union([body, ...fill]) : body;
  const channels: Record<string, Channel> = {};
  for (const { name, p, seat } of seats) {
    const plan = plans[name];
    const ch = buildChannel(Manifold, { seat, mouth: plan.mouth, drop: plan.drop ?? 0, dropAxis: plan.dropAxis, via: plan.via, tongue: false, levelEnd: plan.levelEnd }, p.axis, bodySolid, { ...options, tongue: null });
    channels[name] = ch;
    const outside = ch.cut.subtract(bodySolid).decompose().filter((m) => m.volume() > 0.3);
    log(`  ${name.padEnd(11)} channel ${ch.length.toFixed(1)} mm to (${plan.mouth.map((v) => +v.toFixed(1)).join(', ')})${plan.via ? ` by way of ${plan.via.map((v) => `(${v.join(', ')})`).join(', ')}` : plan.drop ? ` after ${plan.drop} mm along (${plan.dropAxis!.join(', ')})` : ''}, bore ${ch.bore[0].toFixed(1)} x ${ch.bore[1].toFixed(1)} mm, ${outside.length} opening${outside.length === 1 ? '' : 's'}; key ${ch.key.volume().toFixed(0)} mm³`);
    if (outside.length !== 1) notes.push(`${name}: the channel opens ${outside.length} times; it should open once.`);
  }
  const names = Object.keys(channels);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    if (channels[names[i]].cut.intersect(channels[names[j]].cut).volume() > 1e-6) notes.push(`The ${names[i]} and ${names[j]} channels meet.`);
  }
  const cuts = Object.values(channels).map((c) => c.cut);
  const cut = cuts.length ? body.subtract(Manifold.union(cuts)) : body;
  return { options, materials, body: cut, bodySolid, channels, notes };
}

/**
 * Which way a key lies on the plate. A key whose mouth is in the flat base:
 * on a side when flat with a square end; else (upright, and swept) standing
 * on its base end, so that end has the base's finish. A key whose mouth is
 * elsewhere has a curved outer end: on a side when flat, and a swept one on
 * the seat's face plane, as the goose's.
 */
export function characterKeyDown(ch: Channel): V3 {
  const inBase = Math.abs(ch.spec.mouth[2]) < 0.01;
  if (ch.options.style === 'flat') return inBase && ch.options.keyEnd === 'level' ? [0, 0, -1] : ch.frame.through;
  return inBase ? [0, 0, -1] : ch.spec.seat.axes[2];
}

/** The print: the character where it stands, the keys side by side beside it, long sides along y. `painted` is the cut body's mesh and paint. */
export function layoutCharacter(b: CharacterSlotsBuild, painted: { mesh: IndexedMesh; faceMaterial: Uint8Array }, name: string): BuildObject[] {
  const bb = b.body.boundingBox();
  const yMid = (bb.min[1] + bb.max[1]) / 2;
  let x = bb.max[0] + 15;
  const keys = Object.entries(b.channels).map(([key, ch]) => {
    let flat = layFlat(ch.key, characterKeyDown(ch), 0, 0);
    let kb = flat.boundingBox();
    if (kb.max[0] - kb.min[0] > kb.max[1] - kb.min[1]) { flat = flat.rotate([0, 0, 90]); kb = flat.boundingBox(); }
    const w = kb.max[0] - kb.min[0];
    flat = flat.translate([x - kb.min[0], yMid - (kb.min[1] + kb.max[1]) / 2, -kb.min[2]]);
    x += w + 8;
    const part: MeshPart = { name: `key ${key.replace('_', ' ')}`, mesh: fromManifold(flat), material: 0 };
    return { name: part.name, parts: [part] };
  });
  return [{ name, parts: [{ name, mesh: painted.mesh, material: 0, faceMaterial: painted.faceMaterial, paintCodes: wholeFaceCodes(painted.faceMaterial) }] }, ...keys];
}

/** The cut character's mesh and paint, for export. */
export function characterPaint(b: CharacterSlotsBuild, firstID: number): { mesh: IndexedMesh; faceMaterial: Uint8Array } {
  return fromManifoldTagged(b.body, firstID, b.materials.length, 0);
}

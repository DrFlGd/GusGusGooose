// The fitting pipeline: place an accessory at a goose magnet point, carve the
// goose (plus clearance) out of it, cut the magnet pocket, sanity-check.

import Module from 'manifold-3d';
import type { Manifold as ManifoldT, ManifoldToplevel, Mesh as MeshT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import type { MagnetVoid } from './voids.ts';

export type V3 = [number, number, number];

export interface FitProfile {
  /** gap between goose surface and the carved accessory face, mm */
  clearance: number;
  /** pocket radius = void radius + this, mm */
  pocketRadialClearance: number;
  /** pocket depth = magnet thickness + this, mm */
  pocketAxialClearance: number;
  /** magnet thickness; the pocket is this deep plus axial clearance. Defaults to the void depth. */
  magnetThickness?: number;
  points: Record<string, MagnetVoid & { polarityOut?: 'N' | 'S' }>;
  /** other openings in the goose (magnet insertion slots) the fit treats as solid */
  slots?: MagnetVoid[];
  /** the character's forward direction, when the points cannot tell it (the goose's is from its head to its beak) */
  forward?: [number, number, number];
}

export const DEFAULT_PROFILE: Omit<FitProfile, 'points'> = {
  clearance: 0.2,
  pocketRadialClearance: 0.0, // the goose void already fits the magnet; mirror it
  pocketAxialClearance: 0.1,
};

export interface Placement {
  /** which entry of profile.points */
  point: string;
  /** how far the accessory's base plane sinks below the void mouth, mm */
  sink: number;
  /** rotation of the accessory about the magnet axis, degrees */
  spin: number;
  /** tilt of the accessory about its own x then y axes, degrees, pivoting on the magnet point (before the spin) */
  tilt?: [number, number];
  /** slide of the accessory base in its own XY, mm */
  offset: [number, number];
  /**
   * stand the accessory along this direction instead of the magnet axis (the
   * tilt of the surface around the magnet, from `surfaceUp`): the magnet frame
   * turned by the smallest rotation onto it, so the spin still faces the same
   * way; the pocket stays square to the magnet
   */
  up?: V3;
  /** per-accessory pocket overrides; anything unset mirrors the goose void and the profile */
  pocket?: PocketSpec;
}

export interface PocketSpec {
  /** magnet diameter, mm (default: the goose void's diameter) */
  diameter?: number;
  /** magnet thickness, mm (default: profile.magnetThickness, else the void's depth) */
  thickness?: number;
  /** extra radius, mm (default: profile.pocketRadialClearance) */
  radialClearance?: number;
  /** extra depth, mm (default: profile.pocketAxialClearance) */
  axialClearance?: number;
  /** skip the pocket entirely, for accessories that hold their magnet some other way */
  none?: boolean;
  /** crush ribs on the pocket wall: how many (0 = none). They let a loose pocket grip the magnet. */
  ribs?: number;
  /** how far each rib's tip reaches inside the magnet's nominal radius, mm (default 0.15); the rib squashes by that much */
  ribCrush?: number;
}

export interface FitResult {
  mesh: IndexedMesh;
  /** the same result as a Manifold, with the accessory's material runs intact (see fromManifoldTagged) */
  solid: ManifoldT;
  volumeBefore: number;
  volumeAfter: number;
  bodies: number;
  warnings: string[];
}

// one engine for everyone: callers that start together must share it, or their solids cannot be mixed
let wasm: Promise<ManifoldToplevel> | null = null;
export function manifold(): Promise<ManifoldToplevel> {
  if (!wasm) wasm = Module().then((m) => { m.setup(); return m; });
  return wasm;
}

export async function toManifold(mesh: IndexedMesh): Promise<ManifoldT> {
  const { Manifold, Mesh } = await manifold();
  const m = new Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.triangles });
  m.merge();
  const man = new Manifold(m);
  const status = man.status();
  if (status !== 'NoError') throw new Error(`mesh is not manifold: ${status}`);
  return man;
}

/**
 * Like toManifold, but tags each triangle's material as a run so booleans
 * carry it through: run originalIDs are `firstID + material`, with firstID
 * from `Manifold.reserveIDs(materialCount)`. Triangles are sorted by material.
 */
export async function toManifoldTagged(mesh: IndexedMesh, faceMaterial: Uint8Array, firstID: number): Promise<ManifoldT> {
  const { Manifold, Mesh } = await manifold();
  const n = faceMaterial.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => faceMaterial[a] - faceMaterial[b] || a - b);
  const triVerts = new Uint32Array(n * 3);
  const runIndex: number[] = [], runOriginalID: number[] = [];
  let last = -1;
  order.forEach((t, i) => {
    triVerts[i * 3] = mesh.triangles[t * 3]; triVerts[i * 3 + 1] = mesh.triangles[t * 3 + 1]; triVerts[i * 3 + 2] = mesh.triangles[t * 3 + 2];
    if (faceMaterial[t] !== last) { last = faceMaterial[t]; runIndex.push(i * 3); runOriginalID.push(firstID + last); }
  });
  const m = new Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts, runIndex: Uint32Array.from(runIndex), runOriginalID: Uint32Array.from(runOriginalID) });
  m.merge();
  const man = new Manifold(m);
  const status = man.status();
  if (status !== 'NoError') throw new Error(`mesh is not manifold: ${status}`);
  return man;
}

/**
 * Reads a manifold back with one material index per triangle, from the run
 * originalIDs set by toManifoldTagged. Faces from other sources (cutters,
 * other inputs) get `fallback`.
 */
export function fromManifoldTagged(man: ManifoldT, firstID: number, materialCount: number, fallback = 0): { mesh: IndexedMesh; faceMaterial: Uint8Array } {
  const m: MeshT = man.getMesh();
  const mesh = fromManifold(man);
  const faceMaterial = new Uint8Array(m.numTri).fill(fallback);
  for (let r = 0; r < m.runOriginalID.length; r++) {
    const mat = m.runOriginalID[r] - firstID;
    if (mat < 0 || mat >= materialCount) continue;
    const end = r + 1 < m.runIndex.length ? m.runIndex[r + 1] : m.triVerts.length;
    for (let t = m.runIndex[r] / 3; t < end / 3; t++) faceMaterial[t] = mat;
  }
  return { mesh, faceMaterial };
}

/**
 * Puts decomposed bodies back into one solid. Bodies of negative volume are
 * sealed pockets (Manifold hands them out inside out); a plain union would
 * swallow them, so they are turned right side out and subtracted instead.
 */
export async function rejoin(bodies: ManifoldT[]): Promise<ManifoldT> {
  const { Manifold } = await manifold();
  const solids = bodies.filter((b) => b.volume() > 0);
  const voids = bodies.filter((b) => b.volume() < 0);
  let out = solids.length === 1 ? solids[0] : Manifold.union(solids);
  if (voids.length) {
    const flipped: ManifoldT[] = [];
    for (const v of voids) {
      const m = fromManifold(v);
      const tri = Uint32Array.from(m.triangles);
      for (let i = 0; i < tri.length; i += 3) { const t = tri[i + 1]; tri[i + 1] = tri[i + 2]; tri[i + 2] = t; }
      flipped.push(await toManifold({ positions: m.positions, triangles: tri }));
    }
    out = out.subtract(flipped.length === 1 ? flipped[0] : Manifold.union(flipped));
  }
  return out;
}

export function fromManifold(man: ManifoldT): IndexedMesh {
  const m: MeshT = man.getMesh();
  const positions = new Float32Array(m.numVert * 3);
  for (let v = 0; v < m.numVert; v++) {
    positions[v * 3] = m.vertProperties[v * m.numProp];
    positions[v * 3 + 1] = m.vertProperties[v * m.numProp + 1];
    positions[v * 3 + 2] = m.vertProperties[v * m.numProp + 2];
  }
  return { positions, triangles: Uint32Array.from(m.triVerts) };
}

/** Column-major 4x4 that maps local +Z onto `axis` with the origin at `origin`. */
export function frameAt(origin: V3, axis: V3, spinDeg = 0): number[] {
  const a = normalize(axis);
  const helper: V3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u = normalize(cross(helper, a));
  let v = cross(a, u);
  const s = Math.sin((spinDeg * Math.PI) / 180), c = Math.cos((spinDeg * Math.PI) / 180);
  const u2: V3 = [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s];
  const v2: V3 = [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s];
  u = u2; v = v2;
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, a[0], a[1], a[2], 0, origin[0], origin[1], origin[2], 1];
}

/**
 * The frame an accessory stands in at a magnet point (column-major 4x4): its
 * base on the void mouth, sunk `sink` mm along the way it stands, spun about
 * the magnet axis; with `up`, turned by the smallest rotation that stands it
 * along `up` instead. The tilt and slide come on top (see placementMatrix).
 */
export function standFrame(pt: { center: V3; axis: V3 }, sink: number, spin: number, up?: V3): number[] {
  const along = up ? normalize(up) : normalize(pt.axis);
  const f = frameAt(add(pt.center, scale(along, -sink)), pt.axis, spin);
  if (!up) return f;
  const a = normalize(pt.axis);
  const k = cross(a, along), s = Math.hypot(k[0], k[1], k[2]), c = dot(a, along);
  if (s < 1e-9) return f;
  const n = scale(k, 1 / s);
  // Rodrigues: v cos θ + (n × v) sin θ + n (n · v)(1 − cos θ)
  const turn = (v: V3): V3 => { const nv = cross(n, v), d = dot(n, v) * (1 - c); return [v[0] * c + nv[0] * s + n[0] * d, v[1] * c + nv[1] * s + n[1] * d, v[2] * c + nv[2] * s + n[2] * d]; };
  const u = turn([f[0], f[1], f[2]]), v = turn([f[4], f[5], f[6]]), w = turn([f[8], f[9], f[10]]);
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, w[0], w[1], w[2], 0, f[12], f[13], f[14], 1];
}

/** The whole placement as one column-major 4x4, accessory's own frame → world: standFrame · tilt (x, then y) · slide. */
export function placementMatrix(pt: { center: V3; axis: V3 }, pl: Omit<Placement, 'point'>): number[] {
  const m = standFrame(pt, pl.sink, pl.spin, pl.up);
  const [tx, ty] = (pl.tilt ?? [0, 0]).map((d) => (d * Math.PI) / 180);
  const rx = [1, 0, 0, 0, 0, Math.cos(tx), Math.sin(tx), 0, 0, -Math.sin(tx), Math.cos(tx), 0, 0, 0, 0, 1];
  const ry = [Math.cos(ty), 0, -Math.sin(ty), 0, 0, 1, 0, 0, Math.sin(ty), 0, Math.cos(ty), 0, 0, 0, 0, 1];
  const slide = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, pl.offset[0], pl.offset[1], 0, 1];
  return mul4(mul4(mul4(m, ry), rx), slide);
}

function mul4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

/**
 * Which way the surface around a magnet point faces: rays come in along the
 * magnet axis on two rings just outside the void's mouth (`ring` and twice
 * `ring` mm past its rim), a plane is fitted through where they land, and
 * its normal is returned, on the axis's side. Null when too few rays land.
 * The rings stay close so they read the local tilt, not the curve of the
 * head round them (on the goose's head, rings past about 8 mm from the
 * centre start to land on its sides and swing the answer). For standing an
 * accessory along the head's own tilt rather than straight along the magnet.
 */
export function surfaceUp(mesh: IndexedMesh, pt: { center: V3; axis: V3; diameter: number }, ring = 1.2): { up: V3; tiltDeg: number } | null {
  const a = normalize(pt.axis);
  const helper: V3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(helper, a)), v = cross(a, u);
  const P = mesh.positions, T = mesh.triangles;
  const rings = [pt.diameter / 2 + ring, pt.diameter / 2 + 2 * ring];
  const height = 40;
  // only triangles whose box, in the magnet's frame, reaches the rays
  const reach = rings[1] + 0.5;
  const near: number[] = [];
  for (let t = 0; t < T.length / 3; t++) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      const i = T[t * 3 + k] * 3;
      const d: V3 = [P[i] - pt.center[0], P[i + 1] - pt.center[1], P[i + 2] - pt.center[2]];
      const q = [dot(d, u), dot(d, v), dot(d, a)];
      for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], q[j]); hi[j] = Math.max(hi[j], q[j]); }
    }
    if (lo[0] < reach && hi[0] > -reach && lo[1] < reach && hi[1] > -reach && lo[2] < height && hi[2] > -height) near.push(t);
  }
  const hits: [number, number, number][] = []; // (x, y, height) in the magnet's own frame
  for (const r of rings) for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2;
    const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
    const o: V3 = [pt.center[0] + u[0] * x + v[0] * y + a[0] * height, pt.center[1] + u[1] * x + v[1] * y + a[1] * height, pt.center[2] + u[2] * x + v[2] * y + a[2] * height];
    let best = Infinity;
    for (const t of near) {
      const hit = rayTriangle(o, scale(a, -1), P, T[t * 3], T[t * 3 + 1], T[t * 3 + 2]);
      if (hit !== null && hit < best) best = hit;
    }
    if (best < Infinity) hits.push([x, y, height - best]);
  }
  if (hits.length < 12) return null;
  // least squares h = p x + q y + c
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sh = 0, sxh = 0, syh = 0;
  for (const [x, y, h] of hits) { sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sh += h; sxh += x * h; syh += y * h; }
  const n = hits.length;
  // solve [[sxx sxy sx][sxy syy sy][sx sy n]] [p q c] = [sxh syh sh]
  const M = [[sxx, sxy, sx, sxh], [sxy, syy, sy, syh], [sx, sy, n, sh]];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c]; }
  }
  const p = M[0][3] / M[0][0], q = M[1][3] / M[1][1];
  const up = normalize([a[0] - p * u[0] - q * v[0], a[1] - p * u[1] - q * v[1], a[2] - p * u[2] - q * v[2]]);
  return { up, tiltDeg: (Math.acos(Math.min(1, dot(up, a))) * 180) / Math.PI };
}

/** Distance along a ray (unit `dir`) to a triangle, or null (Möller–Trumbore, both sides). */
function rayTriangle(o: V3, dir: V3, P: Float32Array, i0: number, i1: number, i2: number): number | null {
  const ax = P[i0 * 3], ay = P[i0 * 3 + 1], az = P[i0 * 3 + 2];
  const e1: V3 = [P[i1 * 3] - ax, P[i1 * 3 + 1] - ay, P[i1 * 3 + 2] - az], e2: V3 = [P[i2 * 3] - ax, P[i2 * 3 + 1] - ay, P[i2 * 3 + 2] - az];
  const pv = cross(dir, e2), det = dot(e1, pv);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tv: V3 = [o[0] - ax, o[1] - ay, o[2] - az];
  const bu = dot(tv, pv) * inv;
  if (bu < 0 || bu > 1) return null;
  const qv = cross(tv, e1), bv = dot(dir, qv) * inv;
  if (bv < 0 || bu + bv > 1) return null;
  const t = dot(e2, qv) * inv;
  return t > 0 ? t : null;
}

/** The spin, degrees, that turns the accessory's local direction `local` (in its base plane) to point along the world direction `world` at a point with this axis. */
export function spinToward(axis: V3, local: [number, number], world: V3): number {
  const f = frameAt([0, 0, 0], axis, 0);
  const u: V3 = [f[0], f[1], f[2]], v: V3 = [f[4], f[5], f[6]];
  // spinning by t maps local (x, y) to x·R(t)u + y·R(t)v; the angle of `world` in the (u, v) plane less the angle of `local`
  const want = Math.atan2(dot(world, v), dot(world, u));
  const have = Math.atan2(local[1], local[0]);
  let deg = ((want - have) * 180) / Math.PI;
  while (deg > 180) deg -= 360;
  while (deg < -180) deg += 360;
  return deg;
}

/**
 * Fit `accessory` (local frame: base centred on the origin, +Z up, so -Z is
 * the side that meets the goose) onto the goose at a magnet point.
 */
export async function fitAccessory(
  goose: ManifoldT,
  accessory: ManifoldT,
  profile: FitProfile,
  placement: Placement,
): Promise<FitResult> {
  const { Manifold } = await manifold();
  const pt = profile.points[placement.point];
  if (!pt) throw new Error(`unknown magnet point "${placement.point}"; have ${Object.keys(profile.points).join(', ')}`);
  const warnings: string[] = [];

  // 1. place the accessory: base at the void mouth, sunk into the goose
  const [tx, ty] = placement.tilt ?? [0, 0];
  let placed = accessory.translate(placement.offset[0], placement.offset[1], 0);
  if (tx || ty) placed = placed.rotate([tx, ty, 0]);
  placed = placed.transform(standFrame(pt, placement.sink, placement.spin, placement.up) as any);
  const volumeBefore = placed.volume();

  // 2. crop the goose to the accessory's neighbourhood, then grow it by the clearance
  const bb = placed.boundingBox();
  const pad = profile.clearance * 2 + 1;
  const size: V3 = [bb.max[0] - bb.min[0] + 2 * pad, bb.max[1] - bb.min[1] + 2 * pad, bb.max[2] - bb.min[2] + 2 * pad];
  const cropBox = Manifold.cube(size, false).translate(bb.min[0] - pad, bb.min[1] - pad, bb.min[2] - pad);
  // the goose's own magnet voids and slots are filled first, so the accessory
  // is carved against the surface rather than growing plugs down into them
  const fillers = [...Object.values(profile.points), ...(profile.slots ?? [])]
    .map((p) => pocketSolid(Manifold, p, p.diameter / 2 + 0.05, p.size?.map((s) => s + 0.1) as [number, number] | undefined, 0, p.depth + 0.05, 0));
  const nearby = Manifold.union([goose, ...fillers]).intersect(cropBox);
  const grown = offsetApprox(Manifold, nearby, profile.clearance);

  // 3. carve the goose out of the accessory
  let fitted = placed.subtract(grown);

  // 4. magnet pocket, mirroring the goose void, opening on the mating face
  const spec = placement.pocket ?? {};
  const depth = (spec.thickness ?? profile.magnetThickness ?? pt.depth) + (spec.axialClearance ?? profile.pocketAxialClearance);
  const radius = (spec.diameter ?? pt.diameter) / 2 + (spec.radialClearance ?? profile.pocketRadialClearance);
  // the pocket is measured from the accessory's mating face, which sits one
  // clearance above the goose void mouth; it also reaches back through any
  // material below that face so the opening is always clear
  const reach = placement.sink + profile.clearance + 1;
  const boxSize = spec.diameter === undefined && pt.shape === 'box' && pt.size
    ? pt.size.map((s) => s + 2 * (spec.radialClearance ?? profile.pocketRadialClearance)) as [number, number]
    : undefined;
  if (!spec.none) {
    let pocket = pocketSolid(Manifold, pt, radius, boxSize, depth, reach, profile.clearance);
    if (spec.ribs && spec.ribs > 0) {
      // ribs stay behind when the pocket is cut: round ridges on the wall, led in from the mouth, whose tips sit
      // `ribCrush` inside the magnet so they squash as it goes in
      const clearance = spec.radialClearance ?? profile.pocketRadialClearance;
      const crush = spec.ribCrush ?? 0.15;
      const ribs = crushRibs(Manifold, pt, radius, boxSize, depth, clearance + crush, spec.ribs, profile.clearance);
      if (ribs) pocket = pocket.subtract(ribs);
    }
    fitted = fitted.subtract(pocket);
  }

  // 5. drop slivers (under 1 mm³, from the offset approximation), then check; a sealed pocket inside the accessory
  // (a filled hat crown) is a body of negative volume and stays
  const parts = fitted.decompose();
  const kept = parts.filter((p) => Math.abs(p.volume()) >= 1);
  if (kept.length < parts.length) fitted = kept.length ? await rejoin(kept) : fitted;
  const bodies = kept.filter((p) => p.volume() > 0).length;
  if (bodies === 0) warnings.push('nothing left after the cut: the accessory sits entirely inside the goose');
  if (bodies > 1) warnings.push(`result is ${bodies} separate bodies; the cut split the accessory`);
  const volumeAfter = fitted.volume();
  if (volumeAfter < volumeBefore * 0.2) warnings.push('more than 80% of the accessory was carved away');
  // crude floor-thickness check: is there material just beyond the pocket floor?
  const probe = Manifold.cylinder(0.8, radius * 0.8, radius * 0.8, 32, false)
    .translate(0, 0, depth)
    .transform(frameAt(add(pt.center, scale(pt.axis, profile.clearance)), pt.axis) as any);
  const floor = fitted.intersect(probe).volume();
  if (!spec.none && floor < probe.volume() * 0.9) warnings.push('pocket floor thinner than 0.8 mm; sink less or thicken the base');

  return { mesh: fromManifold(fitted), solid: fitted, volumeBefore, volumeAfter, bodies, warnings };
}

/**
 * A pocket-shaped solid on a magnet point: a cylinder of `radius`, or a box of
 * `boxSize` when given (aligned to the point's side axis). It starts `lift`
 * above the point along the axis, reaches `reach` back below it and `depth`
 * forward from there, so it both clears the opening and cuts the pocket.
 */
function pocketSolid(
  Manifold: ManifoldToplevel['Manifold'],
  pt: MagnetVoid,
  radius: number,
  boxSize: [number, number] | undefined,
  depth: number,
  reach: number,
  lift: number,
): ManifoldT {
  const origin = add(pt.center, scale(pt.axis, lift));
  const body = boxSize
    ? Manifold.cube([boxSize[0], boxSize[1], depth + reach], true).translate(0, 0, (depth + reach) / 2 - reach)
    : Manifold.cylinder(depth + reach, radius, radius, 64, false).translate(0, 0, -reach);
  const frame = pt.sideAxis ? frameFromAxes(origin, pt.sideAxis, pt.axis) : frameAt(origin, pt.axis);
  return body.transform(frame as any);
}

/**
 * Crush ribs for a pocket: `count` round ridges of radius `rr` centred on the
 * pocket wall (spread round a cylinder, or along the sides of a box), running
 * from the mouth to the floor, tapered to nothing over the first millimetre
 * so the magnet finds its way in.
 */
function crushRibs(
  Manifold: ManifoldToplevel['Manifold'],
  pt: MagnetVoid,
  radius: number,
  boxSize: [number, number] | undefined,
  depth: number,
  rr: number,
  count: number,
  lift: number,
): ManifoldT | null {
  if (rr <= 0 || depth <= 0) return null;
  const lead = Math.min(1, depth / 2);
  const rib = Manifold.cylinder(lead, 0.01, rr, 24, false).add(Manifold.cylinder(depth - lead + 0.2, rr, rr, 24, false).translate(0, 0, lead));
  const placed: ManifoldT[] = [];
  if (boxSize) {
    const perSide = Math.max(1, Math.round(count / 4));
    for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const along = sx ? boxSize[1] : boxSize[0];
      for (let i = 0; i < perSide; i++) {
        const t = ((i + 1) / (perSide + 1) - 0.5) * along;
        placed.push(rib.translate(sx ? sx * boxSize[0] / 2 : t, sy ? sy * boxSize[1] / 2 : t, 0));
      }
    }
  } else {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      placed.push(rib.translate(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
  }
  const origin = add(pt.center, scale(pt.axis, lift));
  const frame = pt.sideAxis ? frameFromAxes(origin, pt.sideAxis, pt.axis) : frameAt(origin, pt.axis);
  return Manifold.union(placed).transform(frame as any);
}

/** Column-major 4x4 with local +X along `x` (made perpendicular to `z`) and +Z along `z`. */
export function frameFromAxes(origin: V3, x: V3, z: V3): number[] {
  const a = normalize(z);
  const xp = sub(x, scale(a, dot(x, a)));
  const u = normalize(norm(xp) < 1e-6 ? cross([0, 0, 1], a) : xp);
  const v = cross(a, u);
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, a[0], a[1], a[2], 0, origin[0], origin[1], origin[2], 1];
}

/**
 * Approximate outward offset: union of the body shifted along 14 directions.
 * Good to within ~15% of `d` on smooth surfaces; to be replaced by an SDF
 * level set once the BVH is in (see docs/PLAN.md, risk "Clearance offset").
 */
function offsetApprox(Manifold: ManifoldToplevel['Manifold'], body: ManifoldT, d: number): ManifoldT {
  if (d <= 0) return body;
  const dirs: V3[] = [];
  for (const s of [-1, 1]) dirs.push([s * d, 0, 0], [0, s * d, 0], [0, 0, s * d]);
  const k = d / Math.sqrt(3);
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) dirs.push([x * k, y * k, z * k]);
  return Manifold.union([body, ...dirs.map((v) => body.translate(v))]);
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

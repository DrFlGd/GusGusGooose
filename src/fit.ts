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
  /** slide of the accessory base in its own XY, mm */
  offset: [number, number];
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
}

export interface FitResult {
  mesh: IndexedMesh;
  volumeBefore: number;
  volumeAfter: number;
  bodies: number;
  warnings: string[];
}

let wasm: ManifoldToplevel | null = null;
export async function manifold(): Promise<ManifoldToplevel> {
  if (!wasm) {
    wasm = await Module();
    wasm.setup();
  }
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
  const origin = add(pt.center, scale(pt.axis, -placement.sink));
  const placed = accessory
    .translate(placement.offset[0], placement.offset[1], 0)
    .transform(frameAt(origin, pt.axis, placement.spin) as any);
  const volumeBefore = placed.volume();

  // 2. crop the goose to the accessory's neighbourhood, then grow it by the clearance
  const bb = placed.boundingBox();
  const pad = profile.clearance * 2 + 1;
  const size: V3 = [bb.max[0] - bb.min[0] + 2 * pad, bb.max[1] - bb.min[1] + 2 * pad, bb.max[2] - bb.min[2] + 2 * pad];
  const cropBox = Manifold.cube(size, false).translate(bb.min[0] - pad, bb.min[1] - pad, bb.min[2] - pad);
  const nearby = goose.intersect(cropBox);
  const grown = offsetApprox(Manifold, nearby, profile.clearance);

  // 3. carve the goose out of the accessory
  let fitted = placed.subtract(grown);

  // 4. magnet pocket, mirroring the goose void, opening on the mating face
  const spec = placement.pocket ?? {};
  const depth = (spec.thickness ?? profile.magnetThickness ?? pt.depth) + (spec.axialClearance ?? profile.pocketAxialClearance);
  const radius = (spec.diameter ?? pt.diameter) / 2 + (spec.radialClearance ?? profile.pocketRadialClearance);
  const reach = placement.sink + profile.clearance + 1; // start well inside the goose side
  if (!spec.none) {
    const pocket = Manifold.cylinder(depth + reach, radius, radius, 64, false)
      .translate(0, 0, -reach)
      .transform(frameAt(pt.center, pt.axis) as any);
    fitted = fitted.subtract(pocket);
  }

  // 5. checks
  const parts = fitted.decompose();
  const bodies = parts.length;
  if (bodies === 0) warnings.push('nothing left after the cut: the accessory sits entirely inside the goose');
  if (bodies > 1) warnings.push(`result is ${bodies} separate bodies; the cut split the accessory`);
  const volumeAfter = fitted.volume();
  if (volumeAfter < volumeBefore * 0.2) warnings.push('more than 80% of the accessory was carved away');
  // crude floor-thickness check: is there material just beyond the pocket floor?
  const probe = Manifold.cylinder(0.8, radius * 0.8, radius * 0.8, 32, false)
    .translate(0, 0, depth)
    .transform(frameAt(pt.center, pt.axis) as any);
  const floor = fitted.intersect(probe).volume();
  if (!spec.none && floor < probe.volume() * 0.9) warnings.push('pocket floor thinner than 0.8 mm; sink less or thicken the base');

  return { mesh: fromManifold(fitted), volumeBefore, volumeAfter, bodies, warnings };
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
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Magnet-hole tool, headless half: snap a picked point to the model surface,
// cut a magnet pocket there, either open (press-fit, opens to the surface)
// or embedded (sealed cavity under a skin; the print is paused to drop the
// magnet in). Returns the point as a fit-profile entry so accessories can
// be fitted to it.

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import type { MagnetVoid } from './voids.ts';
import { frameAt, manifold, type V3 } from './fit.ts';

export interface HoleSpec {
  /** picked point, anywhere near the surface; it is snapped to the closest surface point */
  point: V3;
  /** override the surface normal as the hole axis (unit vector pointing out of the model) */
  axis?: V3;
  /** magnet diameter and thickness, mm */
  diameter: number;
  thickness: number;
  /** extra radius and depth, mm */
  radialClearance?: number;
  axialClearance?: number;
  mode: 'open' | 'embedded';
  /** embedded only: material left between the surface and the cavity, mm */
  skin?: number;
}

export interface HoleResult {
  model: ManifoldT;
  /** the magnet point, usable in a FitProfile */
  point: MagnetVoid & { mode: 'open' | 'embedded' };
  /** embedded only: Z height (model units, print orientation = +Z up) to pause the print at */
  pauseZ?: number;
}

export async function addMagnetHole(model: ManifoldT, mesh: IndexedMesh, spec: HoleSpec): Promise<HoleResult> {
  const { Manifold } = await manifold();
  const snap = closestSurfacePoint(mesh, spec.point);
  const axis = normalize(spec.axis ?? snap.normal);
  const radius = spec.diameter / 2 + (spec.radialClearance ?? 0);
  const depth = spec.thickness + (spec.axialClearance ?? 0.1);
  const skin = spec.mode === 'embedded' ? (spec.skin ?? 1.0) : 0;

  // cavity runs from `mouth` down the inward axis by `depth`; for an open
  // hole the mouth is at the surface, with 1 mm of overshoot outward so the
  // cut is clean, and for an embedded one it sits `skin` below the surface
  const mouth = add(snap.point, scale(axis, -skin));
  const overshoot = spec.mode === 'open' ? 1 : 0;
  const cutter = Manifold.cylinder(depth + overshoot, radius, radius, 64, false)
    .translate(0, 0, -depth)
    .transform(frameAt(mouth, axis) as any);
  const cut = model.subtract(cutter);

  const point: HoleResult['point'] = {
    center: mouth,
    floor: add(mouth, scale(axis, -depth)),
    axis,
    diameter: radius * 2,
    depth,
    wallFaces: 0,
    mode: spec.mode,
  };
  const result: HoleResult = { model: cut, point };
  if (spec.mode === 'embedded') {
    // pause when the printer reaches the top of the cavity: the highest Z any
    // point of the cavity cylinder reaches
    const bb = cutter.boundingBox();
    result.pauseZ = bb.max[2];
  }
  return result;
}

/** Closest point on the mesh to `p`, with the outward normal of that triangle. */
export function closestSurfacePoint(mesh: IndexedMesh, p: V3): { point: V3; normal: V3; distance: number } {
  const { positions: P, triangles: T } = mesh;
  let best = Infinity, bestPt: V3 = p, bestN: V3 = [0, 0, 1];
  for (let i = 0; i < T.length; i += 3) {
    const a = vert(P, T[i]), b = vert(P, T[i + 1]), c = vert(P, T[i + 2]);
    const q = closestPointOnTriangle(p, a, b, c);
    const d = dist2(p, q);
    if (d < best) {
      best = d; bestPt = q;
      bestN = normalize(cross(sub(b, a), sub(c, a)));
    }
  }
  return { point: bestPt, normal: bestN, distance: Math.sqrt(best) };
}

// Ericson, Real-Time Collision Detection, 5.1.5
function closestPointOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return add(a, add(scale(ab, v), scale(ac, w)));
}

const vert = (P: Float32Array, i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

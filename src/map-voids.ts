// Maps the magnet voids from one 3MF (negative parts around the bare white
// body) onto another 3MF of the same goose (the full-colour assembly), by
// matching a part both files share and carrying the negatives across in
// that part's frame. Also turns each negative primitive into a magnet point.

import { applyXf, compose, invert, transformMesh, type Part, type Xf } from './threemf.ts';
import type { IndexedMesh } from './stl.ts';
import type { MagnetVoid } from './voids.ts';
import { closestSurfacePoint } from './hole.ts';

type V3 = [number, number, number];

export interface VoidPrimitive {
  name: string;
  /** which shared part it was defined around */
  anchor: string;
  kind: 'cylinder' | 'box' | 'pin';
  center: V3;
  /** world-space local axes (rows of the transform), unit length */
  axes: [V3, V3, V3];
  /** world-space extents along those axes, mm */
  size: V3;
  mesh: IndexedMesh;
}

/** Negatives of `voidsFile`, re-expressed in `full`'s world space. */
export function mapNegatives(full: Part[], voidsFile: Part[]): VoidPrimitive[] {
  const out: VoidPrimitive[] = [];
  const groups = new Map<string, Part[]>();
  for (const p of voidsFile) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
  for (const parts of groups.values()) {
    const negatives = parts.filter((p) => p.kind === 'negative');
    if (!negatives.length) continue;
    const anchor2 = parts.find((p) => p.kind === 'normal' && full.some((q) => q.kind === 'normal' && q.name === p.name));
    if (!anchor2) throw new Error(`no part shared with the full model in group ${parts[0].group} (${parts.map((p) => p.name).join(', ')})`);
    const anchor1 = full.find((q) => q.kind === 'normal' && q.name === anchor2.name)!;
    const M = compose(invert(anchor2.transform), anchor1.transform);
    for (const n of negatives) {
      const xf = compose(n.transform, M);
      out.push({ ...primitive(n, xf), anchor: anchor1.name, mesh: transformMesh(n.local, xf) });
    }
  }
  return out;
}

function primitive(n: Part, xf: Xf): Omit<VoidPrimitive, 'anchor' | 'mesh'> {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const P = n.local.positions;
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
  const localCenter: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const rows: V3[] = [[xf[0], xf[1], xf[2]], [xf[3], xf[4], xf[5]], [xf[6], xf[7], xf[8]]];
  const scale = rows.map((r) => Math.hypot(...r));
  const axes = rows.map((r, k) => r.map((v) => v / scale[k]) as V3) as [V3, V3, V3];
  const size = [0, 1, 2].map((k) => (hi[k] - lo[k]) * scale[k]) as V3;
  const isBox = n.local.positions.length / 3 === 8;
  let kind: VoidPrimitive['kind'] = isBox ? 'box' : 'cylinder';
  if (!isBox && size[2] / Math.max(size[0], size[1]) > 3) kind = 'pin';
  return { name: n.name, kind, center: applyXf(xf, localCenter), axes, size };
}

/**
 * Magnet points for the fit profile. `goose` must be the solid without the
 * voids cut, so the nearest surface is the outside, not a cavity wall. Pins
 * are skipped, and a box that overlaps a cylinder is taken as that magnet's
 * insertion slot rather than a magnet of its own.
 */
export function primitivesToPoints(prims: VoidPrimitive[], goose: IndexedMesh): { points: Record<string, MagnetVoid>; slots: MagnetVoid[] } {
  const points: Record<string, MagnetVoid> = {};
  const slots: MagnetVoid[] = [];
  const used = new Set<string>();
  for (const p of prims) {
    if (p.kind === 'pin') continue;
    const isSlot = p.kind === 'box' && prims.some((q) => q !== p && q.kind === 'cylinder' && q.anchor === p.anchor && dist(q.center, p.center) < 8);
    // the magnet axis: a cylinder's local z, a box's thinnest direction
    let k = 2;
    if (p.kind === 'box') k = p.size.indexOf(Math.min(...p.size));
    let axis = p.axes[k];
    const thickness = p.size[k];
    // point the axis toward the nearest goose surface, which is where the
    // accessory sits; the void's outer face centre projects there
    const near = closestSurfacePoint(goose, p.center);
    const toSurface = sub(near.point, p.center);
    if (dot(toSurface, axis) < 0) axis = neg(axis);
    const sides = [0, 1, 2].filter((i) => i !== k);
    const size: [number, number] = [p.size[sides[0]], p.size[sides[1]]];
    const face = add(p.center, scale(axis, thickness / 2));
    if (isSlot) {
      // an insertion slot beside a magnet seat: not a magnet point, but the
      // fit must treat it as solid so no accessory material grows into it
      slots.push({ center: face, floor: add(p.center, scale(axis, -thickness / 2)), axis, diameter: Math.max(...size), depth: thickness, shape: 'box', size, sideAxis: p.axes[sides[0]], mode: 'open', wallFaces: 0 });
      continue;
    }
    const name = suggestName(p, axis, used);
    used.add(name);
    const surface = closestSurfacePoint(goose, face);
    const skin = Math.max(0, dot(sub(surface.point, face), axis));
    // keep the accessory axis through the face centre: slide along the axis up to the surface
    const mouth = add(face, scale(axis, skin));
    points[name] = {
      center: mouth,
      floor: add(p.center, scale(axis, -thickness / 2)),
      axis,
      mode: skin > 0.2 ? 'embedded' : 'open',
      faceCenter: face,
      skin,
      diameter: p.kind === 'box' ? Math.max(...size) : p.size[0],
      depth: thickness,
      shape: p.kind === 'box' ? 'box' : 'cylinder',
      size: p.kind === 'box' ? size : undefined,
      sideAxis: p.kind === 'box' ? p.axes[sides[0]] : undefined,
      wallFaces: 0,
    };
  }
  return { points, slots };
}

/** Goose faces -y with +z up, so its left wing is on +x. */
function suggestName(p: VoidPrimitive, axis: V3, used: Set<string>): string {
  let name: string;
  if (/nose|beak/i.test(p.anchor)) name = 'beak';
  else if (axis[2] > 0.7) name = 'head';
  else if (Math.abs(axis[0]) > 0.5) name = axis[0] > 0 ? 'left_wing' : 'right_wing';
  else name = p.kind;
  let candidate = name, i = 2;
  while (used.has(candidate)) candidate = `${name}_${i++}`;
  return candidate;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

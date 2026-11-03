// Turns a downloaded model into an accessory in the fitting frame: the side
// that meets the goose faces -Z, the model is scaled to the goose, centred on
// the origin with its base at z = 0, and optionally given solid material
// underneath so a hollow model has something to carve and to hold the
// magnet: a plain plug cylinder, or a fill of the cavity above the base
// (a hat's crown) that follows the walls and stops short of the top.

import type { CrossSection as CrossSectionT, Manifold as ManifoldT } from 'manifold-3d';
import { manifold, rejoin } from './fit.ts';

export type Side = '-z' | '+z' | '-x' | '+x' | '-y' | '+y';

export interface PrepareOptions {
  /** which side of the model, as downloaded, should meet the goose */
  down: Side;
  /** uniform scale factor, applied after orientation (1 = as downloaded; 25.4 = inches to mm) */
  scale: number;
  /** if set, scale is chosen so the larger footprint dimension equals this width in mm (overrides `scale`) */
  width?: number;
  /** solid cylinder unioned from the base upward, for hollow models */
  plug?: { diameter: number; height: number };
  /**
   * fill the hollow underside this deep, mm: the lowest cavity enclosed by
   * the model's walls above the magnet axis is filled from its floor up,
   * following the walls, never through the top; the model is then lowered
   * so the fill's floor is the base (a hat's brim may hang below it)
   */
  fill?: number;
  /** centre on the footprint of the lowest `footprintDepth` mm instead of the whole bounding box */
  centre: 'bbox' | 'footprint';
}

export const DEFAULT_PREPARE: PrepareOptions = { down: '-z', scale: 1, centre: 'bbox' };

/** Rotation (degrees about x, y, z, applied in that order by Manifold) that brings `side` to -Z. */
export const SIDE_ROTATION: Record<Side, [number, number, number]> = {
  '-z': [0, 0, 0],
  '+z': [180, 0, 0],
  '-x': [0, -90, 0],
  '+x': [0, 90, 0],
  '-y': [90, 0, 0],
  '+y': [-90, 0, 0],
};

export interface Prepared {
  solid: ManifoldT;
  scale: number;
  /** size after preparation, mm: x, y, z */
  size: [number, number, number];
  /** what the fill did: how far above the model's lowest point its floor is, its depth and volume; absent when none was asked for or none fitted */
  fill?: { floor: number; depth: number; volume: number };
  warnings: string[];
}

export async function prepareAccessory(raw: ManifoldT, opts: PrepareOptions): Promise<Prepared> {
  const { Manifold } = await manifold();
  let m = raw.rotate(SIDE_ROTATION[opts.down]);
  let bb = m.boundingBox();
  let scale = opts.scale;
  if (opts.width) {
    const footprint = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
    scale = footprint > 0 ? opts.width / footprint : 1;
  }
  if (scale !== 1) { m = m.scale(scale); bb = m.boundingBox(); }
  let cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
  if (opts.centre === 'footprint') {
    // centre of the bounding box of the lowest 2 mm, where the model meets the goose
    const slab = m.intersect(Manifold.cube([bb.max[0] - bb.min[0] + 2, bb.max[1] - bb.min[1] + 2, 2], false).translate(bb.min[0] - 1, bb.min[1] - 1, bb.min[2]));
    const sb = slab.boundingBox();
    if (sb.max[0] > sb.min[0]) { cx = (sb.min[0] + sb.max[0]) / 2; cy = (sb.min[1] + sb.max[1]) / 2; }
  }
  m = m.translate(-cx, -cy, -bb.min[2]);
  const warnings: string[] = [];
  let fill: Prepared['fill'];
  if (opts.fill && opts.fill > 0) {
    const f = await fillCavity(m, opts.fill);
    if (f) {
      m = f.solid;
      fill = { floor: f.floor, depth: f.depth, volume: f.volume };
      if (f.depth < opts.fill - 0.01) warnings.push(`the cavity is only ${f.depth.toFixed(1)} mm tall above its floor, so the fill stops there`);
    } else {
      warnings.push('no hollow found above the magnet axis to fill');
    }
  }
  if (opts.plug && opts.plug.diameter > 0 && opts.plug.height > 0) {
    m = m.add(Manifold.cylinder(opts.plug.height, opts.plug.diameter / 2, opts.plug.diameter / 2, 96, false));
  }
  bb = m.boundingBox();
  return { solid: m, scale, size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]], fill, warnings };
}

/**
 * Fills the cavity that the model's walls enclose around the magnet axis
 * (x = y = 0), from the cavity's floor up to `depth` mm, following the walls
 * and stopping under the top. The model is sliced upward from its base; at
 * each height the innermost loop around the axis says whether the axis is in
 * an enclosed void (a hole), in material, or in open air. The floor is the
 * lowest height whose void is still there, about as wide, part way up (the
 * depth, or half way to the ceiling): the space under a brim whose rim dips
 * below the crown opening fails that test, since higher up only the crown's
 * much smaller hole is left. The ceiling is the first material on the axis
 * above the base. The fill is the hole, extruded over the depth, cut back to
 * the walls. Returns the model lowered so the floor is at z = 0 with the fill
 * added, or null when there is no cavity.
 */
export async function fillCavity(m: ManifoldT, depth: number): Promise<{ solid: ManifoldT; floor: number; depth: number; volume: number } | null> {
  const { Manifold, CrossSection } = await manifold();
  const bb = m.boundingBox();
  const height = bb.max[2] - bb.min[2];
  const dz = Math.min(1, Math.max(0.2, height / 80));
  /** the innermost loop around the axis at height z, when it is a hole (void at the axis), with its area */
  const holeAt = (z: number): { poly: [number, number][]; area: number } | null => {
    const polys = m.slice(z).toPolygons() as [number, number][][];
    let best: [number, number][] | null = null, bestArea = Infinity;
    for (const poly of polys) {
      if (!containsOrigin(poly)) continue;
      const a = Math.abs(signedArea(poly));
      if (a < bestArea) { bestArea = a; best = poly; }
    }
    // Manifold winds outer contours counter-clockwise and holes clockwise
    return best && signedArea(best) < 0 ? { poly: best, area: bestArea } : null;
  };
  // the ceiling: the first material on the axis above the base
  const pillar = Manifold.cylinder(height + 2, 0.3, 0.3, 8, false).translate(0, 0, bb.min[2] - 1);
  const onAxis = m.intersect(pillar).decompose().map((b) => b.boundingBox().min[2]).filter((z) => z > bb.min[2] + 1e-6);
  const ceiling = onAxis.length ? Math.min(...onAxis) : bb.max[2];
  let floor = -Infinity;
  for (let z = bb.min[2] + dz / 2; z < ceiling - dz; z += dz) {
    const here = holeAt(z);
    if (!here) continue;
    const up = holeAt(Math.min(z + depth, z + (ceiling - z) / 2));
    if (up && up.area >= 0.5 * here.area) { floor = Math.max(bb.min[2], z - dz / 2); break; }
  }
  if (floor === -Infinity) return null;
  const top = Math.min(floor + depth, ceiling);
  if (top - floor < dz) return null;
  // the fill: the hole extruded over the depth, cut back to the walls; the hole at a few heights covers walls that lean
  // either way, and prisms alike in area are left out so no two near-coincident walls meet in the union
  const holes: { area: number; poly: [number, number][] }[] = [];
  for (let z = floor + dz / 2; z < top; z += dz) { const h = holeAt(z); if (h) holes.push(h); }
  holes.sort((a, b) => b.area - a.area);
  const prisms: ManifoldT[] = [];
  const areas: number[] = [];
  for (const h of holes) {
    if (areas.some((a) => Math.abs(a - h.area) < 0.05 * a)) continue;
    areas.push(h.area);
    prisms.push(new CrossSection([h.poly], 'EvenOdd').extrude(top - floor).translate(0, 0, floor));
    if (prisms.length === 4) break;
  }
  if (!prisms.length) return null;
  // what is left after the walls are cut away: keep the bodies the axis runs through, not bits that poked outside a thin wall
  const probe = Manifold.cylinder(top - floor, 0.3, 0.3, 8, false).translate(0, 0, floor);
  const bodies = Manifold.union(prisms).subtract(m).decompose().filter((b) => b.volume() > 0.01 && b.intersect(probe).volume() > 0);
  if (!bodies.length) return null;
  const fill = bodies.length === 1 ? bodies[0] : Manifold.union(bodies);
  const volume = fill.volume();
  if (volume < 1) return null;
  // the fill's faces are copies of the walls they were cut against, and that union leaves zero-volume slivers; a sealed
  // pocket above the fill comes out as a body of negative volume and is kept, since it is a real void in the print
  let joined = m.add(fill);
  const pieces = joined.decompose();
  const real = pieces.filter((b) => Math.abs(b.volume()) > 1e-6);
  if (real.length < pieces.length) joined = await rejoin(real);
  return { solid: joined.translate(0, 0, -floor), floor: floor - bb.min[2], depth: top - floor, volume };
}

function signedArea(poly: number[][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

function containsOrigin(poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

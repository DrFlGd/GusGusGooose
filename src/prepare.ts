// Turns a downloaded model into an accessory in the fitting frame: the side
// that meets the goose faces -Z, the model is scaled to the goose, centred on
// the origin with its base at z = 0, and optionally given a plug of solid
// material underneath so a hollow model has something to carve and to hold
// the magnet.

import type { Manifold as ManifoldT } from 'manifold-3d';
import { manifold } from './fit.ts';

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
  if (opts.plug && opts.plug.diameter > 0 && opts.plug.height > 0) {
    m = m.add(Manifold.cylinder(opts.plug.height, opts.plug.diameter / 2, opts.plug.diameter / 2, 96, false));
  }
  bb = m.boundingBox();
  return { solid: m, scale, size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]] };
}

// How an accessory stands at a magnet point: square to the magnet, or along
// the tilt of the surface round it (the goose's head leans about 15°).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromManifold, manifold, placementMatrix, standFrame, surfaceUp, type V3 } from '../src/fit.ts';

test('the placement matrix is the fit\'s own placement: slide, tilt x then y, then the stand frame', async () => {
  const { Manifold } = await manifold();
  const part = Manifold.cube([12, 6, 20], false).translate(-2, -1, 0); // lopsided, so any slip shows
  const pt = { center: [3, -4, 30] as V3, axis: [0.2, 0.1, 0.97] as V3 };
  const pl = { sink: 1.5, spin: 25, tilt: [10, -20] as [number, number], offset: [2, -3] as [number, number], up: [0.3, -0.2, 0.93] as V3 };
  const byFit = part.translate(pl.offset[0], pl.offset[1], 0).rotate([pl.tilt[0], pl.tilt[1], 0]).transform(standFrame(pt, pl.sink, pl.spin, pl.up) as any);
  const byMatrix = part.transform(placementMatrix(pt, pl) as any);
  const a = byFit.boundingBox(), b = byMatrix.boundingBox();
  for (let d = 0; d < 3; d++) {
    assert.ok(Math.abs(a.min[d] - b.min[d]) < 1e-6 && Math.abs(a.max[d] - b.max[d]) < 1e-6, `axis ${d}: ${a.min[d]}..${a.max[d]} vs ${b.min[d]}..${b.max[d]}`);
  }
});

test('standing along the surface: the frame stands on the surface\'s tilt, sunk along it, and spins the same way', () => {
  const pt = { center: [0, 0, 10] as V3, axis: [0, 0, 1] as V3 };
  const t = (15 * Math.PI) / 180, up: V3 = [0, -Math.sin(t), Math.cos(t)];
  const square = standFrame(pt, 2, 30);
  const leaning = standFrame(pt, 2, 30, up);
  // z column = the way it stands; origin sunk 2 mm along it
  for (let d = 0; d < 3; d++) assert.ok(Math.abs(leaning[8 + d] - up[d]) < 1e-9);
  assert.ok(Math.abs(leaning[12] - 0) < 1e-9 && Math.abs(leaning[13] - 2 * Math.sin(t)) < 1e-9 && Math.abs(leaning[14] - (10 - 2 * Math.cos(t))) < 1e-9);
  // the x column is the square one turned about the tilt's hinge (world x): its x and length are kept
  assert.ok(Math.abs(leaning[0] - square[0]) < 1e-9);
  assert.ok(Math.abs(Math.hypot(leaning[0], leaning[1], leaning[2]) - 1) < 1e-9);
  // without a tilt it is the square frame
  assert.deepEqual(standFrame(pt, 2, 30, [0, 0, 1]), square);
});

test('surfaceUp reads the tilt of a sloping surface round a magnet', async () => {
  const { Manifold } = await manifold();
  // a slab whose top leans 15° about x, with a 6 mm magnet hole straight down into it at the middle of the top
  const slab = Manifold.cube([60, 60, 10], true).rotate([15, 0, 0]);
  const top: V3 = [0, -5 * Math.sin((15 * Math.PI) / 180), 5 * Math.cos((15 * Math.PI) / 180)];
  const hole = Manifold.cylinder(6, 3, 3, 32, false).translate(top[0], top[1], top[2] - 4);
  const mesh = fromManifold(slab.subtract(hole));
  const r = surfaceUp(mesh, { center: top, axis: [0, 0, 1], diameter: 6 });
  assert.ok(r, 'the rays land');
  assert.ok(Math.abs(r!.tiltDeg - 15) < 0.2, `tilt ${r!.tiltDeg}`);
  assert.ok(r!.up[1] < -0.25 && Math.abs(r!.up[0]) < 1e-3, `up ${r!.up}`);
  // flat on top of a level slab: no tilt
  const level = fromManifold(Manifold.cube([60, 60, 10], true));
  const flat = surfaceUp(level, { center: [0, 0, 5], axis: [0, 0, 1], diameter: 6 });
  assert.ok(flat && flat.tiltDeg < 0.01, `level: ${flat?.tiltDeg}`);
});

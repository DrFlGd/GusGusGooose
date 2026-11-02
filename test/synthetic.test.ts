// End-to-end check on a synthetic goose: a sphere with four magnet voids.
// Proves void detection and the fit pipeline before the real STL arrives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStl, writeStl } from '../src/stl.ts';
import { findVoids, suggestNames } from '../src/voids.ts';
import { DEFAULT_PROFILE, fitAccessory, frameAt, fromManifold, manifold, toManifold, type FitProfile } from '../src/fit.ts';

const R = 30; // goose body radius
const VOID_D = 6, VOID_DEPTH = 3;

async function syntheticGoose() {
  const { Manifold } = await manifold();
  let body = Manifold.sphere(R, 96);
  const axes: [number, number, number][] = [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0, -1, 0]];
  for (const axis of axes) {
    const cutter = Manifold.cylinder(VOID_DEPTH + 2, VOID_D / 2, VOID_D / 2, 48, false)
      .translate(0, 0, -VOID_DEPTH)
      .transform(frameAt([axis[0] * R, axis[1] * R, axis[2] * R], axis) as any);
    body = body.subtract(cutter);
  }
  return body;
}

test('detects the four voids with the right size and axis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goose-'));
  const goose = await syntheticGoose();
  const path = join(dir, 'goose.stl');
  writeStl(path, fromManifold(goose)); // round-trip through STL like the real file will
  const mesh = readStl(path);
  const voids = findVoids(mesh);
  assert.equal(voids.length, 4);
  for (const v of voids) {
    assert.ok(Math.abs(v.diameter - VOID_D) < 0.1, `diameter ${v.diameter}`);
    assert.ok(Math.abs(v.depth - VOID_DEPTH) < 0.3, `depth ${v.depth}`);
    // the mouth sits on the sphere surface and the axis points outward
    const r = Math.hypot(...v.center);
    assert.ok(Math.abs(r - R) < 0.3, `mouth radius ${r}`);
    const outward = (v.center[0] * v.axis[0] + v.center[1] * v.axis[1] + v.center[2] * v.axis[2]) / r;
    assert.ok(outward > 0.99, `axis not outward: ${outward}`);
  }
  const names = suggestNames(voids);
  assert.deepEqual(Object.keys(names).sort(), ['beak', 'head', 'left_wing', 'right_wing']);
  assert.ok(voids[names.head].axis[2] > 0.99);
  assert.ok(voids[names.beak].axis[0] > 0.99);
});

test('fits a hat on the head: carved base, pocket, one body', async () => {
  const { Manifold } = await manifold();
  const goose = await syntheticGoose();
  const voids = findVoids(fromManifold(goose));
  const names = suggestNames(voids);
  const profile: FitProfile = { ...DEFAULT_PROFILE, points: { head: voids[names.head] } };
  const hat = Manifold.cylinder(8, 10, 10, 64, false); // base on z=0, +Z up
  const result = await fitAccessory(goose, await toManifold(fromManifold(hat)), profile, {
    point: 'head', sink: 2, spin: 0, offset: [0, 0],
  });
  assert.equal(result.bodies, 1);
  assert.deepEqual(result.warnings, []);
  // the sphere cap sunk 2 mm plus a pocket should remove a modest slice
  const removed = result.volumeBefore - result.volumeAfter;
  const pocket = Math.PI * 9 * (VOID_DEPTH + DEFAULT_PROFILE.pocketAxialClearance);
  assert.ok(removed > pocket, `removed ${removed} < pocket ${pocket}`);
  assert.ok(removed < result.volumeBefore * 0.4, `removed too much: ${removed}`);

  // the fitted hat must not intersect the goose by more than a sliver
  const fitted = await toManifold(result.mesh);
  const overlap = fitted.intersect(goose).volume();
  assert.ok(overlap < 1, `overlap with goose ${overlap} mm³`);
  // and the carved face must hover just above the surface: pushing it down
  // by the clearance should start to overlap
  const pushed = fitted.translate(0, 0, -DEFAULT_PROFILE.clearance * 1.5);
  assert.ok(pushed.intersect(goose).volume() > 1, 'carved face is not close to the goose');
});

test('per-accessory pocket overrides change the pocket size', async () => {
  const { Manifold } = await manifold();
  const goose = await syntheticGoose();
  const voids = findVoids(fromManifold(goose));
  const names = suggestNames(voids);
  const profile: FitProfile = { ...DEFAULT_PROFILE, points: { head: voids[names.head] } };
  const hat = await toManifold(fromManifold(Manifold.cylinder(8, 10, 10, 64, false)));
  const base = { point: 'head', sink: 2, spin: 0, offset: [0, 0] as [number, number] };
  const stock = await fitAccessory(goose, hat, profile, base);
  const bigger = await fitAccessory(goose, hat, profile, { ...base, pocket: { diameter: 8, thickness: 4 } });
  const none = await fitAccessory(goose, hat, profile, { ...base, pocket: { none: true } });
  // bigger magnet removes about the difference between the two cylinders
  const extra = Math.PI * (16 * 4.1 - 9 * 3.1);
  const got = stock.volumeAfter - bigger.volumeAfter;
  assert.ok(Math.abs(got - extra) < extra * 0.1, `extra pocket volume ${got}, expected ${extra}`);
  // the stock pocket is the magnet cylinder plus the plug of accessory that
  // had filled the goose void (up to sink + clearance deep)
  const pocketOnly = none.volumeAfter - stock.volumeAfter;
  const magnet = Math.PI * 9 * 3.1, plug = Math.PI * 9 * (2 + DEFAULT_PROFILE.clearance);
  assert.ok(pocketOnly > magnet && pocketOnly < magnet + plug + 5, `stock pocket volume ${pocketOnly}`);
});

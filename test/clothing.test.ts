import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifold, fromManifold } from '../src/fit.ts';
import { bodyProfile, cavityProfile, contourGarment, wrapGarment } from '../src/clothing.ts';

// a stand-in goose: a fat body (ellipsoid), a thin neck, a head with a beak sticking forward (-y)
async function bird() {
  const { Manifold } = await manifold();
  const body = Manifold.sphere(30, 64).scale([1, 1.4, 1]).translate(0, 0, 40);
  const neck = Manifold.cylinder(60, 7, 7, 48, false).translate(0, -20, 60);
  const head = Manifold.sphere(13, 48).translate(0, -20, 120);
  const beak = Manifold.cylinder(22, 5, 2, 32, false).rotate([90, 0, 0]).translate(0, -22, 118);
  return Manifold.union([body, neck, head, beak]);
}

test('body profile measures radius per angle', async () => {
  const { Manifold } = await manifold();
  const cyl = Manifold.cylinder(20, 10, 10, 96, false).translate(3, -2, 0);
  const p = bodyProfile(cyl, 5, 5, 36, [0, 0]);
  // from (0,0), the far wall of a radius-10 circle centred at (3,-2) is between 7 and 13.6 away
  const row = Array.from(p.r[0]);
  assert.ok(Math.min(...row) > 6.3 && Math.max(...row) < 13.7, `radii ${Math.min(...row)}..${Math.max(...row)}`);
  // along +x the wall is at 3 + sqrt(100 - 4)
  assert.ok(Math.abs(row[0] - (3 + Math.sqrt(96))) < 0.05, `r(0) = ${row[0]}`);
});

test('contour shirt clears the body, has no undercuts and a collar bigger than the neck', async () => {
  const goose = await bird();
  const g = await contourGarment(goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4 });
  assert.equal(g.solid.status(), 'NoError');
  assert.equal(g.solid.decompose().length, 1);
  assert.ok(g.solid.volume() > 0);
  assert.ok(g.solid.intersect(goose).volume() < 2, `overlaps the body by ${g.solid.intersect(goose).volume()} mm³`);
  // every inner ring contains the ring above it
  const cav = cavityProfile(goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4 });
  for (let k = 0; k + 1 < cav.inner.z.length; k++) for (let i = 0; i < cav.inner.nTheta; i++) {
    assert.ok(cav.inner.r[k][i] >= cav.inner.r[k + 1][i] - 1e-4, `undercut at ring ${k} angle ${i}`);
  }
  // collar: at least neck radius + clearance + gap everywhere
  for (const h of cav.hole) assert.ok(h >= 7 + 0.4 + 1 - 1e-3, `collar too tight: ${h}`);
  // drop mode: the collar and every section pass the head and beak
  const drop = cavityProfile(goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4, collar: 'drop' });
  for (let i = 0; i < drop.inner.nTheta; i++) assert.ok(drop.hole[i] >= drop.headProjection[i] + 0.4 - 1e-3);
  assert.ok(Math.max(...drop.hole) > Math.max(...cav.hole), 'drop collar should be wider than tilt collar');
});

test('wrapping a simple sweater keeps its features and hollows it for the body', async () => {
  const { Manifold } = await manifold();
  const goose = await bird();
  // a tapered tube with a button on the front, hem at z = 0
  let sweater = Manifold.cylinder(30, 14, 10, 64, false).subtract(Manifold.cylinder(32, 12.5, 8.5, 64, false).translate(0, 0, -1));
  sweater = sweater.add(Manifold.sphere(1.5, 16).translate(0, -12, 15));
  const g = await wrapGarment(sweater, goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4 });
  assert.equal(g.mode, 'shell');
  assert.equal(g.solid.status(), 'NoError');
  assert.ok(g.solid.intersect(goose).volume() < 2, 'wrapped sweater overlaps the body');
  const bb = g.solid.boundingBox();
  assert.ok(bb.min[2] > 24 && bb.max[2] < 66.5, `z ${bb.min[2]}..${bb.max[2]}`);
  // its wall has about the sweater's thickness: volume is near surface area x 1.5
  const shell = await contourGarment(goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4, collar: 'tilt', collarGap: 0 });
  assert.ok(g.solid.volume() > 0.6 * shell.solid.volume() && g.solid.volume() < 1.6 * shell.solid.volume(), `volume ${g.solid.volume()} vs shell ${shell.solid.volume()}`);
  void fromManifold;
});

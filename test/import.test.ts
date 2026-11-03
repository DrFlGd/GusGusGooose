import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifold, fromManifold } from '../src/fit.ts';
import { prepareAccessory, SIDE_ROTATION, type Side } from '../src/prepare.ts';
import { parseObj } from '../src/obj.ts';
import { loadModel } from '../src/load-model.ts';
import { serializeStl } from '../src/stl.ts';

test('each side rotation brings that side to -Z', async () => {
  const { Manifold } = await manifold();
  // a marker cube on the chosen side of a unit cube tells us where that side went
  for (const side of Object.keys(SIDE_ROTATION) as Side[]) {
    const axis = 'xyz'.indexOf(side[1]);
    const sign = side[0] === '-' ? -1 : 1;
    const t: [number, number, number] = [0, 0, 0];
    t[axis] = sign * 10;
    const m = Manifold.cube([2, 2, 2], true).add(Manifold.cube([1, 1, 1], true).translate(t)).rotate(SIDE_ROTATION[side]);
    const bb = m.boundingBox();
    assert.ok(bb.min[2] < -9 && bb.max[2] < 2, `${side}: marker should be below after rotation, got z ${bb.min[2]}..${bb.max[2]}`);
  }
});

test('prepare scales to a width, sits on z=0 and adds a plug', async () => {
  const { Manifold } = await manifold();
  // a hollow dome (shell) 40 wide, 20 tall, open at the bottom, modelled upside down (open side up)
  const dome = Manifold.sphere(20, 48).subtract(Manifold.sphere(18, 48)).intersect(Manifold.cube([50, 50, 25], true).translate(0, 0, 12.5)).rotate([180, 0, 0]).translate(5, -7, 100);
  const p = await prepareAccessory(dome, { down: '+z', scale: 1, width: 20, plug: { diameter: 12, height: 8 }, centre: 'bbox' });
  assert.ok(Math.abs(p.scale - 0.5) < 1e-6, `scale ${p.scale}`);
  const bb = p.solid.boundingBox();
  assert.ok(Math.abs(bb.min[2]) < 1e-6 && Math.abs(bb.max[2] - 10) < 1e-6, `z ${bb.min[2]}..${bb.max[2]}`);
  assert.ok(Math.abs(bb.min[0] + 10) < 1e-6 && Math.abs(bb.max[1] - 10) < 1e-6, `xy ${bb.min}..${bb.max}`);
  // the plug fills the hollow: volume is shell + plug, and a point at the centre is now inside
  const shellVol = dome.scale(0.5).volume();
  assert.ok(p.solid.volume() > shellVol + 0.9 * Math.PI * 36 * 8, 'plug volume missing');
  // the plug seals a small air pocket under the dome top; only one solid body with positive volume
  assert.equal(p.solid.decompose().filter((b) => b.volume() > 0).length, 1);
});

test('OBJ parses polygons and negative indices', () => {
  const obj = `v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0.5 0.5 1\nf 1 4 3 2\nf 1 2 5\nf 2 3 5\nf 3 4 5\nf -2 -5 -1\n`;
  const m = parseObj(obj);
  assert.equal(m.positions.length / 3, 5);
  assert.equal(m.triangles.length / 3, 6);
});

test('loadModel reads STL, OBJ and 3MF to one solid', async () => {
  const { Manifold } = await manifold();
  const cube = fromManifold(Manifold.cube([10, 10, 10], true));
  const stl = await loadModel('cube.stl', serializeStl(cube));
  assert.ok(Math.abs(stl.solid.volume() - 1000) < 1e-3);
  const obj = await loadModel('cube.obj', new TextEncoder().encode('v -1 -1 -1\nv 1 -1 -1\nv 1 1 -1\nv -1 1 -1\nv -1 -1 1\nv 1 -1 1\nv 1 1 1\nv -1 1 1\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n'));
  assert.ok(Math.abs(obj.solid.volume() - 8) < 1e-6, `obj volume ${obj.solid.volume()}`);
  const bambu = await loadModel('goose-voids.3mf', readFileSync('goose/goose-voids.3mf'));
  assert.equal(bambu.parts, 3);
  assert.ok(bambu.solid.volume() > 100000, 'goose body volume');
});

// The slide-in magnet channels: each seat stays where the fit profile has
// it, the channel opens once, under its cover, and its key fits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { read3mf } from '../src/threemf.ts';
import { buildSlots } from '../src/build-slots.ts';
import { fromManifold, manifold } from '../src/fit.ts';

const built = buildSlots(read3mf('goose/goose.3mf'), read3mf('goose/goose-voids.3mf'), () => {});

test('every channel keeps the seat\'s outer face exactly where the fit profile puts it', async () => {
  const b = await built;
  const profile = JSON.parse(readFileSync('goose/profile.json', 'utf8'));
  for (const [name, ch] of Object.entries(b.channels)) {
    const pt = profile.points[name];
    assert.ok(pt, `${name} is in the profile`);
    const ax = pt.axis as number[];
    const mesh = fromManifold(ch.cut);
    let max = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) max = Math.max(max, mesh.positions[i] * ax[0] + mesh.positions[i + 1] * ax[1] + mesh.positions[i + 2] * ax[2]);
    const face = pt.faceCenter[0] * ax[0] + pt.faceCenter[1] * ax[1] + pt.faceCenter[2] * ax[2];
    assert.ok(Math.abs(max - face) < 0.01, `${name}: channel reaches ${max.toFixed(3)} along the axis, the seat's face is at ${face.toFixed(3)}`);
    assert.ok(ch.magnet.subtract(ch.cut).volume() < 1e-6, `${name}: a magnet fits the seat`);
  }
});

test('each channel opens once, on the body, and the body stays one piece', async () => {
  const b = await built;
  for (const [name, ch] of Object.entries(b.channels)) {
    const outside = ch.cut.subtract(b.bodySolid).decompose().filter((p) => p.volume() > 0.3);
    assert.equal(outside.length, 1, `${name} has one mouth`);
  }
  assert.equal(b.goose.body.decompose().length, 1);
});

test('the keys fit their channels, stop short of the magnet, and sit flush', async () => {
  const b = await built;
  const { Manifold } = await manifold();
  for (const [name, ch] of Object.entries(b.channels)) {
    assert.ok(ch.key.volume() > 100, `${name} has a key`);
    assert.ok(ch.key.subtract(ch.cut).volume() < 1e-6, `${name}: key inside the channel`);
    assert.ok(ch.key.subtract(b.bodySolid).volume() < 1e-6, `${name}: key not proud of the body`);
    const grown = Manifold.union([ch.magnet, ch.magnet.translate([0.5, 0, 0]), ch.magnet.translate([-0.5, 0, 0]), ch.magnet.translate([0, 0.5, 0]), ch.magnet.translate([0, -0.5, 0]), ch.magnet.translate([0, 0, 0.5]), ch.magnet.translate([0, 0, -0.5])]);
    assert.ok(ch.key.intersect(grown).volume() < 1e-6, `${name}: key clear of the magnet`);
  }
});

test('the wing mouths are clear of the legs; the head mouth is under the beak', async () => {
  const b = await built;
  const { Manifold } = await manifold();
  const dil = (m: ReturnType<typeof Manifold.cube>, r: number) => Manifold.union([m, m.translate([r, 0, 0]), m.translate([-r, 0, 0]), m.translate([0, r, 0]), m.translate([0, -r, 0]), m.translate([0, 0, r]), m.translate([0, 0, -r])]);
  const legs = dil(Manifold.union(b.goose.legs), 1.5);
  for (const name of ['left_wing', 'right_wing']) {
    assert.ok(b.channels[name].cut.subtract(b.bodySolid).intersect(legs).volume() < 1e-6, `${name} mouth clear of the legs`);
  }
  const shell = dil(b.bodySolid, 0.6).subtract(b.bodySolid);
  const mouth = b.channels.head.cut.intersect(shell);
  const covered = mouth.intersect(dil(b.beak, 1.0)).volume() / mouth.volume();
  assert.ok(covered > 0.7, `the beak covers ${(covered * 100).toFixed(0)}% of the head mouth's rim`);
});

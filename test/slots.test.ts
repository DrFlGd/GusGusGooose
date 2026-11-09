// The slide-in magnet channels: each seat stays where the fit profile has
// it, the channel opens once, under its cover, and its key fits, in every
// version (swept, flat on its side, flat upright).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { read3mf } from '../src/threemf.ts';
import { buildSlots, keyDown, layoutBuild } from '../src/slots-build.ts';
import { DEFAULT_SLOTS, type SlotOptions } from '../src/slots.ts';
import { fromManifold, manifold } from '../src/fit.ts';

const parts = read3mf('goose/goose.3mf'), voidParts = read3mf('goose/goose-voids.3mf');
const VERSIONS: Record<string, SlotOptions> = {
  swept: { ...DEFAULT_SLOTS, style: 'swept' },
  'flat on its side': { ...DEFAULT_SLOTS, style: 'flat', keyEnd: 'square' },
  'flat upright': { ...DEFAULT_SLOTS, style: 'flat', keyEnd: 'level' },
};
const builds = Object.fromEntries(Object.entries(VERSIONS).map(([k, o]) => [k, buildSlots(parts, voidParts, o, () => {})]));
const profile = JSON.parse(readFileSync('goose/profile.json', 'utf8'));

for (const [version, built] of Object.entries(builds)) {
  test(`${version}: every channel keeps the seat's outer face exactly where the fit profile puts it`, async () => {
    const b = await built;
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

  test(`${version}: each channel opens once, on the body, and the body stays one piece`, async () => {
    const b = await built;
    for (const [name, ch] of Object.entries(b.channels)) {
      const outside = ch.cut.subtract(b.bodySolid).decompose().filter((p) => p.volume() > 0.3);
      assert.equal(outside.length, 1, `${name} has one mouth`);
    }
    assert.equal(b.goose.body.decompose().length, 1);
    assert.deepEqual(b.notes, []);
  });

  test(`${version}: the keys fit their channels, stop short of the magnet, and sit flush (but for the tongue)`, async () => {
    const b = await built;
    const { Manifold } = await manifold();
    for (const [name, ch] of Object.entries(b.channels)) {
      assert.ok(ch.key.volume() > 100, `${name} has a key`);
      const inside = ch.tongue ? ch.key.subtract(ch.tongue) : ch.key;
      assert.ok(inside.subtract(ch.cut).volume() < 1e-6, `${name}: key inside the channel`);
      assert.ok(inside.subtract(b.bodySolid).volume() < 1e-6, `${name}: key not proud of the body`);
      const grown = Manifold.union([ch.magnet, ch.magnet.translate([0.5, 0, 0]), ch.magnet.translate([-0.5, 0, 0]), ch.magnet.translate([0, 0.5, 0]), ch.magnet.translate([0, -0.5, 0]), ch.magnet.translate([0, 0, 0.5]), ch.magnet.translate([0, 0, -0.5])]);
      assert.ok(ch.key.intersect(grown).volume() < 1e-6, `${name}: key clear of the magnet`);
      if (ch.options.style === 'flat') {
        // a flat key: its long faces are planes, so it lies on one; the bar's silhouette matches the bore
        const bb = inside.getMesh();
        assert.ok(bb.numVert < 400, `${name}: a flat key is a simple bar (${bb.numVert} vertices)`);
      }
    }
  });
}

test('the wing mouths are clear of the legs; the head mouth is under the beak', async () => {
  const b = await builds.swept;
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

test('the head key\'s tongue stands proud, fits the beak\'s pocket and misses the beak\'s own magnet slot', async () => {
  const b = await builds['flat on its side'];
  const ch = b.channels.head;
  assert.ok(ch.tongue && ch.pocket, 'the head key has a tongue and the beak a pocket');
  assert.ok(ch.tongue!.volume() > 10, 'the tongue has some size');
  assert.ok(ch.tongue!.intersect(b.beak).volume() < 1e-6, 'the tongue does not run into the beak');
  assert.ok(ch.tongue!.intersect(b.bodySolid).volume() < 1e-6, 'the tongue is outside the body');
  // the protrusion from the mouth centre along the channel
  const d = ch.direction, m = ch.spec.mouth;
  const mesh = fromManifold(ch.tongue!);
  let proud = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) proud = Math.max(proud, (mesh.positions[i] - m[0]) * d[0] + (mesh.positions[i + 1] - m[1]) * d[1] + (mesh.positions[i + 2] - m[2]) * d[2]);
  assert.ok(Math.abs(proud - 1.5) < 0.05, `the tongue stands ${proud.toFixed(2)} mm proud of the mouth`);
  assert.equal(b.beak.decompose().length, 1, 'the beak stays one piece');
});

test('the print lays the loose parts flat: flat keys on a side, upright keys standing on their level end', async () => {
  for (const [version, built] of Object.entries(builds)) {
    const b = await built;
    const objects = layoutBuild(b);
    assert.deepEqual(objects.map((o) => o.name), ['goose', 'beak', 'key head', 'key left wing', 'key right wing', 'eyes'], version);
    for (const o of objects.slice(1)) {
      const P = o.parts[0].mesh.positions;
      let zMin = Infinity, zMax = -Infinity;
      for (let i = 2; i < P.length; i += 3) { zMin = Math.min(zMin, P[i]); zMax = Math.max(zMax, P[i]); }
      assert.ok(Math.abs(zMin) < 1e-3, `${version}: ${o.name} sits on the plate`);
      const tall = o.name.includes('wing') && b.options.keyEnd === 'level' && b.options.style === 'flat';
      assert.ok(tall ? zMax > 30 : zMax < 25, `${version}: ${o.name} is ${zMax.toFixed(1)} mm tall`);
    }
    for (const [name, ch] of Object.entries(b.channels)) {
      const down = keyDown(name, ch);
      assert.ok(Math.abs(Math.hypot(...down) - 1) < 1e-6, `${version}: ${name} key has a unit down`);
    }
  }
});

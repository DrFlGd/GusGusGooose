// The slide-in magnet channels: each seat stays where the fit profile has
// it, the channel opens once, under its cover, and its key fits, in every
// version (swept, flat on its side, flat upright).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { read3mf } from '../src/threemf.ts';
import { buildSlots, keyDown, layoutBuild } from '../src/slots-build.ts';
import { DEFAULT_SLOTS, sweep, type SlotOptions, type V3 } from '../src/slots.ts';
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
  test(`${version}: each magnet slides from its mouth all the way into its seat`, async () => {
    const b = await built;
    const { Manifold } = await manifold();
    for (const [name, ch] of Object.entries(b.channels)) {
      const path = ch.spec.drop > 0 ? [ch.junction, ch.spec.mouth] : [ch.spec.mouth];
      const travel = sweep(Manifold, ch.magnet, ch.spec.seat.center, path);
      assert.ok(travel.intersect(b.bodySolid).subtract(ch.cut).volume() < 1e-6, `${name}: the magnet slides all the way in`);
    }
  });
}

test('flat channels: the head wall beside the mouth stays thick enough not to show through (2026-11-19)', async () => {
  // Jerred's print showed the channel through the white face above the beak, on both sides: the rectangular
  // bore's upper corners left 0.2-0.6 mm of wall in the first 3 mm. The bore now follows the magnet's own
  // outline with a flat strip on top, and the mouth sits 0.26 mm to the goose's left, which balances the sides.
  const { Manifold } = await manifold();
  for (const version of ['flat on its side', 'flat upright']) {
    const b = await builds[version];
    const ch = b.channels.head;
    const m = ch.spec.mouth, n = ch.direction;
    const box = Manifold.cube([40, 40, 40], true).translate(m);
    const outside = box.subtract(b.bodySolid);
    // the slab of the channel from `from` to `to` mm in from the mouth
    const slab = (from: number, to: number) => {
      const helper: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const e1 = [helper[1] * n[2] - helper[2] * n[1], helper[2] * n[0] - helper[0] * n[2], helper[0] * n[1] - helper[1] * n[0]];
      const l = Math.hypot(e1[0], e1[1], e1[2]);
      const a: V3 = [e1[0] / l, e1[1] / l, e1[2] / l];
      const c: V3 = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
      const mid: V3 = [m[0] - n[0] * (from + to) / 2, m[1] - n[1] * (from + to) / 2, m[2] - n[2] * (from + to) / 2];
      return Manifold.cube([60, 60, to - from], true).transform([...a, 0, ...c, 0, ...n, 0, ...mid, 1] as any);
    };
    for (const [from, to, least] of [[1.5, 2.5, 0.9], [2.5, 4, 1.1], [4, 6, 1.3]]) {
      const wall = ch.cut.intersect(slab(from, to)).minGap(outside, 4);
      assert.ok(wall >= least, `${version}: ${wall.toFixed(2)} mm of wall ${from}-${to} mm in from the head mouth (want ${least})`);
    }
  }
});

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

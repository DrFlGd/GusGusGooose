// The sea otter: painted after the concept art, standing flat, magnet seats
// the goose's size under a thin skin, and slide-in channels from the base that
// open once, under the otter, in every version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readStl } from '../src/stl-node.ts';
import { expandRuns } from '../src/goose-colors.ts';
import { fromManifold, manifold, toManifoldTagged } from '../src/fit.ts';
import { BLACK, buildOtterSlots, DARK, layoutOtter, LIGHT, otterKeyDown, otterPaint, OTTER_MATERIALS, paintOtter, rayHit, wholeFaceCodes } from '../src/otter.ts';
import { DEFAULT_SLOTS, type SlotOptions, type V3 } from '../src/slots.ts';
import { CHARACTERS } from '../src/characters.ts';
import { write3mfBuild } from '../src/threemf-write.ts';
import { parse3mf } from '../src/threemf-parse.ts';

const source = readStl('characters/otter/otter-source.stl');
const mesh = readStl('goose/otter.stl');
const colors = JSON.parse(readFileSync('goose/otter-colors.json', 'utf8'));
const profile = JSON.parse(readFileSync('goose/otter-profile.json', 'utf8'));
const goose = JSON.parse(readFileSync('goose/profile.json', 'utf8'));
const faceMaterial = expandRuns(colors, mesh.triangles.length / 3);
const body = (async () => {
  const { Manifold } = await manifold();
  const firstID = Manifold.reserveIDs(OTTER_MATERIALS.length);
  return { firstID, solid: await toManifoldTagged(mesh, faceMaterial, firstID) };
})();
const VERSIONS: Record<string, SlotOptions> = {
  'flat on its side': { ...DEFAULT_SLOTS, tongue: null },
  'flat upright': { ...DEFAULT_SLOTS, keyEnd: 'level', tongue: null },
  swept: { ...DEFAULT_SLOTS, style: 'swept', tongue: null },
};
const builds = Object.fromEntries(Object.entries(VERSIONS).map(([k, o]) => [k, body.then((b) => buildOtterSlots(b.solid, profile, o, () => {}))]));

test('the paint follows the concept art: light face and belly, dark back, paws, feet and tail, black eyes and nose', () => {
  const paint = paintOtter(source);
  const at = (o: V3, d: V3) => paint[rayHit(source, o, d).face];
  const front = (x: number, z: number) => at([x, -50, z], [0, 1, 0]);
  const back = (x: number, z: number) => at([x, 200, z], [0, -1, 0]);
  assert.equal(front(34, 118), LIGHT, 'forehead');
  assert.equal(front(34, 40), LIGHT, 'belly');
  assert.equal(front(34, 65), LIGHT, 'chest between the paws');
  assert.equal(at([34, 42, 250], [0, 0, -1]), LIGHT, 'top of the head');
  assert.equal(back(34, 110), LIGHT, 'back of the head');
  assert.equal(back(34, 50), DARK, 'back');
  assert.equal(front(18, 66), DARK, 'left paw');
  assert.equal(front(50, 66), DARK, 'right paw');
  assert.equal(front(12, 6), DARK, 'foot');
  assert.equal(at([34, 90, 250], [0, 0, -1]), DARK, 'tail');
  assert.equal(front(4, 108), DARK, 'ear');
  assert.equal(front(21, 107), BLACK, 'left eye');
  assert.equal(front(46.5, 107), BLACK, 'right eye');
  assert.equal(front(34, 102), BLACK, 'nose');
  // the smile and freckles add black beyond the eyes and nose, but stay small
  const black = paint.filter((m) => m === BLACK).length;
  assert.ok(black > 9500 && black < 13000, `${black} black triangles`);
});

test('the app\'s otter stands on a flat base, its colours line up with the STL, and it is in the character list', async () => {
  assert.equal(faceMaterial.length, mesh.triangles.length / 3);
  assert.equal(colors.runs.reduce((n: number, [, c]: [number, number]) => n + c, 0), mesh.triangles.length / 3);
  let zMin = Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) zMin = Math.min(zMin, mesh.positions[i]);
  assert.ok(Math.abs(zMin) < 1e-4, `bottom at ${zMin}`);
  const { solid } = await body;
  const footing = solid.slice(0.01).area();
  assert.ok(footing > 2500, `${footing.toFixed(0)} mm² on the desk`);
  // the cut base is dark brown
  const P = mesh.positions, T = mesh.triangles;
  for (let t = 0; t < T.length / 3; t++) {
    if ([0, 1, 2].every((k) => Math.abs(P[T[t * 3 + k] * 3 + 2]) < 1e-4)) assert.equal(faceMaterial[t], DARK, `base face ${t}`);
  }
  assert.equal(CHARACTERS.otter.files.stl, 'otter.stl');
});

test('the seats take the goose\'s magnets, in the top of the head and the chest, under at least 1.2 mm', () => {
  assert.deepEqual(Object.keys(profile.points).sort(), ['chest', 'head']);
  for (const [name, p] of Object.entries(profile.points) as [string, any][]) {
    assert.ok(Math.abs(p.diameter - goose.points.head.diameter) < 0.01 && Math.abs(p.depth - goose.points.head.depth) < 0.01, `${name}: ${p.diameter} x ${p.depth}`);
    // the skin over the face, along the axis, across the whole magnet
    const axis = p.axis as V3, f = p.faceCenter as V3;
    const e0: V3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1: V3 = [axis[1] * e0[2] - axis[2] * e0[1], axis[2] * e0[0] - axis[0] * e0[2], axis[0] * e0[1] - axis[1] * e0[0]];
    let least = Infinity;
    for (const r of [0, 2.5, 5.1]) for (let j = 0; j < 12; j++) {
      const th = (j / 12) * Math.PI * 2;
      const q: V3 = [0, 1, 2].map((k) => f[k] + e0[k] * r * Math.cos(th) + e1[k] * r * Math.sin(th)) as V3;
      // from just outside the seat's face (the served otter has the seat cut, so the face itself is a surface)
      least = Math.min(least, rayHit(mesh, q.map((v, k) => v + axis[k] * 0.05) as V3, axis).t + 0.05);
    }
    assert.ok(least > 1.15 && least < 2.5, `${name}: ${least.toFixed(2)} mm over the magnet`);
  }
  assert.ok(profile.points.head.axis[2] > 0.99, 'head axis straight up');
  assert.ok(profile.points.chest.axis[1] < -0.85, 'chest axis forward');
  assert.ok(Math.abs(profile.points.chest.center[0] - 34) < 0.01, 'chest between the paws');
});

for (const version of Object.keys(VERSIONS)) {
  test(`${version}: each channel opens once, in the base under the otter, keeps clear of the skin and of the other`, async () => {
    const b = await builds[version];
    const { Manifold } = await manifold();
    assert.deepEqual(b.notes, []);
    assert.equal(b.body.decompose().length, 1);
    const dirs: V3[] = [];
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) { const l = Math.hypot(x, y, z); dirs.push([x / l, y / l, z / l]); }
    const grow = (m: ReturnType<typeof Manifold.cube>, r: number) => Manifold.union([m, ...dirs.map((d) => m.translate([d[0] * r, d[1] * r, d[2] * r]))]);
    for (const [name, ch] of Object.entries(b.channels)) {
      const mouths = ch.cut.subtract(b.bodySolid).decompose().filter((p) => p.volume() > 0.3);
      assert.equal(mouths.length, 1, `${name} has one mouth`);
      assert.ok(mouths[0].boundingBox().max[2] < 0.01, `${name}: the mouth is in the base`);
      // nothing but the mouth comes within 1.2 mm of the outside
      const near = grow(ch.cut, 1.2).subtract(b.bodySolid).decompose().filter((p) => p.volume() > 0.05);
      assert.equal(near.length, 1, `${name}: ${near.length} places within 1.2 mm of the skin`);
      // the seat's outer face is where the profile has it
      const ax = profile.points[name].axis as V3, face = profile.points[name].faceCenter as V3;
      const m = fromManifold(ch.cut);
      let reach = -Infinity;
      for (let i = 0; i < m.positions.length; i += 3) reach = Math.max(reach, m.positions[i] * ax[0] + m.positions[i + 1] * ax[1] + m.positions[i + 2] * ax[2]);
      assert.ok(Math.abs(reach - (face[0] * ax[0] + face[1] * ax[1] + face[2] * ax[2])) < 0.01, `${name}: the channel reaches the seat's face and no further`);
      assert.ok(ch.magnet.subtract(ch.cut).volume() < 1e-6, `${name}: a magnet fits`);
      // the key: inside its channel and the otter, flush with the base, short of the magnet
      assert.ok(ch.key.volume() > 1000, `${name} has a key`);
      assert.ok(ch.key.subtract(ch.cut).volume() < 1e-6, `${name}: key inside the channel`);
      assert.ok(ch.key.subtract(b.bodySolid).volume() < 1e-6, `${name}: key not proud of the base`);
      assert.ok(Math.abs(ch.key.boundingBox().min[2]) < 1e-3, `${name}: key flush with the base`);
      assert.ok(ch.key.intersect(grow(ch.magnet, 0.5)).volume() < 1e-6, `${name}: key clear of the magnet`);
      assert.equal(ch.tongue, null);
    }
    assert.ok(grow(b.channels.head.cut, 3).intersect(b.channels.chest.cut).volume() < 1e-6, 'the channels stay 3 mm apart');
  });
}

test('the print: the painted otter in place, the keys beside it on the plate, the paint as slicer codes', async () => {
  const { firstID } = await body;
  for (const [version, built] of Object.entries(builds)) {
    const b = await built;
    const objects = layoutOtter(b, otterPaint(b, firstID));
    assert.deepEqual(objects.map((o) => o.name), ['otter', 'key head', 'key chest'], version);
    const otterBB = b.body.boundingBox();
    for (const o of objects) {
      const P = o.parts[0].mesh.positions;
      let zMin = Infinity, xMin = Infinity;
      for (let i = 0; i < P.length; i += 3) { xMin = Math.min(xMin, P[i]); zMin = Math.min(zMin, P[i + 2]); }
      assert.ok(Math.abs(zMin) < 1e-3, `${version}: ${o.name} on the plate`);
      if (o.name !== 'otter') assert.ok(xMin > otterBB.max[0] + 5, `${version}: ${o.name} beside the otter`);
    }
    for (const ch of Object.values(b.channels)) assert.ok(Math.abs(Math.hypot(...otterKeyDown(ch)) - 1) < 1e-6);
  }
  const b = await builds['flat on its side'];
  const objects = layoutOtter(b, otterPaint(b, firstID));
  const codes = wholeFaceCodes(objects[0].parts[0].faceMaterial!);
  assert.ok(codes.some((c) => c) && codes.some((c) => !c));
  const bytes = write3mfBuild(objects, OTTER_MATERIALS, 'Sea otter');
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 50_000_000)));
  assert.ok(text.includes(`paint_color="${codes.find((c) => c)}"`), 'paint codes written');
  const parts = await parse3mf(bytes);
  assert.equal(parts.length, 3);
});

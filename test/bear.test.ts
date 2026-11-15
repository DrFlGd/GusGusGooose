// The bear: painted brown with black eyes and nose, standing flat, magnet
// seats in the top of the head and the mouth (the goose's 10 x 4 mm magnets)
// and under each wrist (8 x 3 mm), and slide-in channels that open once in
// every version: in the base for the head and the wrists, under the chin for
// the mouth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readStl } from '../src/stl-node.ts';
import { expandRuns } from '../src/goose-colors.ts';
import { fromManifold, manifold, toManifoldTagged } from '../src/fit.ts';
import { BEAR_MATERIALS, BLACK, BROWN, buildBearSlots, paintBear, WRIST_SEAT } from '../src/bear.ts';
import { characterKeyDown, characterPaint, layoutCharacter, rayHit, wholeFaceCodes } from '../src/desk-character.ts';
import { DEFAULT_SLOTS, sweep, type SlotOptions, type V3 } from '../src/slots.ts';
import { CHARACTERS } from '../src/characters.ts';
import { SLIDE_IN_CHARACTERS } from '../src/slide-in-characters.ts';
import { write3mfBuild } from '../src/threemf-write.ts';
import { parse3mf } from '../src/threemf-parse.ts';

const source = readStl('characters/bear/bear-source.stl');
const mesh = readStl('goose/bear.stl');
const colors = JSON.parse(readFileSync('goose/bear-colors.json', 'utf8'));
const profile = JSON.parse(readFileSync('goose/bear-profile.json', 'utf8'));
const goose = JSON.parse(readFileSync('goose/profile.json', 'utf8'));
const faceMaterial = expandRuns(colors, mesh.triangles.length / 3);
const body = (async () => {
  const { Manifold } = await manifold();
  const firstID = Manifold.reserveIDs(BEAR_MATERIALS.length);
  return { firstID, solid: await toManifoldTagged(mesh, faceMaterial, firstID) };
})();
const VERSIONS: Record<string, SlotOptions> = {
  'flat on its side': { ...DEFAULT_SLOTS, tongue: null },
  'flat upright': { ...DEFAULT_SLOTS, keyEnd: 'level', tongue: null },
  swept: { ...DEFAULT_SLOTS, style: 'swept', tongue: null },
};
const builds = Object.fromEntries(Object.entries(VERSIONS).map(([k, o]) => [k, body.then((b) => buildBearSlots(b.solid, profile, o, () => {}))]));

test('the paint: brown all over, black eyes and nose', () => {
  const paint = paintBear(source);
  const at = (o: V3, d: V3) => paint[rayHit(source, o, d).face];
  const front = (x: number, z: number) => at([x, -50, z], [0, 1, 0]);
  assert.equal(front(37.3, 91.2), BLACK, 'nose');
  assert.equal(front(26, 99), BLACK, 'right eye');
  assert.equal(front(41.3, 102.2), BLACK, 'left eye');
  assert.equal(front(37.3, 83), BROWN, 'mouth');
  assert.equal(front(33.5, 101), BROWN, 'between the eyes');
  assert.equal(front(34, 112), BROWN, 'forehead');
  assert.equal(front(37, 45), BROWN, 'belly');
  assert.equal(front(27, 58), BROWN, 'paw');
  assert.equal(at([34, 200, 60], [0, -1, 0]), BROWN, 'back');
  assert.equal(at([34, 38, 250], [0, 0, -1]), BROWN, 'top of the head');
  // the eyes and nose only: about 1.7 % of the triangles
  const black = paint.filter((m) => m === BLACK).length;
  assert.ok(black > 2800 && black < 3800, `${black} black triangles`);
});

test('the app\'s bear stands on a flat base, its colours line up with the STL, and it is in the character list', async () => {
  assert.equal(faceMaterial.length, mesh.triangles.length / 3);
  assert.equal(colors.runs.reduce((n: number, [, c]: [number, number]) => n + c, 0), mesh.triangles.length / 3);
  let zMin = Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) zMin = Math.min(zMin, mesh.positions[i]);
  assert.ok(Math.abs(zMin) < 1e-4, `bottom at ${zMin}`);
  const { solid } = await body;
  const footing = solid.slice(0.01);
  assert.ok(footing.area() > 2000, `${footing.area().toFixed(0)} mm² on the desk`);
  // the cut base is brown
  const P = mesh.positions, T = mesh.triangles;
  for (let t = 0; t < T.length / 3; t++) {
    if ([0, 1, 2].every((k) => Math.abs(P[T[t * 3 + k] * 3 + 2]) < 1e-4)) assert.equal(faceMaterial[t], BROWN, `base face ${t}`);
  }
  assert.equal(CHARACTERS.bear.files.stl, 'bear.stl');
  assert.equal(CHARACTERS.bear.clothing, false);
  assert.equal(SLIDE_IN_CHARACTERS.bear.source, 'characters/bear/bear-source.stl');
});

test('the seats: head and mouth take the goose\'s magnets, the wrists 8 x 3 mm ones, all under at least 1.2 mm', () => {
  assert.deepEqual(Object.keys(profile.points), ['head', 'mouth', 'left_wrist', 'right_wrist']);
  for (const [name, p] of Object.entries(profile.points) as [string, any][]) {
    const want = name.endsWith('wrist') ? WRIST_SEAT : goose.points.head;
    assert.ok(Math.abs(p.diameter - want.diameter) < 0.01 && Math.abs(p.depth - want.depth) < 0.01, `${name}: ${p.diameter} x ${p.depth}`);
    // the skin over the face, along the axis, across the whole magnet
    const axis = p.axis as V3, f = p.faceCenter as V3;
    const e0: V3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1: V3 = [axis[1] * e0[2] - axis[2] * e0[1], axis[2] * e0[0] - axis[0] * e0[2], axis[0] * e0[1] - axis[1] * e0[0]];
    let least = Infinity;
    for (const r of [0, p.diameter / 4, p.diameter / 2]) for (let j = 0; j < 12; j++) {
      const th = (j / 12) * Math.PI * 2;
      const q: V3 = [0, 1, 2].map((k) => f[k] + e0[k] * r * Math.cos(th) + e1[k] * r * Math.sin(th)) as V3;
      least = Math.min(least, rayHit(mesh, q.map((v, k) => v + axis[k] * 0.05) as V3, axis).t + 0.05);
    }
    assert.ok(least > 1.15 && least < 3, `${name}: ${least.toFixed(2)} mm over the magnet`);
  }
  assert.ok(profile.points.head.axis[2] > 0.99, 'head axis straight up');
  assert.ok(profile.points.mouth.axis[1] < -0.95, 'mouth axis forward');
  assert.ok(Math.abs(profile.points.mouth.center[0] - 37.3) < 2.5, 'mouth on the middle of the face');
  for (const w of ['left_wrist', 'right_wrist']) assert.ok(profile.points[w].axis[2] < -0.99, `${w} axis straight down`);
  // the bear's own left is +x
  assert.ok(profile.points.left_wrist.center[0] > profile.points.right_wrist.center[0] + 15);
});

for (const version of Object.keys(VERSIONS)) {
  test(`${version}: each channel opens once (in the base, or under the chin for the mouth), keeps clear of the skin and of the others`, async () => {
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
      const mb = mouths[0].boundingBox();
      // (the cut runs on past the surface, so the piece outside reaches below its opening)
      if (name === 'mouth') assert.ok(mb.max[2] > 70 && mb.max[2] < 77 && mb.max[1] < 30, `the mouth's channel opens under the chin: up to z ${mb.max[2].toFixed(1)}, y ${mb.max[1].toFixed(1)}`);
      else assert.ok(mb.max[2] < 1.5, `${name}: the mouth is in the base`);
      // nothing but the mouth comes near the outside: 1.2 mm, except behind the left arm, where the
      // channel squeezes past a notch in the fur (scanned 2026-11-15: between 0.6 and 0.8 mm, in one spot)
      const wall = name === 'left_wrist' ? 0.6 : 1.2;
      const near = grow(ch.cut, wall).subtract(b.bodySolid).decompose().filter((p) => p.volume() > 0.05);
      assert.equal(near.length, 1, `${name}: ${near.length} places within ${wall} mm of the skin`);
      // the magnet sits where the profile has it; the head's and mouth's channels leave their seats backwards, so
      // they reach the seat's face and no further (the wrists' run on along the axis, down to the base)
      const ax = profile.points[name].axis as V3, face = profile.points[name].faceCenter as V3, depth = profile.points[name].depth;
      const mag = ch.magnet.boundingBox();
      for (let k = 0; k < 3; k++) assert.ok(Math.abs((mag.min[k] + mag.max[k]) / 2 - (face[k] - ax[k] * depth / 2)) < 0.3, `${name}: the magnet is in its seat`);
      if (!name.endsWith('wrist')) {
        const m = fromManifold(ch.cut);
        let reach = -Infinity;
        for (let i = 0; i < m.positions.length; i += 3) reach = Math.max(reach, m.positions[i] * ax[0] + m.positions[i + 1] * ax[1] + m.positions[i + 2] * ax[2]);
        assert.ok(Math.abs(reach - (face[0] * ax[0] + face[1] * ax[1] + face[2] * ax[2])) < 0.01, `${name}: the channel reaches the seat's face and no further`);
      }
      assert.ok(ch.magnet.subtract(ch.cut).volume() < 1e-6, `${name}: a magnet fits`);
      // and gets there: the magnet slides from the mouth, round any bend, into its seat without touching the bear
      const travel = sweep(Manifold, ch.magnet, ch.spec.seat.center, [...(ch.spec.via ?? []), ch.spec.mouth]);
      assert.ok(travel.intersect(b.bodySolid).subtract(ch.cut).volume() < 1e-6, `${name}: the magnet slides all the way in`);
      // the key: inside its channel and the bear, short of the magnet; flush with the base when it closes one there
      assert.ok(ch.key.volume() > (name === 'mouth' ? 200 : 2500), `${name} has a key`);
      assert.ok(ch.key.subtract(ch.cut).volume() < 1e-6, `${name}: key inside the channel`);
      assert.ok(ch.key.subtract(b.bodySolid).volume() < 1e-6, `${name}: key not proud of the bear`);
      if (name !== 'mouth') assert.ok(Math.abs(ch.key.boundingBox().min[2]) < 1e-3, `${name}: key flush with the base`);
      assert.ok(ch.key.intersect(grow(ch.magnet, 0.5)).volume() < 1e-6, `${name}: key clear of the magnet`);
      assert.equal(ch.tongue, null);
    }
    const names = Object.keys(b.channels);
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      assert.ok(grow(b.channels[names[i]].cut, 3).intersect(b.channels[names[j]].cut).volume() < 1e-6, `the ${names[i]} and ${names[j]} channels stay 3 mm apart`);
    }
  });
}

test('the print: the painted bear in place, the keys beside it on the plate, the paint as slicer codes', async () => {
  const { firstID } = await body;
  for (const [version, built] of Object.entries(builds)) {
    const b = await built;
    const objects = layoutCharacter(b, characterPaint(b, firstID), 'bear');
    assert.deepEqual(objects.map((o) => o.name), ['bear', 'key head', 'key mouth', 'key left wrist', 'key right wrist'], version);
    const bb = b.body.boundingBox();
    for (const o of objects) {
      const P = o.parts[0].mesh.positions;
      let zMin = Infinity, xMin = Infinity;
      for (let i = 0; i < P.length; i += 3) { xMin = Math.min(xMin, P[i]); zMin = Math.min(zMin, P[i + 2]); }
      assert.ok(Math.abs(zMin) < 1e-3, `${version}: ${o.name} on the plate`);
      if (o.name !== 'bear') assert.ok(xMin > bb.max[0] + 5, `${version}: ${o.name} beside the bear`);
    }
    for (const ch of Object.values(b.channels)) assert.ok(Math.abs(Math.hypot(...characterKeyDown(ch)) - 1) < 1e-6);
  }
  const b = await builds['flat on its side'];
  const objects = layoutCharacter(b, characterPaint(b, firstID), 'bear');
  const codes = wholeFaceCodes(objects[0].parts[0].faceMaterial!);
  assert.ok(codes.some((c) => c) && codes.some((c) => !c));
  const bytes = write3mfBuild(objects, BEAR_MATERIALS, 'Bear');
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 50_000_000)));
  assert.ok(text.includes(`paint_color="${codes.find((c) => c)}"`), 'paint codes written');
  const parts = await parse3mf(bytes);
  assert.equal(parts.length, 5);
});

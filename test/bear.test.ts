// The bear: painted brown with black eyes and nose, standing flat, a 10 x 4
// mm magnet seat in the top of the head with a slide-in channel from the base
// that opens once in every version, and an open 8 x 4 mm pocket under each
// paw that the magnet goes into from below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readStl } from '../src/stl-node.ts';
import { expandRuns } from '../src/goose-colors.ts';
import { frameAt, fromManifold, manifold, toManifoldTagged } from '../src/fit.ts';
import { BEAR_MATERIALS, BLACK, BROWN, buildBearSlots, paintBear, PAW_SEAT } from '../src/bear.ts';
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
  assert.equal(front(37.3, 83), BROWN, 'muzzle');
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

test('the head\'s seat takes the goose\'s magnet under at least 1.2 mm, straight up on the crown', () => {
  assert.deepEqual(Object.keys(profile.points), ['head', 'left_paw', 'right_paw']);
  const p = profile.points.head;
  assert.ok(Math.abs(p.diameter - goose.points.head.diameter) < 0.01 && Math.abs(p.depth - goose.points.head.depth) < 0.01, `head: ${p.diameter} x ${p.depth}`);
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
  assert.ok(least > 1.15 && least < 3, `head: ${least.toFixed(2)} mm over the magnet`);
  assert.ok(p.axis[2] > 0.99, 'head axis straight up');
});

test('the paws: open 8 x 4 mm pockets underneath, at least 1.2 mm of plastic round and over, the magnet goes in from below', async () => {
  const { Manifold } = await manifold();
  const { solid } = await body;
  for (const name of ['left_paw', 'right_paw']) {
    const p = profile.points[name];
    assert.equal(p.mode, 'open');
    assert.ok(Math.abs(p.diameter - PAW_SEAT.diameter) < 0.01 && Math.abs(p.depth - PAW_SEAT.depth) < 0.01, `${name}: ${p.diameter} x ${p.depth}`);
    assert.ok(p.axis[2] < -0.9, `${name} faces down`);
    const frame = frameAt(p.center, p.axis) as any;
    const r = p.diameter / 2;
    // the walls: everything within 1.2 mm of the pocket, past its first half millimetre, is plastic
    const pocket = Manifold.cylinder(p.depth, r, r, 64).translate([0, 0, -p.depth]).transform(frame);
    const shell = Manifold.cylinder(p.depth + 1.2 - 0.5, r + 1.2, r + 1.2, 64).translate([0, 0, -(p.depth + 1.2)]).transform(frame);
    const thin = shell.subtract(pocket).subtract(solid).volume();
    assert.ok(thin < 0.05, `${name}: ${thin.toFixed(2)} mm³ of the walls missing`);
    // the pocket is empty, and a magnet comes up into it from 15 mm below without touching the bear
    const magnet = Manifold.cylinder(p.depth - 0.2, r - 0.1, r - 0.1, 64).translate([0, 0, -p.depth + 0.1]).transform(frame);
    const path = Manifold.hull([magnet, magnet.translate(p.axis.map((v: number) => v * 15))]);
    assert.ok(path.intersect(solid).volume() < 1e-3, `${name}: the way in is clear`);
  }
  // the bear's own left is +x
  assert.ok(profile.points.left_paw.center[0] > profile.points.right_paw.center[0] + 15);
});

for (const version of Object.keys(VERSIONS)) {
  test(`${version}: the head's channel opens once, in the base, and keeps clear of the skin`, async () => {
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
      assert.ok(mouths[0].boundingBox().max[2] < 1.5, `${name}: the mouth is in the base`);
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
      // and gets there: the magnet slides from the mouth into its seat without touching the bear
      const travel = sweep(Manifold, ch.magnet, ch.spec.seat.center, [ch.spec.mouth]);
      assert.ok(travel.intersect(b.bodySolid).subtract(ch.cut).volume() < 1e-6, `${name}: the magnet slides all the way in`);
      // the key: inside its channel and the bear, flush with the base, short of the magnet
      assert.ok(ch.key.volume() > 5000, `${name} has a key`);
      assert.ok(ch.key.subtract(ch.cut).volume() < 1e-6, `${name}: key inside the channel`);
      assert.ok(ch.key.subtract(b.bodySolid).volume() < 1e-6, `${name}: key not proud of the bear`);
      assert.ok(Math.abs(ch.key.boundingBox().min[2]) < 1e-3, `${name}: key flush with the base`);
      assert.ok(ch.key.intersect(grow(ch.magnet, 0.5)).volume() < 1e-6, `${name}: key clear of the magnet`);
      assert.equal(ch.tongue, null);
    }
    assert.deepEqual(Object.keys(b.channels), ['head'], 'the paws have no channel');
  });
}

test('the print: the painted bear in place, the keys beside it on the plate, the paint as slicer codes', async () => {
  const { firstID } = await body;
  for (const [version, built] of Object.entries(builds)) {
    const b = await built;
    const objects = layoutCharacter(b, characterPaint(b, firstID), 'bear');
    assert.deepEqual(objects.map((o) => o.name), ['bear', 'key head'], version);
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
  assert.equal(parts.length, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifold, fromManifold } from '../src/fit.ts';
import { findVoids, type Tube } from '../src/voids.ts';
import { buildGoose } from '../src/build-goose.ts';
import type { Part } from '../src/threemf-parse.ts';
import { faceAdjacency, faceNormals, floodRegion, facesUnderMask, insidePolygon } from '../src/paint-fill.ts';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] as unknown as Part['transform'];
const part = (name: string, mesh: ReturnType<typeof fromManifold>, extruder: number, color?: string): Part =>
  ({ name, kind: 'normal', mesh, local: mesh, transform: IDENTITY, group: 'g', extruder, color });

test('a round channel open at both ends is reported as a tube, not a void', async () => {
  const { Manifold } = await manifold();
  // a 20 mm block with a 3.5 mm hole straight through along x, plus a blind 6 mm pocket from the top
  const block = Manifold.cube([20, 20, 20], true)
    .subtract(Manifold.cylinder(30, 1.75, 1.75, 48, true).rotate([0, 90, 0]))
    .subtract(Manifold.cylinder(4, 3, 3, 48, false).translate(5, 5, 8));
  const tubes: Tube[] = [];
  const voids = findVoids(fromManifold(block), tubes);
  assert.equal(voids.length, 1, 'the blind pocket is the only void');
  assert.ok(Math.abs(voids[0].diameter - 6) < 0.2);
  assert.equal(tubes.length, 1, `one tube, got ${tubes.length}`);
  const t = tubes[0];
  assert.ok(Math.abs(t.radius - 1.75) < 0.1, `radius ${t.radius}`);
  assert.ok(Math.abs(t.length - 20) < 0.5, `length ${t.length}`);
  assert.ok(Math.abs(Math.abs(t.axis[0]) - 1) < 0.05, `axis ${t.axis}`);
});

test('the eye channel is plugged flush in the eye colour when the goose is built', async () => {
  const { Manifold } = await manifold();
  // a head: a 20 mm block with the 3.5 mm eye channel through it along x
  const head = Manifold.cube([20, 20, 20], true).subtract(Manifold.cylinder(30, 1.75, 1.75, 48, true).rotate([0, 90, 0])).translate(50, 50, 10);
  // two loose eyes standing on the plate: a 3.1 mm pin 3.5 mm long with a 4.5 mm dome on top
  const eye = Manifold.cylinder(3.5, 1.55, 1.55, 32, false).add(Manifold.sphere(2.25, 32).intersect(Manifold.cube([5, 5, 2.25], false).translate(-2.5, -2.5, 0)).translate(0, 0, 3.5));
  const eyes = eye.add(eye.translate(8, 0, 0));
  const parts = [part('white', fromManifold(head), 1, '#ffffff')];
  const log: string[] = [];
  const built = await buildGoose(parts, [], (s) => log.push(s), part('black.stl', fromManifold(eyes), 2, '#1a1a1a'));
  assert.ok(log.some((l) => /eyes: 2 pieces/.test(l)), log.join('\n'));
  assert.equal(built.goose.genus(), 0, 'the channel is closed');
  // the channel is filled and nothing stands proud of the faces beyond the plug's 0.3 mm lip
  assert.ok(Math.abs(built.goose.volume() - 8000) < 30, `volume ${built.goose.volume()} should be the block's (channel filled, no domes)`);
  const bb = built.goose.boundingBox();
  assert.ok(bb.min[0] > 40 - 0.5 && bb.max[0] < 60 + 0.5, `eyes flush at x ${bb.min[0]}..${bb.max[0]}`);
  // the eye material is a fourth... here second, colour
  assert.equal(built.colors.materials.length, 2);
  assert.equal(built.colors.materials[1].color, '#1a1a1a');
  const eyeFaces = built.faceMaterial.filter((m) => m === 1).length;
  assert.ok(eyeFaces > 50, `${eyeFaces} eye faces`);
});

test('bucket fill stops at creases and other colours', async () => {
  const { Manifold } = await manifold();
  const mesh = fromManifold(Manifold.cube([10, 10, 10], true));
  const adj = faceAdjacency(mesh), normals = faceNormals(mesh);
  const n = mesh.triangles.length / 3;
  const fm = new Uint8Array(n);
  // a cube has 12 faces: a fill bounded by 90° creases covers one side (2 triangles)
  const side = floodRegion(adj, normals, fm, 0, 40);
  assert.equal(side.length, 2);
  // ignoring creases it covers everything
  assert.equal(floodRegion(adj, normals, fm, 0, 180).length, 12);
  // paint one side another colour: the crease-free fill stops at it
  for (const f of side) fm[f] = 1;
  const rest = floodRegion(adj, normals, fm, side[0] === 0 ? 2 : 0, 180);
  assert.equal(rest.length, 10);
});

test('faces under a mask need more than half their pixels inside', () => {
  // a 4 x 4 screen: face 0 owns the left half, face 1 the right half, face 2 one pixel
  const ids = new Int32Array(16).fill(-1);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ids[y * 4 + x] = x < 2 ? 0 : 1;
  ids[0] = 2;
  const left = facesUnderMask(ids, 4, 4, (x) => x < 3, 3); // covers all of face 0, half of face 1 and face 2
  assert.deepEqual([...left].sort(), [0, 1, 2]);
  const strip = facesUnderMask(ids, 4, 4, (x) => x === 2, 3); // 4 of face 1's 8 pixels: exactly half counts
  assert.deepEqual([...strip], [1]);
  const corner = facesUnderMask(ids, 4, 4, (x, y) => x === 3 && y === 3, 3); // one of 8
  assert.equal(corner.length, 0);
  assert.ok(insidePolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 5, 5));
  assert.ok(!insidePolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 15, 5));
});

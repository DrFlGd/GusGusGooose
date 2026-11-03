import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifold, fromManifold } from '../src/fit.ts';
import { prepareAccessory, SIDE_ROTATION, type Side } from '../src/prepare.ts';
import { parseObj } from '../src/obj.ts';
import { loadModel } from '../src/load-model.ts';
import { serializeStl } from '../src/stl.ts';
import * as zipWrite from '../src/threemf-write.ts';

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

test('a mesh that is not a valid solid is rebuilt on a voxel grid on import', async () => {
  const { manifold, fromManifold } = await import('../src/fit.ts');
  const { serializeStl } = await import('../src/stl.ts');
  const { loadModel } = await import('../src/load-model.ts');
  const { Manifold } = await manifold();
  // a box with its +x side missing: an open mesh with a hole
  const box = fromManifold(Manifold.cube([20, 20, 20], true));
  const keep: number[] = [];
  for (let t = 0; t < box.triangles.length; t += 3) {
    const xs = [0, 1, 2].map((k) => box.positions[box.triangles[t + k] * 3]);
    if (!xs.every((x) => x > 9.9)) keep.push(box.triangles[t], box.triangles[t + 1], box.triangles[t + 2]);
  }
  assert.equal(keep.length, box.triangles.length - 6);
  const soup = serializeStl({ positions: box.positions, triangles: Uint32Array.from(keep) });
  await assert.rejects(loadModel('soup.stl', soup, { repair: false }));
  const fixed = await loadModel('soup.stl', soup, { voxel: 0.5 });
  assert.ok(fixed.repaired && fixed.repaired.parts === 1);
  assert.equal(fixed.solid.status(), 'NoError');
  // the closed box is 8000 mm³; the voxel surface is within a few percent
  assert.ok(Math.abs(fixed.solid.volume() - 8000) < 500, `volume ${fixed.solid.volume()}`);
  assert.equal(fixed.solid.decompose().length, 1);
});

test('paint_color codes decode to filament slots', async () => {
  const { paintExtruder } = await import('../src/threemf-parse.ts');
  assert.deepEqual(['', '0', '4', '8', '0C', '1C', '2C'].map(paintExtruder), [0, 0, 1, 2, 3, 4, 5]);
  // a triangle split on all three sides into four, three children in slot 1 and one in slot 2
  const encode = (bits: number[]) => { let s = ''; for (let i = 0; i < bits.length; i += 4) { let v = 0; for (let j = 0; j < 4; j++) v |= (bits[i + j] ?? 0) << j; s = v.toString(16).toUpperCase() + s; } return s; };
  assert.equal(paintExtruder(encode([1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1])), 1);
  assert.equal(paintExtruder(encode([1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1])), 2);
});

/** A Bambu-style 3MF of two 10 mm cubes side by side in slots 1 and 3, the first cube's top painted slot 2. */
function colouredCubes3mf(): Uint8Array {
  const { zipStore } = zipWrite;
  const cube = (dx: number, paintTop: boolean) => {
    const v = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10];
    const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    let s = '<mesh><vertices>';
    for (let i = 0; i < v.length; i += 3) s += `<vertex x="${v[i] + dx}" y="${v[i + 1]}" z="${v[i + 2]}"/>`;
    s += '</vertices><triangles>';
    t.forEach((tri, i) => { s += `<triangle v1="${tri[0]}" v2="${tri[1]}" v3="${tri[2]}"${paintTop && (i === 2 || i === 3) ? ' paint_color="8"' : ''}/>`; });
    return s + '</triangles></mesh>';
  };
  const model = `<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" type="model">${cube(0, true)}</object><object id="2" type="model">${cube(20, false)}</object><object id="3" type="model"><components><component objectid="1"/><component objectid="2"/></components></object></resources><build><item objectid="3"/></build></model>`;
  const settings = '<config><object id="3"><metadata key="name" value="cubes"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="a"/></part><part id="2" subtype="normal_part"><metadata key="name" value="b"/><metadata key="extruder" value="3"/></part></object></config>';
  const project = '{"filament_colour":["#FFFFFF","#FF0000","#0000FF"]}';
  const enc = new TextEncoder();
  return zipStore([['3D/3dmodel.model', enc.encode(model)], ['Metadata/model_settings.config', enc.encode(settings)], ['Metadata/project_settings.config', enc.encode(project)]]);
}

test('a 3MF keeps its filament slots and paint as materials through a boolean', async () => {
  const { fromManifoldTagged, manifold } = await import('../src/fit.ts');
  const { Manifold } = await manifold();
  const m = await loadModel('cubes.3mf', colouredCubes3mf());
  assert.equal(m.parts, 2);
  assert.ok(m.materials && m.firstID !== undefined, 'materials expected');
  assert.deepEqual(m.materials.map((x) => `${x.name} ${x.color}`), ['Filament 1 #ffffff', 'Filament 2 #ff0000', 'Filament 3 #0000ff']);
  const tagged = fromManifoldTagged(m.solid, m.firstID, m.materials.length, 9);
  const count = (fm: Uint8Array) => { const c = [0, 0, 0, 0]; for (const v of fm) c[v === 9 ? 3 : v]++; return c; };
  assert.deepEqual(count(tagged.faceMaterial), [10, 2, 12, 0]);
  assert.equal(m.fallback, 2, 'the slot with the most faces is the fallback');
  // cut the second cube in half: its new faces carry the fallback, the rest keep their colours
  const cut = m.solid.subtract(Manifold.cube([10, 20, 20], false).translate(25, -5, -5));
  const after = fromManifoldTagged(cut, m.firstID, m.materials.length, m.fallback);
  const c = count(after.faceMaterial);
  assert.equal(c[1], 2, 'painted top kept');
  assert.equal(c[0], 10, 'first cube untouched');
  assert.ok(c[2] >= 12 && c[3] === 0, `cut faces take the fallback slot: ${c}`);
  // nothing named a slot: no materials
  const plain = await loadModel('cube.stl', serializeStl(fromManifold(Manifold.cube([10, 10, 10], true))));
  assert.equal(plain.materials, undefined);
});

test('splitByMaterial makes a skin per colour and leaves the base', async () => {
  const { splitByMaterial } = await import('../src/split-colours.ts');
  const { write3mfParts } = await import('../src/threemf-write.ts');
  const { parse3mf } = await import('../src/threemf-parse.ts');
  const { Manifold } = await manifold();
  const cube = fromManifold(Manifold.cube([20, 20, 20], true).refineToLength(5));
  const n = cube.triangles.length / 3;
  const fm = new Uint8Array(n);
  const P = cube.positions, T = cube.triangles;
  for (let t = 0; t < n; t++) {
    const z = (P[T[t * 3] * 3 + 2] + P[T[t * 3 + 1] * 3 + 2] + P[T[t * 3 + 2] * 3 + 2]) / 3;
    const x = (P[T[t * 3] * 3] + P[T[t * 3 + 1] * 3] + P[T[t * 3 + 2] * 3]) / 3;
    if (z > 9.9) fm[t] = 1; else if (x < -9.9) fm[t] = 2;
  }
  const r = await splitByMaterial(cube, fm, 3, { depth: 2 });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.parts.map((p) => p.material), [0, 1, 2]);
  const vol = r.parts.map((p) => p.volume);
  assert.ok(Math.abs(vol[0] + vol[1] + vol[2] - 8000) < 1, `volumes ${vol} should sum to 8000`);
  // the top skin is 20 x 20 x 2; the side skin the same less the 2 x 2 x 20 corner the top skin took first
  assert.ok(Math.abs(vol[1] - 800) < 5, `top skin ${vol[1]}`);
  assert.ok(Math.abs(vol[2] - 720) < 5, `side skin ${vol[2]}`);
  const parts = await parse3mf(write3mfParts(r.parts.map((p) => ({ name: `m${p.material}`, mesh: p.mesh, material: p.material })), [{ name: 'a', color: '#ffffff' }, { name: 'b', color: '#ff0000' }, { name: 'c', color: '#0000ff' }], 'cube'));
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.name), ['object 2', 'object 3', 'object 4']);
});

test("the app's own painted 3MF export comes back in with its colours", async () => {
  const { fromManifoldTagged, manifold } = await import('../src/fit.ts');
  const { write3mf } = await import('../src/threemf-write.ts');
  const { Manifold } = await manifold();
  const cube = fromManifold(Manifold.cube([10, 10, 10], true));
  const n = cube.triangles.length / 3;
  const fm = new Uint8Array(n);
  fm[0] = 2; fm[1] = 2; fm[5] = 1;
  const bytes = write3mf(cube, [{ name: 'Body', color: '#e9dcc3' }, { name: 'Trim', color: '#222222' }, { name: 'Logo', color: '#d03b2f' }], fm, 'cube');
  const m = await loadModel('cube.3mf', bytes);
  assert.deepEqual(m.materials?.map((x) => `${x.name} ${x.color}`), ['Body #e9dcc3', 'Trim #222222', 'Logo #d03b2f']);
  const back = fromManifoldTagged(m.solid, m.firstID!, 3, 9);
  const c = [0, 0, 0, 0];
  for (const v of back.faceMaterial) c[v === 9 ? 3 : v]++;
  assert.deepEqual(c, [9, 1, 2, 0]);
});

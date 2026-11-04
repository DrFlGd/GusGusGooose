import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaintModel } from '../src/paint-model.ts';
import { decodePart, encodePart } from '../src/part-file.ts';
import type { IndexedMesh } from '../src/stl.ts';

const square = (): IndexedMesh => ({
  positions: Float32Array.from([-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0]),
  triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
});

test('a saved part comes back with the same mesh and the same paint, inside faces too', () => {
  const m = new PaintModel(square());
  m.paintFaces([1], 2);
  m.brush({ x: -12, y: -14, z: 0 }, 3, 3); // inside the first triangle only: it gets a tree
  assert.ok(m.trees.size > 0, 'the brush split a face');
  const bytes = encodePart(m);
  const back = decodePart(bytes.slice()); // a copy, as read from a file
  assert.deepEqual([...back.mesh.positions], [...m.mesh.positions]);
  assert.deepEqual([...back.mesh.triangles], [...m.mesh.triangles]);
  assert.deepEqual([...back.faceMaterial], [...m.faceMaterial]);
  const again = new PaintModel(back.mesh);
  again.restore(back.faceMaterial, back.trees);
  assert.deepEqual(again.paintCodes((x) => x), m.paintCodes((x) => x));
  assert.deepEqual([...again.materialsUsed()].sort(), [...m.materialsUsed()].sort());
});

test('a saved part read from the middle of a bigger buffer still decodes', () => {
  const m = new PaintModel(square());
  m.paintFaces([0], 1);
  const bytes = encodePart(m);
  const host = new Uint8Array(bytes.length + 3);
  host.set(bytes, 3);
  const back = decodePart(host.subarray(3));
  assert.deepEqual([...back.faceMaterial], [1, 0]);
});

test('restore refuses paint for another mesh', () => {
  const m = new PaintModel(square());
  assert.throws(() => m.restore(new Uint8Array(5), new Map()));
});

test('tags are split on commas, trimmed and kept once ignoring case', async () => {
  const { parseTags, matches } = await import('../src/web/library-store.ts');
  assert.deepEqual(parseTags(' red, Santa hat ,red,RED,,  santa   hat '), ['red', 'Santa hat']);
  const meta = { version: 1 as const, id: 'a', name: 'Red puck', description: 'for the head', tags: ['santa'], collection: 'christmas', kind: 'model' as const, point: 'left_wing', sourceName: 'puck.stl', created: 0, updated: 0, fitted: true, files: [] };
  assert.ok(matches(meta, 'santa head', 'Christmas'));
  assert.ok(matches(meta, 'left wing'));
  assert.ok(matches(meta, 'CHRISTMAS', 'Christmas'));
  assert.ok(!matches(meta, 'halloween', 'Christmas'));
});

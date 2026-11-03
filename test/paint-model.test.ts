import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifold, fromManifold, toManifold } from '../src/fit.ts';
import { PaintModel, triangleDistance2, nearestPoints, type LabelImage, type StampView } from '../src/paint-model.ts';
import { forEachLeaf } from '../src/paint-tree.ts';
import type { IndexedMesh } from '../src/stl.ts';

/** A flat 40 mm square in z = 0 made of two triangles, facing up. */
const square = (): IndexedMesh => ({
  positions: Float32Array.from([-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0]),
  triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
});

/** Area per material of the paint, from its baked triangles. */
function areas(model: PaintModel): Map<number, number> {
  const b = model.baked(), P = b.mesh.positions, T = b.mesh.triangles;
  const out = new Map<number, number>();
  for (let i = 0; i < T.length / 3; i++) {
    const p = [0, 1, 2].map((k) => [P[T[i * 3 + k] * 3], P[T[i * 3 + k] * 3 + 1], P[T[i * 3 + k] * 3 + 2]]);
    const u = p[1].map((x, d) => x - p[0][d]), v = p[2].map((x, d) => x - p[0][d]);
    const a = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    out.set(b.faceMaterial[i], (out.get(b.faceMaterial[i]) ?? 0) + a);
  }
  return out;
}

/** Looking straight down at the square, 10 px per mm, the square's middle at pixel (200, 200); y down on screen. */
const topView = (model: PaintModel): StampView => ({
  project: (x, y) => [200 + x * 10, 200 - y * 10],
  visible: (f, x, y) => {
    // the face under a pixel of the square: the diagonal from (-20,-20) to (20,20) splits it
    const wx = (x - 200) / 10, wy = (200 - y) / 10;
    if (Math.abs(wx) > 20 || Math.abs(wy) > 20) return false;
    const g = wx >= wy ? 0 : 1;
    return g === f || model.touches(f, g);
  },
});

test('triangle distance and nearest points', () => {
  const a = [0, 0, 0], b = [10, 0, 0], c = [0, 10, 0];
  assert.equal(triangleDistance2({ x: 2, y: 2, z: 3 }, a, b, c), 9);
  assert.equal(triangleDistance2({ x: -3, y: -4, z: 0 }, a, b, c), 25);
  assert.ok(Math.abs(triangleDistance2({ x: 10, y: 10, z: 0 }, a, b, c) - 50) < 1e-9);
  const pts = Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 5, 5, 5]);
  const near = nearestPoints(pts);
  assert.equal(near(9, 1, 0), 1);
  assert.equal(near(4, 4, 6), 3);
  assert.equal(near(-50, -50, -50), 0);
});

test('the brush paints a disc inside two big triangles without changing the mesh', () => {
  const model = new PaintModel(square());
  const n = model.brush({ x: 3, y: -2, z: 0 }, 4, 2);
  assert.equal(n, 2, 'both triangles are touched (the disc crosses the diagonal)');
  assert.equal(model.mesh.triangles.length, 6, 'the mesh keeps its two triangles');
  assert.equal(model.trees.size, 2);
  const a = areas(model);
  const disc = Math.PI * 16;
  assert.ok(Math.abs((a.get(2) ?? 0) - disc) / disc < 0.05, `painted ${a.get(2)} mm², a disc is ${disc.toFixed(1)}`);
  assert.ok(Math.abs((a.get(2) ?? 0) + (a.get(0) ?? 0) - 1600) < 1e-3);
  // a bigger brush over everything makes the triangles whole again
  model.brush({ x: 0, y: 0, z: 0 }, 40, 2);
  assert.equal(model.trees.size, 0);
  assert.deepEqual([...model.faceMaterial], [2, 2]);
});

test('undo brings back the paint before a stroke, and snapshots are not changed by later strokes', () => {
  const model = new PaintModel(square());
  model.brush({ x: 0, y: 0, z: 0 }, 5, 1);
  const before = areas(model).get(1)!;
  model.snapshot();
  model.brush({ x: 2, y: 0, z: 0 }, 5, 3);
  assert.ok(model.materialsUsed().has(3));
  assert.ok(model.undo());
  assert.ok(!model.materialsUsed().has(3));
  assert.ok(Math.abs(areas(model).get(1)! - before) < 1e-6);
  assert.equal(model.undo(), false);
});

test('a screen stamp paints sharp edges inside triangles, only where the part shows', () => {
  const model = new PaintModel(square());
  // a 100 × 60 px block (10 × 6 mm) of label 1 with a 20 px strip of label 2 inside
  const W = 400, H = 400, labels = new Int16Array(W * H).fill(-1);
  for (let y = 170; y < 230; y++) for (let x = 150; x < 250; x++) labels[y * W + x] = x >= 190 && x < 210 ? 2 : 1;
  const img: LabelImage = { labels, width: W, height: H };
  const changed = model.paintLabels(img, topView(model), [0, 1]);
  assert.equal(changed, 2);
  const a = areas(model);
  assert.ok(Math.abs((a.get(1) ?? 0) - 48) < 1.5, `label 1 covers ${a.get(1)} mm², expected 48`);
  assert.ok(Math.abs((a.get(2) ?? 0) - 12) < 1, `label 2 covers ${a.get(2)} mm², expected 12`);
  // nothing shows: nothing is painted
  const hidden = new PaintModel(square());
  const n = hidden.paintLabels(img, { project: topView(hidden).project, visible: () => false }, [0, 1]);
  assert.equal(n, 0);
  assert.equal(hidden.trees.size, 0);
});

test('the bucket fills across leaves up to another colour', () => {
  const model = new PaintModel(square());
  // a ring: paint a disc red, then its middle back to base, then bucket the middle blue
  model.brush({ x: 0, y: 0, z: 0 }, 8, 1);
  model.brush({ x: 0, y: 0, z: 0 }, 5, 0);
  // find the leaf at the very middle
  let leafAtMiddle = -1, face = 0;
  for (const [f, t] of model.trees) {
    let k = 0;
    forEachLeaf(t, (l) => {
      const pts = l.v.map((w) => model.point(f, w));
      const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
      if (leafAtMiddle < 0 && Math.hypot(cx, cy) < 4 && l.material === 0) { leafAtMiddle = k; face = f; }
      k++;
    });
  }
  assert.ok(leafAtMiddle >= 0);
  const changed = model.bucket(face, leafAtMiddle, 2, 180);
  assert.ok(changed >= 1);
  const a = areas(model);
  assert.ok(Math.abs((a.get(2) ?? 0) - Math.PI * 25) / (Math.PI * 25) < 0.06, `middle ${a.get(2)}`);
  assert.ok(Math.abs((a.get(1) ?? 0) - Math.PI * 39) / (Math.PI * 39) < 0.06, `ring ${a.get(1)}`);
  // the outside, base, is untouched
  assert.ok((a.get(0) ?? 0) > 1600 - Math.PI * 64 - 10);
});

test('paint inside triangles bakes to a closed solid and writes slicer codes', async () => {
  const { Manifold } = await manifold();
  const mesh = fromManifold(Manifold.cube([20, 20, 20], true));
  const model = new PaintModel(mesh);
  model.brush({ x: 0, y: 0, z: 10 }, 4, 1);
  model.brush({ x: 10, y: 3, z: 3 }, 3, 2);
  assert.ok(model.trees.size >= 3);
  const solid = await toManifold(model.baked().mesh);
  assert.ok(Math.abs(solid.volume() - 8000) < 1e-2);
  const codes = model.paintCodes((m) => (m ? m + 1 : 0));
  assert.equal(codes.length, 12);
  for (const [f] of model.trees) assert.ok(codes[f].length > 1, `split face ${f} has a long code`);
  assert.ok(codes.some((c) => c === ''), 'unpainted faces have no code');
});

test('paint inside triangles survives a 3MF export and import', async () => {
  const { Manifold } = await manifold();
  const { write3mf } = await import('../src/threemf-write.ts');
  const { loadModel } = await import('../src/load-model.ts');
  const { fromManifoldTagged } = await import('../src/fit.ts');
  const mesh = fromManifold(Manifold.cube([20, 20, 20], true));
  const model = new PaintModel(mesh);
  model.brush({ x: 0, y: 0, z: 10 }, 5, 1); // a disc on the top
  model.brush({ x: 10, y: 0, z: 0 }, 3, 2); // and a smaller one on a side
  const palette = [{ name: 'Base', color: '#ffffff' }, { name: 'Red', color: '#ff0000' }, { name: 'Blue', color: '#0000ff' }];
  const bytes = write3mf(mesh, palette, model.faceMaterial, 'cube', model.paintCodes((m) => (m ? m + 1 : 0)));
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /paint_color="[0-9A-F]{3,}"/, 'split codes are written');
  assert.match(text, /slic3rpe:mmu_segmentation="/);
  const loaded = await loadModel('cube.3mf', bytes);
  assert.deepEqual(loaded.materials!.map((m) => m.color), ['#ffffff', '#ff0000', '#0000ff']);
  const tagged = fromManifoldTagged(loaded.solid, loaded.firstID!, 3, 0);
  const back = new PaintModel(tagged.mesh);
  back.setFaces(tagged.faceMaterial);
  const a = areas(back), want = areas(model);
  for (const m of [1, 2]) assert.ok(Math.abs((a.get(m) ?? 0) - (want.get(m) ?? 0)) < 0.01, `colour ${m}: ${a.get(m)} vs ${want.get(m)}`);
  assert.ok(Math.abs(loaded.solid.volume() - 8000) < 0.01);
});

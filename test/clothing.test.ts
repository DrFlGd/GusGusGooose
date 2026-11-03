import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifold, fromManifold } from '../src/fit.ts';
import { bodyProfile, cavityProfile, contourGarment, wrapGarment, wrapFrame, neckShear, DEFAULT_GARMENT } from '../src/clothing.ts';

// a stand-in goose: a fat body (ellipsoid), a thin neck, a head with a beak sticking forward (-y)
async function bird() {
  const { Manifold } = await manifold();
  const body = Manifold.sphere(30, 64).scale([1, 1.4, 1]).translate(0, 0, 40);
  const neck = Manifold.cylinder(60, 7, 7, 48, false).translate(0, -20, 60);
  const head = Manifold.sphere(13, 48).translate(0, -20, 120);
  const beak = Manifold.cylinder(22, 5, 2, 32, false).rotate([90, 0, 0]).translate(0, -22, 118);
  return Manifold.union([body, neck, head, beak]);
}

test('body profile measures radius per angle', async () => {
  const { Manifold } = await manifold();
  const cyl = Manifold.cylinder(20, 10, 10, 96, false).translate(3, -2, 0);
  const p = bodyProfile(cyl, 5, 5, 36, [0, 0]);
  // from (0,0), the far wall of a radius-10 circle centred at (3,-2) is between 7 and 13.6 away
  const row = Array.from(p.r[0]);
  assert.ok(Math.min(...row) > 6.3 && Math.max(...row) < 13.7, `radii ${Math.min(...row)}..${Math.max(...row)}`);
  // along +x the wall is at 3 + sqrt(100 - 4)
  assert.ok(Math.abs(row[0] - (3 + Math.sqrt(96))) < 0.05, `r(0) = ${row[0]}`);
});

test('contour shirt clears the body, has no undercuts and a collar bigger than the neck', async () => {
  const goose = await bird();
  const g = await contourGarment(goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4 });
  assert.equal(g.solid.status(), 'NoError');
  assert.equal(g.solid.decompose().length, 1);
  assert.ok(g.solid.volume() > 0);
  assert.ok(g.solid.intersect(goose).volume() < 2, `overlaps the body by ${g.solid.intersect(goose).volume()} mm³`);
  // every inner ring contains the ring above it
  const cav = cavityProfile(goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4 });
  for (let k = 0; k + 1 < cav.inner.z.length; k++) for (let i = 0; i < cav.inner.nTheta; i++) {
    assert.ok(cav.inner.r[k][i] >= cav.inner.r[k + 1][i] - 1e-4, `undercut at ring ${k} angle ${i}`);
  }
  // collar: at least neck radius + clearance + gap everywhere
  for (const h of cav.neckRing) assert.ok(h >= 7 + 0.4 + 1 - 0.05, `collar too tight: ${h}`);
  // drop mode: the collar and every section pass the head and beak
  const drop = cavityProfile(goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4, collar: 'drop' });
  for (let i = 0; i < drop.inner.nTheta; i++) assert.ok(drop.hole[i] >= drop.headProjection[i] + 0.4 - 1e-3);
  assert.ok(Math.max(...drop.hole) >= Math.max(...cav.hole) - 1e-6, 'drop collar should be at least as wide as the tilt collar');
});

test('wrapping a simple sweater keeps its features and hollows it for the body', async () => {
  const { Manifold } = await manifold();
  const goose = await bird();
  // a tapered tube with a button on the front, hem at z = 0
  let sweater = Manifold.cylinder(30, 14, 10, 64, false).subtract(Manifold.cylinder(32, 12.5, 8.5, 64, false).translate(0, 0, -1));
  sweater = sweater.add(Manifold.sphere(1.5, 16).translate(0, -12, 15));
  const g = await wrapGarment(sweater, goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4 });
  assert.equal(g.mode, 'shell');
  assert.equal(g.solid.status(), 'NoError');
  assert.ok(g.solid.intersect(goose).volume() < 2, 'wrapped sweater overlaps the body');
  const bb = g.solid.boundingBox();
  assert.ok(bb.min[2] > 24 && bb.max[2] < 66.5, `z ${bb.min[2]}..${bb.max[2]}`);
  // its wall has about the sweater's thickness: volume is near surface area x 1.5
  const shell = await contourGarment(goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4, collar: 'tilt', collarGap: 0 });
  assert.ok(g.solid.volume() > 0.6 * shell.solid.volume() && g.solid.volume() < 1.6 * shell.solid.volume(), `volume ${g.solid.volume()} vs shell ${shell.solid.volume()}`);
  void fromManifold;
});

test('the axis leans to the neck, and the preview frame lands the model between hem and neck', async () => {
  const { Manifold } = await manifold();
  const goose = await bird();
  // the bird's neck is 20 mm in front (-y) of its body, 40 mm above the hem
  const s = neckShear(goose, { ...DEFAULT_GARMENT, hem: 25, neck: 65 });
  assert.ok(Math.abs(s.sy + 0.5) < 0.08 && Math.abs(s.sx) < 0.05, `shear ${JSON.stringify(s)}`);
  assert.equal(neckShear(goose, { ...DEFAULT_GARMENT, hem: 25, neck: 65, axisToNeck: 0 }).sy, 0);
  // the wrapped sweater's collar moves toward the neck (the bird's shoulders still reach above the collar height, so not all the way)
  const sweater = Manifold.cylinder(30, 14, 10, 64, false).subtract(Manifold.cylinder(32, 12.5, 8.5, 64, false).translate(0, 0, -1));
  const collarY = async (axisToNeck: number) => {
    const g = await wrapGarment(sweater, goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4, axisToNeck });
    assert.ok(g.solid.intersect(goose).volume() < 2, `overlaps the body with lean ${axisToNeck}`);
    const top = g.solid.slice(64.5).toPolygons().flat();
    return top.reduce((a, p) => a + p[1], 0) / top.length;
  };
  // the front stays the front (the bird faces -y) whatever the lean
  for (const axisToNeck of [0, 0.5, 1]) {
    const deg = (cavityProfile(goose, { hem: 25, neck: 65, axisToNeck }).front * 180) / Math.PI;
    const off = ((deg + 90 + 540) % 360) - 180; // signed difference from -90
    assert.ok(Math.abs(off) < 20, `front ${deg} degrees with lean ${axisToNeck}`);
  }
  const leaned = await collarY(1), straight = await collarY(0);
  assert.ok(leaned < straight - 3, `collar centre y: leaned ${leaned}, straight ${straight}`);
  const g = await wrapGarment(sweater, goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4 });
  // cropping and the preview frame
  const cav = cavityProfile(goose, { hem: 25, neck: 65 });
  const f = wrapFrame(sweater, cav, { hem: 25, neck: 65, garmentBand: [5, 25] });
  assert.ok(f.matrix.every((v) => Number.isFinite(v)));
  assert.ok(Math.abs(f.heightScale - 2) < 1e-6, `height scale ${f.heightScale}`);
  const cropped = await wrapGarment(sweater, goose, { hem: 25, neck: 65, garmentBand: [5, 25], garmentCrop: [0, 0, 0, 10] });
  assert.ok(cropped.solid.volume() > 0 && cropped.solid.volume() < g.solid.volume());
  // a neck spread opens the collar out at the top and leaves the hem alone
  const spreadCav = cavityProfile(goose, { hem: 25, neck: 65, neckSpread: 4, neckSpreadHeight: 15 }), plainCav = cavityProfile(goose, { hem: 25, neck: 65 });
  const last = spreadCav.inner.r.length - 1;
  assert.ok(spreadCav.inner.r[last][0] - plainCav.inner.r[last][0] > 3.5, 'collar ring should be about 4 mm wider');
  assert.ok(Math.abs(spreadCav.inner.r[0][0] - plainCav.inner.r[0][0]) < 1e-6, 'hem ring should be unchanged');
  // a liner adds a smooth layer under the model: more material, still clear of the body, one piece
  const lined = await wrapGarment(sweater, goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4, liner: 1.2 });
  assert.ok(lined.solid.volume() > g.solid.volume() * 1.3, `lined ${lined.solid.volume()} vs plain ${g.solid.volume()}`);
  assert.ok(lined.solid.intersect(goose).volume() < 2, 'liner overlaps the body');
  assert.equal(lined.solid.decompose().length, 1);
});

test('a split form-fit shirt comes as two halves with magnet pockets', async () => {
  const goose = await bird();
  const g = await contourGarment(goose, { hem: 25, neck: 65, thickness: 1.5, clearance: 0.4, formFit: true, split: 'sides', splitMagnets: 2 });
  assert.ok(g.parts && g.parts.length === 2, `parts: ${g.parts?.length}`);
  for (const p of g.parts!) assert.equal(p.status(), 'NoError');
  // the halves together are the whole, and no half crosses the cut plane (x = 0 for this bird, whose front is -y)
  const whole = g.parts![0].add(g.parts![1]);
  assert.ok(Math.abs(whole.volume() - g.solid.volume()) < 1, `halves ${whole.volume()} vs whole ${g.solid.volume()}`);
  const [a, b] = g.parts!.map((p) => p.boundingBox());
  assert.ok((a.max[0] < 0.5 && b.min[0] > -0.5) || (b.max[0] < 0.5 && a.min[0] > -0.5), `halves overlap in x: ${a.min[0]}..${a.max[0]} and ${b.min[0]}..${b.max[0]}`);
  assert.ok(g.warnings.some((w) => w.includes('4 magnet pockets')), g.warnings.join('; '));
  // form fit follows the body in: below the bird's widest point the cavity is narrower than the drop-on shape
  const snug = cavityProfile(goose, { hem: 25, neck: 65, formFit: true }), loose = cavityProfile(goose, { hem: 25, neck: 65 });
  const mean = (row: Float32Array) => Array.from(row).reduce((a, v) => a + v, 0) / row.length;
  assert.ok(mean(snug.inner.r[0]) < mean(loose.inner.r[0]) - 2, `hem ring: form fit ${mean(snug.inner.r[0])} vs drop-on ${mean(loose.inner.r[0])}`);
  assert.ok(g.solid.intersect(goose).volume() < 2, 'form fit overlaps the body');
});

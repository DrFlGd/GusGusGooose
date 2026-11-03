import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manifold, fitAccessory, fromManifoldTagged, toManifold, type FitProfile } from '../src/fit.ts';
import { parseStl } from '../src/stl.ts';
import { buildFlat, poleOf, svgDesign, DEFAULT_FLAT, type FlatDesign } from '../src/flat.ts';
import { createRaster, traceImage } from '../src/vendor/trace.ts';
import { parseSvg } from '../src/vendor/svg.ts';

/** A candy-cane-like picture: a 40 x 100 px red rectangle with three white stripes, on a transparent ground. */
function caneRaster() {
  const img = createRaster(60, 120);
  for (let y = 10; y < 110; y++) for (let x = 10; x < 50; x++) {
    const stripe = Math.floor((y - 10) / 20) % 2 === 1;
    img.data.set(stripe ? [255, 255, 255, 255] : [220, 30, 40, 255], (y * 60 + x) * 4);
  }
  return img;
}

test('a two-colour picture traces to two regions and one silhouette', () => {
  const t = traceImage(caneRaster(), { colors: 3, background: false, minPixels: 10 });
  assert.equal(t.regions.length, 2, `regions ${t.regions.map((r) => r.color).join(' | ')}`);
  assert.ok(t.silhouette.length >= 1);
  const [r, w] = t.regions;
  assert.ok(r.pixels > w.pixels, 'red is the bigger region');
  assert.ok(r.color[0] > 180 && w.color[1] > 200);
});

test('a flat accessory has a plate, inlays per colour, a puck under it and fits a wing', async () => {
  const design: FlatDesign = { ...traceImage(caneRaster(), { colors: 3, background: false, minPixels: 10 }) };
  const r = await buildFlat(design, { ...DEFAULT_FLAT, width: 20, depth: 3, inlayDepth: 0.6, sides: 'both', mount: { kind: 'puck', orientation: 'flat', diameter: 18, height: 4 } });
  assert.equal(r.materials.length, 2);
  assert.ok(Math.abs(r.size[0] - 20) < 0.1 && Math.abs(r.size[1] - 50) < 0.5, `size ${r.size}`);
  const bb = r.solid.boundingBox();
  assert.ok(Math.abs(bb.min[2]) < 1e-6 && Math.abs(bb.max[2] - 7) < 0.01, `z ${bb.min[2]}..${bb.max[2]}`);
  // plate 20 x 50 x 3 plus an 18 mm puck 4 tall
  const expected = 20 * 50 * 3 + Math.PI * 81 * 4;
  assert.ok(Math.abs(r.solid.volume() - expected) < expected * 0.03, `volume ${r.solid.volume()} vs ${expected}`);
  // the white stripes are the second material, on both faces
  const tagged = fromManifoldTagged(r.solid, r.firstID, r.materials.length, 0);
  let white = 0, whiteTop = 0, whiteBottom = 0;
  for (let f = 0; f < tagged.faceMaterial.length; f++) {
    if (tagged.faceMaterial[f] !== 1) continue;
    white++;
    const z = tagged.mesh.positions[tagged.mesh.triangles[f * 3] * 3 + 2];
    if (z > 6.9) whiteTop++; else if (z < 4.1) whiteBottom++;
  }
  assert.ok(white > 10 && whiteTop > 0 && whiteBottom > 0, `white faces ${white} top ${whiteTop} bottom ${whiteBottom}`);
  // the puck is inside the picture
  assert.ok(Math.abs(r.mountAt[0]) < 1 && Math.abs(r.mountAt[1]) < 26, `mount at ${r.mountAt}`);
  // it fits the wing like any accessory: the pocket lands in the puck
  const goose = await toManifold(parseStl(readFileSync('goose/goose.stl')));
  const profile: FitProfile = JSON.parse(readFileSync('goose/profile.json', 'utf8'));
  const fit = await fitAccessory(goose, r.solid, profile, { point: 'left_wing', sink: 1, spin: 0, offset: [0, 0] });
  assert.equal(fit.bodies, 1);
  assert.ok(fit.volumeAfter < fit.volumeBefore - 300, `pocket and carve removed ${fit.volumeBefore - fit.volumeAfter}`);
  assert.ok(!fit.warnings.some((w) => /floor/.test(w)), fit.warnings.join('; '));
});

test('a standing picture has its puck under the bottom edge and the face vertical', async () => {
  const design: FlatDesign = { ...traceImage(caneRaster(), { colors: 3, background: false, minPixels: 10 }) };
  const r = await buildFlat(design, { ...DEFAULT_FLAT, width: 20, depth: 3, mount: { kind: 'puck', orientation: 'standing', diameter: 14, height: 5 } });
  const bb = r.solid.boundingBox();
  assert.ok(Math.abs(bb.min[2]) < 1e-6, 'base at z = 0');
  assert.ok(bb.max[2] > 50 && bb.max[2] < 56, `stands ${bb.max[2]} tall`);
  assert.ok(bb.max[1] - bb.min[1] < 14.1, `thin in y: ${bb.max[1] - bb.min[1]}`);
  assert.ok(r.solid.decompose().length === 1, 'one body');
});

test('an SVG becomes a design with one region per fill and the pole sits inside', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect x="10" y="10" width="80" height="40" fill="#ff0000"/><circle cx="50" cy="30" r="10" fill="white"/></svg>`;
  const doc = parseSvg(svg);
  const d = svgDesign(doc.shapes);
  assert.equal(d.regions.length, 2);
  assert.deepEqual(d.regions[1].color, [255, 255, 255]);
  const pole = poleOf(d.regions[0].contours);
  assert.ok(pole[0] > 28 && pole[0] < 72 && Math.abs(pole[1] - 30) < 3, `pole ${pole}`);
});

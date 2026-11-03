// Headless smoke test of the built app: loads the goose, fits a puck,
// cuts a hole, and saves screenshots. Run `npx vite build` first.
//
//   node scripts/smoke.mjs [outdir]

import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'smoke-out';
mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4173, strictPort: true } });
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const status = () => page.locator('#status').textContent();
await page.goto(base);
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Goose loaded'), null, { timeout: 60000 });
console.log('1.', await status());
await page.screenshot({ path: join(out, '1-loaded.png') });

// a puck accessory: 18 mm dia x 8 mm, built here so the test needs no fixture file
const puck = puckStl(9, 8, 64);
writeFileSync(join(out, 'puck.stl'), puck);
await page.setInputFiles('#accessory-file', { name: 'puck.stl', mimeType: 'application/octet-stream', buffer: Buffer.from(puck) });
await page.waitForFunction(() => document.getElementById('status').textContent.includes('Place it'), null, { timeout: 30000 });
console.log('2.', await status());
await page.selectOption('#point', 'head');
await page.screenshot({ path: join(out, '2-placed.png') });
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('3.', await page.locator('#fit-result').textContent());
await page.screenshot({ path: join(out, '3-fitted.png') });

// generated base: a dome on the left wing
await page.click('#generator summary');
await page.selectOption('#gen-shape', 'dome');
await page.fill('#gen-w', '22');
await page.click('#generate');
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Base generated'), null, { timeout: 30000 });
await page.selectOption('#point', 'left_wing');
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('3b.', await page.locator('#fit-result').textContent());
await page.screenshot({ path: join(out, '3b-dome-wing.png') });

// paint: refine, drag a stroke across the fitted dome, export a 3MF
await page.click('.tabs button[data-tab="paint"]');
await page.click('#refine');
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Refined'), null, { timeout: 60000 });
console.log('3c.', await status());
await page.evaluate(() => { document.querySelector('#palette .swatch:nth-child(3)').click(); });
// the left wing faces away from the default camera; paint the head puck instead
await page.click('.tabs button[data-tab="accessory"]');
await page.selectOption('#point', 'head');
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
await page.click('.tabs button[data-tab="paint"]');
// stroke across the top of the head puck (its top face is 8 mm up the magnet axis, minus the 2 mm sink)
const [sx, sy, ex, ey] = await page.evaluate(() => {
  const h = window.__goose.profile.points.head;
  const top = h.center.map((c, i) => c + h.axis[i] * 6);
  const a = window.__goose.toScreen([top[0] - 6, top[1], top[2]]);
  const b = window.__goose.toScreen([top[0] + 6, top[1], top[2]]);
  return [...a, ...b];
});
await page.mouse.move(sx, sy);
await page.mouse.down();
await page.mouse.move(ex, ey, { steps: 12 });
await page.mouse.up();
const paintedFaces = await page.evaluate(() => document.getElementById('paint-info').textContent);
console.log('3d. after stroke:', paintedFaces);
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#export-3mf')]);
const threemf = join(out, 'accessory.3mf');
await download.saveAs(threemf);
console.log('3e.', await status(), '→', threemf);
await page.screenshot({ path: join(out, '3c-painted.png') });
await page.click('.tabs button[data-tab="accessory"]');

// a downloaded model: a 3MF with two parts, dropped in, flipped, scaled to 20 mm wide, with a plug
const { write3mf } = await import('../src/threemf-write.ts');
const { fromManifold, manifold } = await import('../src/fit.ts');
const { Manifold } = await manifold();
const hollow = Manifold.sphere(15, 32).subtract(Manifold.sphere(13, 32)).intersect(Manifold.cube([40, 40, 20], true).translate(0, 0, -10)); // open side up
const hollowMesh = fromManifold(hollow);
const threeMf = write3mf(hollowMesh, [{ name: 'Grey', color: '#888888' }], new Uint8Array(hollowMesh.triangles.length / 3), 'hollow dome');
await page.click('.tabs button[data-tab="accessory"]');
await page.setInputFiles('#accessory-file', { name: 'dome.3mf', mimeType: 'application/octet-stream', buffer: Buffer.from(threeMf) });
await page.waitForFunction(() => document.getElementById('status').textContent.includes('after preparing'), null, { timeout: 30000 });
console.log('6.', await page.locator('#model-info').textContent());
await page.selectOption('#prep-down', '+z');
await page.fill('#prep-width', '20');
await page.fill('#prep-plug-d', '14');
await page.dispatchEvent('#prep-plug-d', 'change');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('scaled'), null, { timeout: 30000 });
console.log('6b.', await status());
await page.selectOption('#point', 'head');
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('6c.', await page.locator('#fit-result').textContent());
await page.screenshot({ path: join(out, '6-imported-dome.png') });

// clothing: a shirt, then the dome wrapped as a garment
await page.click('.tabs button[data-tab="clothing"]');
await page.click('#make-shirt');
await page.waitForFunction(() => document.getElementById('cloth-result').textContent.startsWith('Done'), null, { timeout: 120000 });
console.log('7.', await page.locator('#cloth-result').textContent());
await page.screenshot({ path: join(out, '7-shirt.png') });
await page.click('#wrap-garment');
await page.waitForFunction(() => document.getElementById('cloth-result').textContent.startsWith('Done') && !document.getElementById('cloth-result').textContent.includes('shirt'), null, { timeout: 120000 }).catch(() => {});
await page.waitForFunction(() => !document.getElementById('wrap-garment').disabled, null, { timeout: 120000 });
console.log('7b.', await status(), '|', await page.locator('#cloth-result').textContent());
await page.screenshot({ path: join(out, '7b-wrapped.png') });
const [clothDl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#export-cloth')]);
console.log('7c. exported', clothDl.suggestedFilename());

// magnet hole: click the middle of the view, which lands on the goose body
await page.click('.tabs button[data-tab="hole"]');
const box = await page.locator('#view canvas').boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForFunction(() => document.getElementById('pick').textContent.startsWith('Picked'), null, { timeout: 5000 });
console.log('4.', await page.locator('#pick').textContent());
await page.selectOption('#hole-mode', 'embedded');
await page.click('#cut-hole');
await page.waitForFunction(() => document.getElementById('hole-result').textContent.includes('cut'), null, { timeout: 120000 });
console.log('5.', await page.locator('#hole-result').textContent());
await page.screenshot({ path: join(out, '4-hole.png') });

await browser.close();
await server.close();
if (errors.length) { console.log('console errors:\n' + errors.join('\n')); process.exit(1); }
console.log('ok, no console errors');

function puckStl(r, h, n) {
  const tris = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    const p0 = [r * Math.cos(a), r * Math.sin(a)], p1 = [r * Math.cos(b), r * Math.sin(b)];
    tris.push([[0, 0, 0], [p1[0], p1[1], 0], [p0[0], p0[1], 0]]);
    tris.push([[0, 0, h], [p0[0], p0[1], h], [p1[0], p1[1], h]]);
    tris.push([[p0[0], p0[1], 0], [p1[0], p1[1], 0], [p1[0], p1[1], h]]);
    tris.push([[p0[0], p0[1], 0], [p1[0], p1[1], h], [p0[0], p0[1], h]]);
  }
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const v of t) { buf.writeFloatLE(v[0], o); buf.writeFloatLE(v[1], o + 4); buf.writeFloatLE(v[2], o + 8); o += 12; }
    o += 2;
  }
  return buf;
}

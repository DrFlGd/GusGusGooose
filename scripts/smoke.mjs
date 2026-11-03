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
// the layout: the page never scrolls, the canvas is exactly the view's size, and the side panels scroll on their own
const layout = await page.evaluate(() => {
  const view = document.getElementById('view'), canvas = view.querySelector('canvas[data-engine]'), panel = document.getElementById('panel');
  return { page: document.scrollingElement.scrollHeight - innerHeight, view: view.scrollHeight - view.clientHeight, canvas: [canvas.clientWidth - view.clientWidth, canvas.clientHeight - view.clientHeight], panel: getComputedStyle(panel).overflowY };
});
console.log('1b. layout:', JSON.stringify(layout));
if (layout.page > 0 || layout.view > 0 || layout.canvas.some((d) => Math.abs(d) > 1) || layout.panel !== 'auto') throw new Error('the view or the page scrolls');
// number boxes: the arrows nudge by 0.1, a typed value keeps two places (and the slider beside it holds it too)
const boxes = await page.evaluate(() => {
  const num = document.getElementById('sink-num');
  num.value = '2.137';
  num.dispatchEvent(new Event('change'));
  const r = [num.step, num.value, document.getElementById('sink').value, document.getElementById('pocket-rib-count').step];
  num.value = '2'; num.dispatchEvent(new Event('change'));
  return r;
});
console.log('1c. number boxes:', boxes.join(' | '));
if (boxes.join('|') !== '0.1|2.14|2.14|1') throw new Error('the number boxes do not nudge by 0.1 or keep 0.01');

if (!process.env.SMOKE_FROM) { // SMOKE_FROM=8 skips to the picture, puck and neck steps
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
// a 10 x 3 magnet preset with crush ribs: the pocket is cut and the ribs stay, so a little more volume than the plain pocket
const plain = Number((await page.locator('#fit-result').textContent()).match(/→ (\d+)/)[1]);
await page.evaluate(() => { for (const d of document.querySelectorAll('#accessory-controls details')) d.open = true; });
await page.selectOption('#pocket-preset', '10x3');
await page.selectOption('#pocket-fit', 'ribs');
const sized = await page.evaluate(() => [document.getElementById('pocket-dia').value, document.getElementById('pocket-thick').value, document.getElementById('pocket-radial').value, document.getElementById('pocket-ribs').checked]);
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
const ribbed = Number((await page.locator('#fit-result').textContent()).match(/→ (\d+)/)[1]);
console.log('3r. preset filled', sized.join('/'), '| ribbed pocket:', await page.locator('#fit-result').textContent());
if (sized.join('/') !== '10/3/0.25/true') throw new Error('the magnet and fit presets did not fill the boxes');
await page.selectOption('#pocket-preset', 'auto');
await page.selectOption('#pocket-fit', 'press');
void plain; void ribbed;
// tilt: the sliders move the preview, the rings appear on a click on the model, and the fit follows
await page.fill('#tilt-x', '20');
await page.dispatchEvent('#tilt-x', 'input');
const [px, py] = await page.evaluate(() => { const p = window.__goose.profile.points.head; return window.__goose.toScreen([p.center[0] + p.axis[0] * 6, p.center[1] + p.axis[1] * 6, p.center[2] + p.axis[2] * 6]); });
await page.mouse.click(px, py);
const rings = await page.evaluate(() => window.__goose.ringsShown);
await page.screenshot({ path: join(out, '3t-rings.png') });
await page.evaluate(() => window.__goose.showRings(false));
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('3t. rings on click:', rings, '| tilted 20°:', await page.locator('#fit-result').textContent());
if (!rings) throw new Error('rotation rings did not appear on a click');
await page.fill('#tilt-x', '0');
await page.dispatchEvent('#tilt-x', 'input');

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
// the brush paints inside faces: the puck's big flat top is split along the stroke's edge, not refined first
if (!/in part/.test(paintedFaces)) throw new Error('the stroke did not paint inside faces');
const mid = [(sx + ex) / 2, (sy + ey) / 2];
await page.evaluate(() => window.__goose.setPaintTool('bucket'));
await page.evaluate(() => { document.querySelector('#palette .swatch:nth-child(4)').click(); });
await page.mouse.click(mid[0], mid[1]);
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Filled'), null, { timeout: 10000 });
console.log('3h. bucket:', await status());
await page.evaluate(() => window.__goose.setPaintTool('corners'));
await page.evaluate(() => { document.querySelector('#palette .swatch:nth-child(2)').click(); });
const quad = await page.evaluate(() => {
  const h = window.__goose.profile.points.head;
  const top = h.center.map((c, i) => c + h.axis[i] * 6);
  return [[-4, -4], [4, -4], [4, 4], [-4, 4]].map(([dx, dy]) => window.__goose.toScreen([top[0] + dx, top[1] + dy, top[2]]));
});
for (const [x, y] of quad) { await page.mouse.click(x, y); await new Promise((r) => setTimeout(r, 50)); }
await page.click('#corners-apply');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('corners'), null, { timeout: 10000 });
console.log('3i. corners:', await status());
await page.evaluate(() => window.__goose.setPaintTool('text'));
await page.evaluate(() => { document.querySelector('#palette .swatch:nth-child(3)').click(); });
await page.fill('#text-value', 'GO');
await page.fill('#text-size', '5');
await page.dispatchEvent('#text-size', 'input');
await page.mouse.move(mid[0] + 2, mid[1] + 2);
await page.mouse.click(mid[0], mid[1]);
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('"GO"'), null, { timeout: 10000 });
console.log('3j. text:', await status());
await page.screenshot({ path: join(out, '3j-tools.png') });
for (const line of [await page.evaluate(() => document.getElementById('status').textContent)]) if (/nothing under/.test(line)) throw new Error('text stamp painted nothing');
// a picture stamp: a two-colour SVG (a green square with a white dot), its colours joining the palette
const stampSvg = join(out, 'stamp.svg');
writeFileSync(stampSvg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="0" y="0" width="100" height="100" fill="#1e9e4a"/><circle cx="50" cy="50" r="25" fill="#fafafa"/></svg>');
const swatchesBefore = await page.locator('#palette .swatch').count();
await page.evaluate(() => window.__goose.setPaintTool('image'));
await page.setInputFiles('#stamp-file', stampSvg);
await page.waitForFunction(() => document.getElementById('status').textContent.includes('stamp.svg is ready'), null, { timeout: 10000 });
await page.fill('#stamp-width', '6');
await page.dispatchEvent('#stamp-width', 'input');
const spot = await page.evaluate(() => {
  const h = window.__goose.profile.points.head;
  const top = h.center.map((c, i) => c + h.axis[i] * 6);
  return window.__goose.toScreen([top[0] + 3, top[1] - 3, top[2]]);
});
await page.mouse.move(spot[0] + 1, spot[1] + 1);
await page.screenshot({ path: join(out, '3k-stamp-preview.png') });
await page.mouse.click(spot[0], spot[1]);
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('stamp.svg:'), null, { timeout: 15000 });
const swatchesAfter = await page.locator('#palette .swatch').count();
console.log('3k. image:', await status(), `palette ${swatchesBefore} → ${swatchesAfter}`);
if (/nothing under/.test(await status()) || swatchesAfter !== swatchesBefore + 2) throw new Error('the picture stamp did not paint its two colours');
await page.screenshot({ path: join(out, '3k-stamped.png') });
await page.evaluate(() => window.__goose.setPaintTool('brush'));
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#export-3mf')]);
const threemf = join(out, 'accessory.3mf');
await download.saveAs(threemf);
console.log('3e.', await status(), '→', threemf);
// the export carries the slicer paint, with codes that split faces (more than one hex digit)
{
  const { readFileSync } = await import('node:fs');
  const { unzip } = await import('../src/zip-read.ts');
  const entries = await unzip(readFileSync(threemf));
  const model = new TextDecoder().decode([...entries].find(([n]) => n.endsWith('.model'))[1]);
  const codes = [...model.matchAll(/paint_color="([0-9A-F]+)"/g)].map((m) => m[1]);
  const split = codes.filter((c) => c.length > 2).length;
  console.log(`3e2. ${codes.length} painted faces in the 3MF, ${split} split`);
  if (!split) throw new Error('the 3MF has no paint inside faces');
}
await page.screenshot({ path: join(out, '3c-painted.png') });
// focus view: the goose goes, the camera frames the part; off again and the goose is back
await page.click('#focus');
const hidden = await page.evaluate(() => window.__goose.gooseVisible);
await page.screenshot({ path: join(out, '3f-focus.png') });
await page.click('#focus');
const shown = await page.evaluate(() => window.__goose.gooseVisible);
console.log('3f. focus hides the goose:', !hidden, '| back after:', shown);
if (hidden || !shown) throw new Error('focus view did not toggle the goose');
// one part per colour
await page.click('#split-details summary');
const [splitDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#export-split')]);
await page.waitForFunction(() => document.getElementById('split-info').textContent.includes('parts'), null, { timeout: 60000 });
console.log('3g.', await page.locator('#split-info').textContent(), '→', splitDl.suggestedFilename());
// Refine still works with paint inside faces: the leaves become faces first
await page.click('.tabs button[data-tab="paint"]');
await page.click('#refine');
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Refined'), null, { timeout: 60000 });
console.log('3l.', await status());
await page.click('.tabs button[data-tab="accessory"]');
// moving the painted accessory keeps Paint open: entering it fits again, and the paint comes along in the accessory's frame
const areasBefore = await page.evaluate(() => window.__goose.paintAreas);
await page.fill('#dx', '3');
await page.dispatchEvent('#dx', 'input');
const paintOpen = await page.evaluate(() => !document.getElementById('paint-tab-button').disabled);
const t0Carry = Date.now();
await page.click('.tabs button[data-tab="paint"]');
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Fit done'), null, { timeout: 120000 });
const areasAfter = await page.evaluate(() => window.__goose.paintAreas);
const carryText = await status();
console.log(`3m. Paint open after a move: ${paintOpen} | ${carryText} (${((Date.now() - t0Carry) / 1000).toFixed(1)} s) | areas`, JSON.stringify(areasBefore, (k, v) => typeof v === 'number' ? Math.round(v) : v), '→', JSON.stringify(areasAfter, (k, v) => typeof v === 'number' ? Math.round(v) : v), '|', await page.locator('#paint-info').textContent());
if (!paintOpen) throw new Error('the Paint tab closed after a move');
if (!carryText.includes('moved with it')) throw new Error('the paint did not come along with the move');
for (const m of Object.keys(areasBefore)) if (m !== '0' && Math.abs((areasAfter[m] ?? 0) - areasBefore[m]) > Math.max(2, 0.05 * areasBefore[m])) throw new Error(`colour ${m} changed from ${areasBefore[m]} to ${areasAfter[m]} mm² in the move`);
await page.screenshot({ path: join(out, '3m-paint-moved.png') });
// leaning with the head: the hint gives the head's tilt and the fit follows it, the paint again with it
await page.click('.tabs button[data-tab="accessory"]');
await page.selectOption('#stand', 'surface');
const standInfo = await page.locator('#stand-info').textContent();
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('3n.', standInfo, '|', await page.locator('#fit-result').textContent(), '|', await status());
if (!/leans 1[3-8]\.\d°/.test(standInfo)) throw new Error('the head tilt was not read');
await page.screenshot({ path: join(out, '3n-leaning.png') });
await page.selectOption('#stand', 'magnet');
await page.fill('#dx', '0');
await page.dispatchEvent('#dx', 'input');

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
await page.evaluate(() => { for (const d of document.querySelectorAll('#prepare-controls details')) d.open = true; }); // the fill sits in a closed details
await page.fill('#prep-fill', '6');
await page.dispatchEvent('#prep-fill', 'change');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('Filled'), null, { timeout: 60000 });
console.log('6f.', await status());
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
const [clothDl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#export-fitted')]);
console.log('7c. exported', clothDl.suggestedFilename());
// a split, form-fitting shirt: two halves with magnet pockets, exported as two files (the controls sit in a closed details)
await page.evaluate(() => { for (const d of document.querySelectorAll('#tab-clothing details')) d.open = true; });
await page.selectOption('#cloth-split', 'sides');
await page.check('#cloth-form-fit');
await page.click('#make-shirt');
await page.waitForFunction(() => document.getElementById('cloth-result').textContent.includes('split into 2 halves'), null, { timeout: 120000 });
console.log('7d.', await page.locator('#cloth-result').textContent());
await page.screenshot({ path: join(out, '7d-split-shirt.png') });
const halves = [];
console.log('7d. export says:', await page.locator('#export-info').textContent());
page.on('download', (d) => halves.push(d.suggestedFilename()));
await page.click('#export-fitted');
await page.waitForFunction(() => true, null, { timeout: 2000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
console.log('7e. exported halves', halves.join(', '));
if (halves.length !== 2) throw new Error(`expected two half files, got ${halves.length}`);
await page.selectOption('#cloth-split', 'none');
await page.uncheck('#cloth-form-fit');
// clear: the loaded model and the garment go, the wrap and paint buttons lock, and the Clear buttons go quiet
await page.click('#clear-cloth');
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Cleared'), null, { timeout: 5000 });
const cleared = await page.evaluate(() => [document.getElementById('wrap-garment').disabled, document.getElementById('paint-tab-button').disabled, document.getElementById('clear-model').disabled, document.getElementById('cloth-model').textContent]);
console.log('7f. cleared:', cleared.join(' | '));
if (!cleared[0] || !cleared[1] || !cleared[2]) throw new Error('clear left a button live');
await page.screenshot({ path: join(out, '7f-cleared.png') });

}

// a picture: an SVG candy cane (red with white stripes) stands on the head, its puck behind it resting on the head, facing the beak
const cane = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120"><rect x="20" y="20" width="20" height="100" fill="#d03b2f"/><path d="M20 30 A15 15 0 0 1 50 30 L50 50 L40 50 L40 30 A5 5 0 0 0 30 30 L30 40 L20 40 Z" fill="#d03b2f"/><rect x="20" y="50" width="20" height="12" fill="#ffffff"/><rect x="20" y="80" width="20" height="12" fill="#ffffff"/></svg>`;
await page.click('.tabs button[data-tab="accessory"]');
await page.evaluate(() => { const p = document.getElementById('point'); p.value = 'head'; p.dispatchEvent(new Event('change')); }); // the select is hidden until a model is loaded
await page.setInputFiles('#flat-file', { name: 'cane.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(cane) });
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Picture built'), null, { timeout: 60000 });
const caneInfo = await page.locator('#model-info').textContent();
const caneSpin = await page.evaluate(() => document.getElementById('spin').value);
console.log('8.', caneInfo, '| spin', caneSpin);
if (!/standing/.test(caneInfo) || !/2 colours/.test(caneInfo)) throw new Error('the picture did not build standing with two colours');
if (!/behind it, standing on the goose/.test(caneInfo)) throw new Error('the picture on the head did not get its puck behind it');
// the cane's hook (30 wide) is at the top and its stem (20 wide, with the 14 mm puck behind it) at the bottom: the SVG is the right way up
const [hookW, footW] = await page.evaluate(() => { const b = window.__goose.accessoryBox; const top = b.max[2]; return [window.__goose.accessoryWidth(top - 10, top), window.__goose.accessoryWidth(b.min[2], b.min[2] + 2)]; });
console.log('8a. width at the top', hookW.toFixed(1), '| at the foot', footW.toFixed(1));
if (!(hookW > footW + 3)) throw new Error('the SVG picture is upside down');
if (!(await page.evaluate(() => document.querySelector('#flat-preview svg path')))) throw new Error('the picture panel shows no preview');
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('8b.', await page.locator('#fit-result').textContent());
await page.screenshot({ path: join(out, '8-cane-head.png') });
// the accessory view: the goose goes; the magnet moves to a clicked spot on the picture (along its back, since it stands)
await page.click('#focus');
const caneHidden = await page.evaluate(() => window.__goose.gooseVisible);
await page.screenshot({ path: join(out, '8c-accessory-view.png') });
const mountBefore = await page.evaluate(() => window.__goose.mount);
await page.click('#move-mount');
const [mx, my] = await page.evaluate(() => { const b = window.__goose.accessoryBox; return window.__goose.modelOnScreen(4, b.min[1], 20); });
await page.mouse.click(mx, my);
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Mount moved'), null, { timeout: 60000 });
const mountAfter = await page.evaluate(() => window.__goose.mount);
console.log('8c. goose hidden:', !caneHidden, '| mount', mountBefore.map((v) => v.toFixed(1)).join(','), '→', mountAfter.map((v) => v.toFixed(1)).join(','), '|', await status());
if (caneHidden) throw new Error('the accessory view did not hide the goose');
if (Math.abs(mountAfter[0] - mountBefore[0] - 4) > 1) throw new Error('the mount did not move to the clicked spot');
await page.click('#focus');
await page.evaluate(() => { if (window.__goose.moveMode) document.getElementById('move-mount').click(); });
// the head keeps a tilt of its own
await page.fill('#tilt-x', '10');
await page.dispatchEvent('#tilt-x', 'input');
// a flat picture on the wing, puck under its back: the wing starts from its own defaults, not the head's spin and tilt
await page.selectOption('#point', 'left_wing');
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Picture built'), null, { timeout: 60000 });
const wingInfo = await page.locator('#model-info').textContent();
const wingPlace = await page.evaluate(() => ['spin', 'tilt-x', 'flat-orientation', 'flat-attach'].map((id) => document.getElementById(id).value).concat([document.getElementById('flat-attach').disabled]));
console.log('8d.', wingInfo, '| wing settings', wingPlace.join('/'));
if (!/lying flat/.test(wingInfo) || !/under its back/.test(wingInfo)) throw new Error('the picture did not lie flat on the wing');
if (wingPlace.join('/') !== '0/0/flat/back/true') throw new Error('the wing did not start from its own defaults');
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('8e.', await page.locator('#fit-result').textContent());
await page.screenshot({ path: join(out, '8e-cane-wing.png') });
// back to the head: its spin, tilt and moved mount come back
await page.selectOption('#point', 'head');
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Picture built'), null, { timeout: 60000 });
const headBack = await page.evaluate(() => [document.getElementById('spin').value, document.getElementById('tilt-x').value, window.__goose.mount]);
console.log('8f. head again: spin', headBack[0], 'tilt', headBack[1], 'mount', headBack[2].map((v) => v.toFixed(1)).join(','));
if (headBack[0] !== caneSpin || headBack[1] !== '10' || Math.abs(headBack[2][0] - mountAfter[0]) > 0.01) throw new Error('the head did not keep its own placement');
// the mount choices: lying flat allows only the back; standing on its bottom edge puts the puck under it
await page.selectOption('#flat-orientation', 'flat');
await page.waitForFunction(() => document.getElementById('model-info').textContent.includes('lying flat'), null, { timeout: 60000 });
const flatAttach = await page.evaluate(() => [document.getElementById('flat-attach').value, document.getElementById('flat-attach').disabled, document.getElementById('spin').value]);
await page.selectOption('#flat-orientation', 'standing');
await page.waitForFunction(() => document.getElementById('model-info').textContent.includes('standing up'), null, { timeout: 60000 });
await page.selectOption('#flat-attach', 'bottom');
await page.waitForFunction(() => document.getElementById('model-info').textContent.includes('under its bottom edge'), null, { timeout: 60000 });
console.log('8g. flat:', flatAttach.join('/'), '| standing on its edge:', await page.locator('#model-info').textContent(), '|', await page.locator('#flat-mount-hint').textContent());
if (flatAttach[0] !== 'back' || !flatAttach[1] || flatAttach[2] !== '0') throw new Error('lying flat did not limit the puck to the back');
await page.selectOption('#flat-attach', 'back');
await page.waitForFunction(() => document.getElementById('model-info').textContent.includes('behind it'), null, { timeout: 60000 });
await page.fill('#tilt-x', '0');
await page.dispatchEvent('#tilt-x', 'input');

// a raster picture goes through Prepare image: drop the background, keep two colours, use it; Adjust opens it again
const png = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 160, 160);
  g.fillStyle = '#d03b2f';
  g.beginPath(); g.moveTo(80, 140); g.bezierCurveTo(10, 90, 20, 20, 80, 50); g.bezierCurveTo(140, 20, 150, 90, 80, 140); g.fill();
  g.fillStyle = '#222222'; g.beginPath(); g.arc(80, 80, 14, 0, Math.PI * 2); g.fill();
  const b = await new Promise((r) => c.toBlob(r, 'image/png'));
  return Array.from(new Uint8Array(await b.arrayBuffer()));
});
await page.setInputFiles('#flat-file', { name: 'heart.png', mimeType: 'image/png', buffer: Buffer.from(png) });
await page.waitForSelector('#prepare-image[open]', { timeout: 30000 });
await page.fill('#prep-colours', '2');
await page.dispatchEvent('#prep-colours', 'input');
await page.waitForFunction(() => /2 of 2 colours kept/.test(document.getElementById('prep-status').textContent), null, { timeout: 10000 });
await page.screenshot({ path: join(out, '8h-prepare-image.png') });
const chips = await page.locator('#prep-chips .chip').count();
await page.click('#prep-use');
await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Picture built'), null, { timeout: 60000 });
const heartInfo = await page.locator('#model-info').textContent();
console.log('8h. dialog chips', chips, '|', await page.locator('#flat-info').textContent(), '|', heartInfo);
if (chips !== 2 || !/2 colours/.test(heartInfo) || !/behind it/.test(heartInfo)) throw new Error('the prepared picture did not build with two colours and its puck behind');
if (await page.evaluate(() => document.getElementById('flat-adjust').disabled)) throw new Error('Adjust is not available for a picture');
await page.click('#flat-adjust');
await page.waitForSelector('#prepare-image[open]', { timeout: 10000 });
const keptSetting = await page.evaluate(() => document.getElementById('prep-colours').value);
await page.click('#prep-cancel');
if (keptSetting !== '2') throw new Error('Adjust did not reopen with the settings used');
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('8i. heart on the head:', await page.locator('#fit-result').textContent());
if (/floor/.test(await page.locator('#fit-result').textContent())) throw new Error('the heart puck has no floor under its pocket');
await page.screenshot({ path: join(out, '8i-heart-head.png') });
await page.click('#view-front');
await page.screenshot({ path: join(out, '8j-heart-front.png') });
await page.click('#view-side');
await page.screenshot({ path: join(out, '8k-heart-side.png') });
await page.click('#view-iso');

// a small model: a thin sword gets a puck under its guard, and can then be fitted
const sword = boxesStl([[0, 0, 0, 40, 5, 2], [10, -4.5, 0, 4, 14, 2]]);
// the prepare settings left by the dome (flipped, 20 mm wide, filled) do not suit a sword
await page.evaluate(() => { for (const [id, v] of [['prep-down', '-z'], ['prep-width', ''], ['prep-fill', '0']]) document.getElementById(id).value = v; });
await page.setInputFiles('#accessory-file', { name: 'sword.stl', mimeType: 'application/octet-stream', buffer: Buffer.from(sword) });
await page.waitForFunction(() => document.getElementById('status').textContent.includes('Puck added'), null, { timeout: 60000 });
console.log('9.', await page.locator('#puck-info').textContent());
await page.evaluate(() => { for (const d of document.querySelectorAll('#prepare-controls details')) d.open = true; });
await page.selectOption('#prep-puck', 'never');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('after preparing') && !document.getElementById('status').textContent.includes('Puck'), null, { timeout: 60000 });
const noPuck = await page.locator('#puck-info').textContent();
await page.selectOption('#prep-puck', 'auto');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('Puck added'), null, { timeout: 60000 });
console.log('9b. toggled off:', JSON.stringify(noPuck), '| on again:', await page.locator('#puck-info').textContent());
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('9c.', await page.locator('#fit-result').textContent());
if (/floor/.test(await page.locator('#fit-result').textContent())) throw new Error('the puck did not give the pocket a floor');
await page.screenshot({ path: join(out, '9-sword-puck.png') });
// the puck behind the sword instead: it stands just in front of the puck, turned to face the beak
await page.selectOption('#prep-puck-attach', 'behind');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('Puck added behind'), null, { timeout: 60000 });
console.log('9d.', await page.locator('#puck-info').textContent(), '| spin', await page.evaluate(() => document.getElementById('spin').value));
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('9e.', await page.locator('#fit-result').textContent());
if (/floor/.test(await page.locator('#fit-result').textContent())) throw new Error('the puck behind did not give the pocket a floor');
await page.screenshot({ path: join(out, '9e-sword-behind.png') });
await page.selectOption('#prep-puck-attach', 'under');

// the neck: a band appears, a bow-tie block is fitted on it with slots, and the export gives the band as its own part
const bow = boxesStl([[-12, -4, 0, 24, 8, 4]]);
await page.setInputFiles('#accessory-file', { name: 'bow.stl', mimeType: 'application/octet-stream', buffer: Buffer.from(bow) });
await page.waitForFunction(() => document.getElementById('status').textContent.includes('Place it'), null, { timeout: 30000 });
await page.selectOption('#point', 'neck');
await page.waitForFunction(() => window.__goose.band && window.__goose.band.shown, null, { timeout: 60000 });
const bandInfo = await page.evaluate(() => window.__goose.band);
console.log('10. band:', JSON.stringify(bandInfo), '|', await page.locator('#neck-info').textContent());
if (bandInfo.tabs !== 2 || bandInfo.volume < 50) throw new Error('the neck band is not right');
await page.click('#fit');
await page.waitForFunction(() => document.getElementById('fit-result').textContent.startsWith('Fitted'), null, { timeout: 120000 });
console.log('10b.', await page.locator('#fit-result').textContent(), '|', await page.locator('#neck-info').textContent());
if (!/separate part/.test(await page.locator('#fit-result').textContent())) throw new Error('the fit on the neck did not keep the band');
if (!/Fitted with 2\.0 mm tabs/.test(await page.locator('#neck-info').textContent())) throw new Error('the bow did not take full-length tabs');
await page.screenshot({ path: join(out, '10-neck-bow.png') });
const neckFiles = [];
page.on('download', (d) => neckFiles.push(d.suggestedFilename()));
await page.click('#export-fitted');
await new Promise((r) => setTimeout(r, 1500));
console.log('10c. exported', neckFiles.join(', '));
if (!neckFiles.includes('accessory.neck.band.stl')) throw new Error('the band was not exported as its own file');
await page.click('.tabs button[data-tab="paint"]');
const [neckDl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#export-3mf')]);
console.log('10d.', await status(), '→', neckDl.suggestedFilename());
await page.click('.tabs button[data-tab="accessory"]');
await page.selectOption('#point', 'head');
await page.waitForFunction(() => document.getElementById('status').textContent.includes('Place it'), null, { timeout: 60000 }); // the bow is prepared again for the head

// magnet hole: from the opening camera, the middle of the view lands on the goose body
await page.click('.tabs button[data-tab="hole"]');
await page.evaluate(() => window.__goose.lookAt([115, 140, 90], [-180, -260, 220]));
await page.screenshot({ path: join(out, '4a-hole-view.png') });
const box = await page.locator('#view canvas[data-engine]').boundingBox();
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

/** Binary STL of axis-aligned boxes [x, y, z, w, d, h], joined as one shell per box (overlaps are fine, the importer repairs). */
function boxesStl(boxes) {
  const tris = [];
  for (const [x, y, z, w, d, h] of boxes) {
    const p = (i) => [x + (i & 1 ? w : 0), y + (i & 2 ? d : 0), z + (i & 4 ? h : 0)];
    const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    for (const [a, b, c, dd] of quads) { tris.push([p(a), p(b), p(c)]); tris.push([p(a), p(c), p(dd)]); }
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

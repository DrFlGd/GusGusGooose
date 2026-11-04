// Headless test of the library in the built web app (IndexedDB): save a fitted,
// painted accessory into a holiday collection with tags and a description,
// find it in the Library, edit it, reload the page, open it again and check the
// fit and the paint came back; the same for a picture; then duplicate, a new
// collection, the tag filter and delete. Run `npx vite build` first.
//
//   node scripts/library-smoke.mjs [outdir]

import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'smoke-out';
mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4174, strictPort: true } });
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const status = () => page.locator('#status').textContent();
const waitStatus = (fn, timeout = 120000) => page.waitForFunction(fn, null, { timeout });
const check = (ok, what) => { if (!ok) throw new Error(what); };
const loaded = () => waitStatus(() => document.getElementById('status').textContent.startsWith('Goose loaded'), 60000);

await page.goto(base);
await loaded();

// 1. a puck on the head, fitted, filled red
await page.setInputFiles('#accessory-file', { name: 'puck.stl', mimeType: 'application/octet-stream', buffer: puckStl(9, 8, 64) });
await waitStatus(() => document.getElementById('status').textContent.includes('Place it'));
await page.selectOption('#point', 'head');
await page.fill('#spin-num', '30');
await page.dispatchEvent('#spin-num', 'change');
await page.click('#fit');
await waitStatus(() => document.getElementById('fit-result').textContent.startsWith('Fitted'));
await page.click('.tabs button[data-tab="paint"]');
await page.evaluate(() => { document.querySelector('#palette .swatch:nth-child(4)').click(); });
await page.click('#fill-all');
const areasBefore = await page.evaluate(() => window.__goose.paintAreas);
console.log('1. fitted and painted:', JSON.stringify(areasBefore));
check(areasBefore && areasBefore[3] > 100, 'the fill did not paint the part');

// 2. save it: Christmas, two tags, a description
check(!(await page.isDisabled('#save-library')), 'Save to library is not live');
await page.click('#save-library');
await page.waitForSelector('#save-name');
await page.screenshot({ path: join(out, 'library-save-dialog.png') });
await page.fill('#save-name', 'Red head puck');
await page.selectOption('#save-collection', 'christmas');
await page.fill('#save-tags', 'red, puck, Red');
await page.fill('#save-desc', 'A plain puck for testing.');
await page.click('#save-confirm');
await waitStatus(() => document.getElementById('status').textContent.startsWith('Saved Red head puck'));
console.log('2.', await status());

// 3. a picture on the left wing, saved unfitted under Valentine's Day
const heart = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 90"><path d="M50 88 L8 45 A22 22 0 0 1 50 14 A22 22 0 0 1 92 45 Z" fill="#d03b2f"/><circle cx="50" cy="45" r="12" fill="#ffffff"/></svg>`;
await page.click('.tabs button[data-tab="accessory"]');
await page.setInputFiles('#flat-file', { name: 'heart.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(heart) });
await waitStatus(() => document.getElementById('status').textContent.startsWith('Picture built'));
check(await page.evaluate(() => !document.getElementById('library-current').textContent.includes('Red head puck')), 'a new picture still counts as the puck build');
await page.selectOption('#point', 'left_wing');
await waitStatus(() => document.getElementById('status').textContent.startsWith('Picture built'));
await page.evaluate(() => { const w = document.getElementById('flat-width'); w.value = '34'; w.dispatchEvent(new Event('change')); });
await waitStatus(() => document.getElementById('model-info').textContent.includes('34.0 ×'));
await page.click('#save-library');
await page.waitForSelector('#save-name');
check((await page.inputValue('#save-name')).startsWith('heart'), 'the suggested name is not the picture\'s');
await page.selectOption('#save-collection', 'valentines');
await page.fill('#save-tags', 'heart, red');
await page.click('#save-confirm');
await waitStatus(() => document.getElementById('status').textContent.startsWith('Saved heart'));
console.log('3.', await status());

// 4. the Library: two builds, filed under their holidays, with thumbnails
await page.click('.tabs button[data-tab="library"]');
await page.waitForSelector('.lib-card img');
await page.waitForFunction(() => document.querySelectorAll('.lib-card img').length === 2);
const cards = await page.$$eval('.lib-card .lib-card-name', (els) => els.map((e) => e.textContent));
console.log('4. cards:', cards.join(' | '));
check(cards.length === 2, 'the library does not show both builds');
await page.screenshot({ path: join(out, 'library-grid.png') });
await page.click('.lib-cols li:has-text("Christmas") .lib-col');
check((await page.$$('.lib-card')).length === 1, 'the Christmas collection does not show just the puck');
await page.click('.lib-cols-top li:first-child .lib-col');
// tags are kept once each, ignoring case, and filter the cards
await page.click('.lib-tag:text-is("puck")');
check((await page.$$('.lib-card')).length === 1, 'the puck tag does not filter');
await page.click('.lib-tag:text-is("puck")');
await page.fill('#lib-search', 'testing');
check((await page.$$('.lib-card')).length === 1, 'search does not find the description');
await page.fill('#lib-search', '');
await page.dispatchEvent('#lib-search', 'input');

// 5. edit the details in the right column, then reload: they stay
await page.click('.lib-card:has-text("Red head puck")');
await page.fill('#lib-desc', 'A plain puck for testing, edited.');
await page.dispatchEvent('#lib-desc', 'change');
await page.fill('#lib-tags', 'red, puck, santa');
await page.dispatchEvent('#lib-tags', 'change');
await waitStatus(() => document.getElementById('library-status').textContent.startsWith('Saved the details'), 10000);
await page.screenshot({ path: join(out, 'library-detail.png') });
await page.reload();
await loaded();
await page.click('.tabs button[data-tab="library"]');
await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 2);
await page.click('.lib-card:has-text("Red head puck")');
const kept = { desc: await page.inputValue('#lib-desc'), tags: await page.inputValue('#lib-tags'), col: await page.inputValue('#lib-collection') };
console.log('5. after reload:', JSON.stringify(kept));
check(kept.desc.endsWith('edited.') && kept.tags === 'red, puck, santa' && kept.col === 'christmas', 'the edited details did not survive a reload');

// 6. open it again: the head, the spin, the fit and the red paint are back
await page.click('#lib-open');
await waitStatus(() => document.getElementById('status').textContent.startsWith('Opened Red head puck'), 180000);
const reopened = await page.evaluate(() => ({ point: document.getElementById('point').value, spin: document.getElementById('spin').value, fit: document.getElementById('fit-result').textContent, areas: window.__goose.paintAreas, tab: document.querySelector('.tabs button.active').dataset.tab, current: document.getElementById('library-current').textContent }));
console.log('6.', await status(), JSON.stringify(reopened));
check(reopened.point === 'head' && reopened.spin === '30' && reopened.fit.startsWith('Fitted'), 'the placement or the fit did not come back');
check(reopened.areas && Math.abs((reopened.areas[3] ?? 0) - areasBefore[3]) < 1, 'the paint did not come back');
check(reopened.tab === 'paint' && reopened.current.includes('Red head puck'), 'it did not open on the Paint tab as the open build');
await page.screenshot({ path: join(out, 'library-reopened.png') });

// 7. change it and save over it; then save a copy as new
await page.evaluate(() => { document.querySelector('#palette .swatch:nth-child(3)').click(); });
await page.click('#fill-all');
await page.click('#save-library');
await page.waitForSelector('#save-as-new');
await page.click('#save-confirm');
await waitStatus(() => document.getElementById('status').textContent.startsWith('Saved Red head puck'));
await page.click('#save-library');
await page.waitForSelector('#save-as-new');
await page.fill('#save-name', 'Orange head puck');
await page.click('#save-as-new');
await waitStatus(() => document.getElementById('status').textContent.startsWith('Saved Orange head puck'));

// 8. open the picture: it is traced again and back on the left wing at 34 mm, not fitted
await page.click('.tabs button[data-tab="library"]');
await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 3);
await page.dblclick('.lib-card:has-text("heart")');
await waitStatus(() => document.getElementById('status').textContent.startsWith('Opened heart'), 120000);
const pic = await page.evaluate(() => ({ point: document.getElementById('point').value, width: document.getElementById('flat-width').value, info: document.getElementById('model-info').textContent, preview: !!document.querySelector('#flat-preview svg') }));
console.log('8.', JSON.stringify(pic));
check(pic.point === 'left_wing' && pic.width === '34' && pic.info.includes('34.0 ×') && pic.preview, 'the picture did not come back as saved');

// 9. a new collection, duplicate, delete
await page.click('.tabs button[data-tab="library"]');
await page.click('#lib-add-collection');
await page.fill('.dialog input[type="text"]', 'Desk days');
await page.selectOption('.dialog select', 'category');
await page.click('.dialog .primary');
await page.waitForFunction(() => [...document.querySelectorAll('.lib-col-name')].some((e) => e.textContent === 'Desk days'));
check((await page.$$('.lib-card')).length === 0, 'a new collection is not empty');
await page.click('.lib-cols-top li:first-child .lib-col');
await page.click('.lib-card:has-text("Orange head puck")');
await page.selectOption('#lib-collection', 'desk-days');
await page.waitForFunction(() => document.querySelector('.lib-cols li:has(.lib-col-name) .lib-count') !== null);
await page.click('#lib-duplicate');
await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 4);
await page.click('.lib-card:has-text("Orange head puck copy")');
await page.click('#lib-delete');
await page.click('#lib-delete-confirm');
await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 3);
const counts = await page.$$eval('.lib-cols li', (lis) => Object.fromEntries(lis.map((li) => [li.querySelector('.lib-col-name').textContent, li.querySelector('.lib-count').textContent])));
console.log('9. counts:', JSON.stringify(counts));
check(counts['Desk days'] === '1' && counts.Christmas === '1' && counts["Valentine's Day"] === '1' && counts['All builds'] === '3', 'collection counts are off');
await page.screenshot({ path: join(out, 'library-collections.png') });
// the dark theme
await page.click('#theme');
await page.screenshot({ path: join(out, 'library-dark.png') });
const layout = await page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
check(layout <= 0, 'the page scrolls in the Library');

if (errors.length) { console.log('console errors:', errors.join('\n')); throw new Error('console errors'); }
console.log('library smoke passed');
await browser.close();
await server.close();

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

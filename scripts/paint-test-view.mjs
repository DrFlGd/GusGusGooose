// Draws the paint test cube (scripts/paint-test-cube.ts) as it should look: top, +x side, -y side.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [, , input, output] = process.argv;
const { loadModel } = await import('../src/load-model.ts');
const { fromManifoldTagged } = await import('../src/fit.ts');
const m = await loadModel('cube.3mf', readFileSync(input));
const { mesh, faceMaterial } = fromManifoldTagged(m.solid, m.firstID, m.materials.length, 0);
const P = mesh.positions, T = mesh.triangles;
const views = [
  { name: 'Top', n: [0, 0, 1], u: (p) => p[0], v: (p) => p[1] },
  { name: '+X side', n: [1, 0, 0], u: (p) => p[1], v: (p) => p[2] - 15 },
  { name: '−Y side', n: [0, -1, 0], u: (p) => p[0], v: (p) => p[2] - 15 },
];
let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360" style="background:#f4f1ea;font:16px sans-serif">';
views.forEach((view, k) => {
  const ox = 160 + k * 320, oy = 170, s = 8;
  svg += `<text x="${ox}" y="340" text-anchor="middle" fill="#333">${view.name}</text>`;
  for (let t = 0; t < T.length / 3; t++) {
    const p = [0, 1, 2].map((i) => [P[T[t * 3 + i] * 3], P[T[t * 3 + i] * 3 + 1], P[T[t * 3 + i] * 3 + 2]]);
    const e1 = p[1].map((x, d) => x - p[0][d]), e2 = p[2].map((x, d) => x - p[0][d]);
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (nrm[0] * view.n[0] + nrm[1] * view.n[1] + nrm[2] * view.n[2] <= 1e-9) continue;
    const pts = p.map((q) => `${(ox + view.u(q) * s).toFixed(2)},${(oy - view.v(q) * s).toFixed(2)}`).join(' ');
    const c = m.materials[faceMaterial[t]].color;
    svg += `<polygon points="${pts}" fill="${c}" stroke="${c}" stroke-width="0.6"/>`;
  }
  // the cube's own two triangles on this side, to show the paint does not follow them
  const h = 15 * s;
  svg += `<rect x="${ox - h}" y="${oy - h}" width="${2 * h}" height="${2 * h}" fill="none" stroke="#555" stroke-width="1.5"/>`;
});
svg += '</svg>';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 360 }, deviceScaleFactor: 2 });
await page.setContent(`<body style="margin:0">${svg}</body>`);
await page.screenshot({ path: output });
await browser.close();

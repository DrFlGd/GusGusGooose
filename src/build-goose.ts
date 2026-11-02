// Turns the goose project 3MF into the single bundled solid the app fits
// against: union of the printed parts minus the negative parts.
//
//   node src/build-goose.ts goose/goose.3mf [goose/goose.stl]

import { writeStl } from './stl.ts';
import { read3mf, type Part } from './threemf.ts';
import { fromManifold, manifold, toManifold } from './fit.ts';

export async function buildGoose(parts: Part[], log = (s: string) => console.log(s)) {
  const { Manifold } = await manifold();
  const solids = [], holes = [];
  for (const p of parts) {
    const bb = bounds(p.mesh);
    try {
      const m = await toManifold(p.mesh);
      log(`  ${p.kind.padEnd(8)} ${p.name.padEnd(24)} ${p.mesh.triangles.length / 3} tris  ${bb}  ok`);
      (p.kind === 'negative' ? holes : p.kind === 'normal' ? solids : []).push(m);
    } catch (e) {
      log(`  ${p.kind.padEnd(8)} ${p.name.padEnd(24)} ${p.mesh.triangles.length / 3} tris  ${bb}  SKIPPED: ${(e as Error).message}`);
    }
  }
  let goose = Manifold.union(solids);
  if (holes.length) goose = goose.subtract(Manifold.union(holes));
  return goose;
}

function bounds(m: { positions: Float32Array }) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], m.positions[i + k]); hi[k] = Math.max(hi[k], m.positions[i + k]);
  }
  const f = (n: number) => n.toFixed(1);
  return `[${lo.map(f)}] to [${hi.map(f)}]`;
}

if (process.argv[1]?.endsWith('build-goose.ts')) {
  const src = process.argv[2] ?? 'goose/goose.3mf';
  const out = process.argv[3] ?? 'goose/goose.stl';
  const parts = read3mf(src);
  console.log(`${parts.length} parts in ${src}`);
  const goose = await buildGoose(parts);
  const mesh = fromManifold(goose);
  writeStl(out, mesh);
  const bb = goose.boundingBox();
  console.log(`goose: ${mesh.triangles.length / 3} tris, ${goose.decompose().length} bodies, volume ${goose.volume().toFixed(0)} mm³, size ${bb.max.map((v, i) => (v - bb.min[i]).toFixed(1)).join(' x ')} mm`);
  console.log(`written to ${out}`);
}

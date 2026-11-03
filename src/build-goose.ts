// Turns the goose project 3MF into the single bundled solid the app fits
// against: union of the printed parts minus the negative parts. With a
// second 3MF that carries the magnet voids as negative parts around a
// shared part (the bare white body), those voids are mapped across and
// cut too, and become the fit profile.
//
//   node src/build-goose.ts goose/goose.3mf [goose/goose.stl] [--voids goose/goose-voids.3mf] [--profile goose/profile.json]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { writeStl } from './stl-node.ts';
import { parseStl, serializeStl, survivesRoundTrip } from './stl.ts';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { read3mf, type Part } from './threemf.ts';
import { DEFAULT_PROFILE, fromManifold, fromManifoldTagged, manifold, toManifold, toManifoldTagged, type FitProfile } from './fit.ts';
import type { Material } from './threemf-write.ts';
import type { GooseColors } from './goose-colors.ts';
export type { GooseColors } from './goose-colors.ts';
import { mapNegatives, primitivesToPoints, type VoidPrimitive } from './map-voids.ts';

export async function buildGoose(parts: Part[], extraHoles: VoidPrimitive[] = [], log = (s: string) => console.log(s)): Promise<{ goose: ManifoldT; solid: ManifoldT; colors: GooseColors; faceMaterial: Uint8Array }> {
  const { Manifold } = await manifold();
  // one material per filament slot the printed parts use, named after those parts
  const slots = [...new Set(parts.filter((p) => p.kind === 'normal').map((p) => p.extruder ?? 1))].sort((a, b) => a - b);
  const materials: Material[] = slots.map((slot) => {
    const users = parts.filter((p) => p.kind === 'normal' && (p.extruder ?? 1) === slot);
    const names = [...new Set(users.map((p) => p.name.replace(/\s*\(.*\)|\.stl|_\d+$/gi, '').trim()))];
    return { name: names.join(' + '), color: users.find((p) => p.color)?.color ?? '#e9dcc3' };
  });
  const firstID = Manifold.reserveIDs(materials.length);
  // the biggest part's material is the fallback for faces the voids cut
  const biggest = parts.filter((p) => p.kind === 'normal').sort((a, b) => b.mesh.triangles.length - a.mesh.triangles.length)[0];
  const fallback = biggest ? slots.indexOf(biggest.extruder ?? 1) : 0;
  const solids: ManifoldT[] = [], holes: ManifoldT[] = [];
  for (const p of parts) {
    const bb = bounds(p.mesh);
    try {
      const m = p.kind === 'normal'
        ? await toManifoldTagged(p.mesh, new Uint8Array(p.mesh.triangles.length / 3).fill(slots.indexOf(p.extruder ?? 1)), firstID)
        : await toManifold(p.mesh);
      log(`  ${p.kind.padEnd(8)} ${p.name.padEnd(24)} ${p.mesh.triangles.length / 3} tris  ${bb}  ok${p.color ? `  ${p.color}` : ''}`);
      (p.kind === 'negative' ? holes : p.kind === 'normal' ? solids : []).push(m);
    } catch (e) {
      log(`  ${p.kind.padEnd(8)} ${p.name.padEnd(24)} ${p.mesh.triangles.length / 3} tris  ${bb}  SKIPPED: ${(e as Error).message}`);
    }
  }
  for (const h of extraHoles) {
    const f = (n: number) => n.toFixed(1);
    log(`  void     ${h.kind.padEnd(8)} ${h.name.padEnd(15)} ${h.size.map(f).join(' x ')} mm at (${h.center.map(f).join(', ')}) in ${h.anchor}`);
    holes.push(await toManifold(h.mesh));
  }
  const solid = Manifold.union(solids);
  const goose = holes.length ? solid.subtract(Manifold.union(holes)) : solid;
  const tagged = fromManifoldTagged(goose, firstID, materials.length, fallback);
  // the STL on disk loses degenerate triangles when read back; keep the colours aligned with what survives
  const keep = survivesRoundTrip(tagged.mesh);
  const faceMaterial = tagged.faceMaterial.filter((_, i) => keep[i]);
  const runs: [number, number][] = [];
  for (const m of faceMaterial) {
    if (runs.length && runs[runs.length - 1][0] === m) runs[runs.length - 1][1]++; else runs.push([m, 1]);
  }
  return { goose, solid, colors: { materials, runs }, faceMaterial };
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
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  const opt = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const src = positional[0] ?? 'goose/goose.3mf';
  const out = positional[1] ?? 'goose/goose.stl';
  const parts = read3mf(src);
  console.log(`${parts.length} parts in ${src}`);
  let voids: VoidPrimitive[] = [];
  if (opt('voids')) {
    const voidParts = read3mf(opt('voids')!);
    voids = mapNegatives(parts, voidParts);
    console.log(`${voids.length} negative parts mapped from ${opt('voids')}`);
  }
  const { goose, solid, colors } = await buildGoose(parts, voids);
  const mesh = fromManifold(goose);
  writeStl(out, mesh);
  const colorsPath = out.replace(/\.stl$/i, '') + '-colors.json';
  const readBack = parseStl(serializeStl(mesh)).triangles.length / 3;
  const coloured = colors.runs.reduce((n, [, c]) => n + c, 0);
  if (readBack !== coloured) throw new Error(`colour runs cover ${coloured} triangles but the STL reads back as ${readBack}`);
  writeFileSync(colorsPath, JSON.stringify(colors));
  console.log(`colours: ${colors.materials.map((m) => `${m.name} ${m.color}`).join(', ')} in ${colors.runs.length} runs, written to ${colorsPath}`);
  const bb = goose.boundingBox();
  console.log(`goose: ${mesh.triangles.length / 3} tris, ${goose.decompose().length} bodies, volume ${goose.volume().toFixed(0)} mm³, size ${bb.max.map((v, i) => (v - bb.min[i]).toFixed(1)).join(' x ')} mm`);
  console.log(`written to ${out}`);
  if (voids.length) {
    const profilePath = opt('profile') ?? 'goose/profile.json';
    const { points, slots } = primitivesToPoints(voids, fromManifold(solid));
    const existing: Partial<FitProfile> = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : {};
    const profile: FitProfile = { ...DEFAULT_PROFILE, ...existing, points, slots };
    writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    const f = (n: number) => n.toFixed(2);
    for (const [name, p] of Object.entries(points)) {
      const shape = p.shape === 'box' ? `${p.size!.map(f).join(' x ')} box` : `${f(p.diameter)} dia`;
      console.log(`  ${name.padEnd(11)} ${shape} x ${f(p.depth)} deep, ${p.mode} under ${f(p.skin ?? 0)} mm skin, surface point (${p.center.map(f).join(', ')}), axis (${p.axis.map(f).join(', ')})`);
    }
    console.log(`profile written to ${profilePath}`);
  }
}

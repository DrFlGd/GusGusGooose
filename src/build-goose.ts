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
import { findVoids, type Tube } from './voids.ts';

/**
 * Builds the solid every boolean runs against. `eyes` is the loose eye part
 * (pieces modelled standing on their flat pin end, dome up): the pin channel
 * through the head is filled and each eye is seated in a mouth of it, so an
 * accessory over the eyes is carved around the domes and never opens the hole.
 */
export async function buildGoose(parts: Part[], extraHoles: VoidPrimitive[] = [], log = (s: string) => console.log(s), eyes?: Part): Promise<{ goose: ManifoldT; solid: ManifoldT; colors: GooseColors; faceMaterial: Uint8Array }> {
  const { Manifold } = await manifold();
  // one material per filament slot the printed parts use, named after those parts
  const printed = [...parts.filter((p) => p.kind === 'normal'), ...(eyes ? [eyes] : [])];
  const slots = [...new Set(printed.map((p) => p.extruder ?? 1))].sort((a, b) => a - b);
  const materials: Material[] = slots.map((slot) => {
    const users = printed.filter((p) => (p.extruder ?? 1) === slot);
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
  let goose = holes.length ? solid.subtract(Manifold.union(holes)) : solid;
  if (eyes) {
    const seated = await seatEyes(goose, eyes, slots.indexOf(eyes.extruder ?? 1), firstID, log);
    if (seated) goose = Manifold.union([goose, ...seated]);
  }
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

/**
 * Seats the eye pieces: the channel through the head whose radius matches the
 * pins is filled (so it is closed for every boolean), and each eye goes into a
 * mouth of it with its pin inside and its dome standing on the surface.
 * Returns the filler and the seated eyes, or null with a note when the eyes
 * and the head do not match.
 */
export async function seatEyes(goose: ManifoldT, eyes: Part, material: number, firstID: number, log = (s: string) => console.log(s)): Promise<ManifoldT[] | null> {
  const { Manifold } = await manifold();
  const f = (n: number) => n.toFixed(1);
  const pieces = (await toManifold(eyes.mesh)).decompose().filter((p) => p.volume() > 1);
  const pins = pieces.map((p) => {
    const bb = p.boundingBox();
    // the pin runs from the bottom up to the widest cross-section, where the dome begins (a real pin may taper a little)
    const areas: [number, number][] = [];
    for (let z = bb.min[2] + 0.2; z < bb.max[2] - 0.2; z += 0.1) areas.push([z, p.slice(z).area()]);
    const widest = Math.max(...areas.map((a) => a[1]));
    const top = areas.find((a) => a[1] >= widest * 0.98)![0];
    return { solid: p, radius: Math.sqrt(widest / Math.PI), length: top - bb.min[2], top, center: [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2] as [number, number] };
  });
  if (!pins.length) { log('  eyes: no pieces'); return null; }
  const tubes: Tube[] = [];
  findVoids(fromManifold(goose), tubes);
  const r = pins[0].radius;
  const channel = tubes.filter((t) => Math.abs(t.radius - r) < 0.6).sort((a, b) => b.wallFaces - a.wallFaces)[0];
  if (!channel) { log(`  eyes: no channel through the goose matches the ${f(r * 2)} mm pins (tubes: ${tubes.map((t) => `${f(t.radius * 2)} mm x ${f(t.length)}`).join(', ') || 'none'})`); return null; }
  log(`  eyes: ${pins.length} pieces, ${f(r * 2)} mm pins ${f(pins[0].length)} mm long; channel ${f(channel.radius * 2)} x ${f(channel.length)} mm at (${channel.center.map(f).join(', ')}) axis (${channel.axis.map(f).join(', ')})`);
  const toward = (d: [number, number, number]) => {
    const theta = (Math.acos(Math.max(-1, Math.min(1, d[2]))) * 180) / Math.PI;
    const phi = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
    return [0, theta, phi] as [number, number, number];
  };
  const mid = channel.ends[0].map((v, i) => (v + channel.ends[1][i]) / 2) as [number, number, number];
  const filler = Manifold.cylinder(channel.length, channel.radius + 0.1, channel.radius + 0.1, 48, true).rotate(toward(channel.axis)).translate(mid);
  const out: ManifoldT[] = [filler];
  const outward: [number, number, number][] = [channel.axis.map((v) => -v) as [number, number, number], channel.axis];
  pins.slice(0, 2).forEach((pin, i) => {
    const placed = pin.solid.translate([-pin.center[0], -pin.center[1], -pin.top]).rotate(toward(outward[i])).translate(channel.ends[i]);
    out.push(placed);
  });
  return Promise.all(out.map((m) => retag(m, firstID, material)));
}

/** Re-tags every face of a manifold with one material run ID. */
async function retag(m: ManifoldT, firstID: number, material: number): Promise<ManifoldT> {
  const mesh = fromManifold(m);
  return toManifoldTagged(mesh, new Uint8Array(mesh.triangles.length / 3).fill(material), firstID);
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
  let eyes: Part | undefined;
  if (opt('voids')) {
    const voidParts = read3mf(opt('voids')!);
    voids = mapNegatives(parts, voidParts);
    console.log(`${voids.length} negative parts mapped from ${opt('voids')}`);
    // the eyes are loose in the voids project (printed separately, modelled standing on the plate)
    eyes = [...voidParts, ...parts].find((p) => p.kind === 'normal' && /eye|black/i.test(p.name));
    // the voids project does not carry the eye filament's real colour; the part is named after it
    if (eyes && /black/i.test(eyes.name)) eyes = { ...eyes, color: '#1a1a1a' };
    if (eyes) console.log(`eyes: ${eyes.name} (${eyes.mesh.triangles.length / 3} tris${eyes.color ? `, ${eyes.color}` : ''})`);
  }
  const { goose, solid, colors } = await buildGoose(parts, voids, undefined, eyes);
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

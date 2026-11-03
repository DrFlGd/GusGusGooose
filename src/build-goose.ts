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
 * Closes the eyes: the channel through the head whose radius matches the eye
 * pins is filled with a plug in the eye colour, so the head is closed for
 * every boolean and each eye shows as a black patch flush with the side of
 * the head (the printed eyes sit flush; Jerred, 2026-11-03). The channel
 * meets the head at a steep slant (about 2.5 mm higher on one side of the
 * hole than the other), so a flat plug end stands proud on one side: each end
 * is instead capped by a surface spanning the hole, which meets the head
 * exactly round the rim (measured by casting a ray along the channel just
 * outside its wall at each angle) and is a best-fit plane plus the rim's own
 * departure from it, blended in from the centre. The eye pieces themselves
 * are not placed. Returns the plug, or null with a note when the eyes and the
 * head do not match.
 */
export async function seatEyes(goose: ManifoldT, eyes: Part, material: number, firstID: number, log = (s: string) => console.log(s)): Promise<ManifoldT[] | null> {
  const f = (n: number) => n.toFixed(1);
  const pieces = (await toManifold(eyes.mesh)).decompose().filter((p) => p.volume() > 1);
  const pins = pieces.map((p) => {
    const bb = p.boundingBox();
    // the pin runs from the bottom up to the widest cross-section, where the dome begins (a real pin may taper a little)
    const areas: [number, number][] = [];
    for (let z = bb.min[2] + 0.2; z < bb.max[2] - 0.2; z += 0.1) areas.push([z, p.slice(z).area()]);
    const widest = Math.max(...areas.map((a) => a[1]));
    const top = areas.find((a) => a[1] >= widest * 0.98)![0];
    return { radius: Math.sqrt(widest / Math.PI), length: top - bb.min[2] };
  });
  if (!pins.length) { log('  eyes: no pieces'); return null; }
  const mesh = fromManifold(goose);
  const tubes: Tube[] = [];
  findVoids(mesh, tubes);
  const r = pins[0].radius;
  const channel = tubes.filter((t) => Math.abs(t.radius - r) < 0.6).sort((a, b) => b.wallFaces - a.wallFaces)[0];
  if (!channel) { log(`  eyes: no channel through the goose matches the ${f(r * 2)} mm pins (tubes: ${tubes.map((t) => `${f(t.radius * 2)} mm x ${f(t.length)}`).join(', ') || 'none'})`); return null; }
  log(`  eyes: ${pins.length} pieces, ${f(r * 2)} mm pins ${f(pins[0].length)} mm long; channel ${f(channel.radius * 2)} x ${f(channel.length)} mm at (${channel.center.map(f).join(', ')}) axis (${channel.axis.map(f).join(', ')})`);
  const mid = channel.ends[0].map((v, i) => (v + channel.ends[1][i]) / 2) as V3;
  const plugs: ManifoldT[] = [];
  const notes: string[] = [];
  for (const side of [-1, 1]) {
    const half = await capPlug(mesh, mid, channel.axis.map((v) => v * side) as V3, channel.radius + 0.1, channel.length / 2);
    plugs.push(half.plug);
    notes.push(`rim ${f(half.rimLow)} to ${f(half.rimHigh)} mm out${half.misses ? `, ${half.misses} rays missed` : ''}`);
  }
  const { Manifold } = await manifold();
  const plug = Manifold.union(plugs);
  log(`  eyes: plug ${f(plug.volume())} mm³, capped to the head (${notes.join('; ')})`);
  return [await retag(plug, firstID, material)];
}

type V3 = [number, number, number];

/**
 * Half of the eye plug: a cylinder of radius `r` from just behind `mid` out
 * along `dir`, whose end follows the head's surface across the hole. `mesh`
 * is the head with the channel open.
 */
async function capPlug(mesh: { positions: Float32Array; triangles: Uint32Array }, mid: V3, dir: V3, r: number, halfLength: number) {
  const N = 48, K = 6;
  const helper: V3 = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = norm(cross(helper, dir)), e2 = cross(dir, e1);
  const at = (rho: number, th: number, t: number): V3 => [0, 1, 2].map((i) => mid[i] + dir[i] * t + (e1[i] * Math.cos(th) + e2[i] * Math.sin(th)) * rho) as V3;
  // the triangles near this mouth, for the rays
  const reach = halfLength + r + 6;
  const near: number[] = [];
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const v = mesh.triangles[t] * 3;
    const d = [mesh.positions[v] - mid[0], mesh.positions[v + 1] - mid[1], mesh.positions[v + 2] - mid[2]];
    const along = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2];
    if (along < -1 || along > reach || Math.hypot(...d) > reach + 2) continue;
    near.push(t);
  }
  // the rim: where a ray along the channel, just outside its wall, leaves the head
  const rim: number[] = [];
  let misses = 0;
  for (let j = 0; j < N; j++) {
    const th = (j / N) * Math.PI * 2;
    const o = at(r + 0.02, th, 0);
    let best = Infinity;
    for (const t of near) {
      const hit = rayTriangle(o, dir, mesh, t);
      if (hit > 0.2 && hit < best) best = hit;
    }
    if (!Number.isFinite(best)) { misses++; best = halfLength; }
    rim.push(best);
  }
  // a plane through the rim (t = c0 + c1 cos + c2 sin at the rim radius), plus the rim's own departure from it, blended in from the centre
  let c0 = 0, c1 = 0, c2 = 0;
  for (let j = 0; j < N; j++) { const th = (j / N) * Math.PI * 2; c0 += rim[j] / N; c1 += (2 * rim[j] * Math.cos(th)) / N; c2 += (2 * rim[j] * Math.sin(th)) / N; }
  const cap = (k: number, j: number) => {
    const th = (j / N) * Math.PI * 2, s = k / K;
    const plane = c0 + s * (c1 * Math.cos(th) + c2 * Math.sin(th));
    return plane + s * (rim[j] - (c0 + c1 * Math.cos(th) + c2 * Math.sin(th))) + 0.03; // a hair proud, so the cap covers the hole
  };
  // vertices: the back centre and ring (0.5 mm behind the middle, so the halves overlap), the cap centre and rings 1..K
  const pos: number[] = [];
  const push = (p: V3) => { pos.push(...p); return pos.length / 3 - 1; };
  const backC = push(at(0, 0, -0.5));
  const back: number[] = [];
  for (let j = 0; j < N; j++) back.push(push(at(r, (j / N) * Math.PI * 2, -0.5)));
  const capC = push(at(0, 0, cap(0, 0)));
  const rings: number[][] = [];
  for (let k = 1; k <= K; k++) { const ring: number[] = []; for (let j = 0; j < N; j++) ring.push(push(at((k / K) * r, (j / N) * Math.PI * 2, cap(k, j)))); rings.push(ring); }
  const tri: number[] = [];
  for (let j = 0; j < N; j++) {
    const j2 = (j + 1) % N;
    tri.push(backC, back[j2], back[j]); // back disc, facing -dir
    tri.push(back[j], back[j2], rings[K - 1][j2], back[j], rings[K - 1][j2], rings[K - 1][j]); // wall
    tri.push(capC, rings[0][j], rings[0][j2]); // cap centre fan, facing +dir
    for (let k = 1; k < K; k++) tri.push(rings[k - 1][j], rings[k][j], rings[k][j2], rings[k - 1][j], rings[k][j2], rings[k - 1][j2]);
  }
  const m = { positions: Float32Array.from(pos), triangles: Uint32Array.from(tri) };
  let plug = await toManifold(m);
  if (plug.volume() < 0) plug = await toManifold({ positions: m.positions, triangles: Uint32Array.from(tri.map((_, i) => tri[i - (i % 3) + (2 - (i % 3))])) });
  return { plug, rimLow: Math.min(...rim) - halfLength, rimHigh: Math.max(...rim) - halfLength, misses };
}

/** Distance along `d` from `o` to triangle `t` of the mesh (Möller–Trumbore), or -1. */
function rayTriangle(o: V3, d: V3, mesh: { positions: Float32Array; triangles: Uint32Array }, t: number): number {
  const P = (i: number): V3 => { const v = mesh.triangles[t + i] * 3; return [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]]; };
  const a = P(0), b = P(1), c = P(2);
  const ab = sub(b, a), ac = sub(c, a);
  const p = cross(d, ac);
  const det = dot(ab, p);
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return -1;
  const q = cross(s, ab);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return -1;
  return dot(ac, q) * inv;
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

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

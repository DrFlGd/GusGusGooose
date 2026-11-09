// Builds the slide-in-magnet print of the goose: the body with a channel
// from each magnet seat to a covered mouth, plus the loose parts that close
// the mouths and the parts that are no longer printed in place. Nothing
// here touches the app's goose (goose/goose.stl, goose/profile.json): the
// seats, and so the accessory alignment, are exactly the ones in the fit
// profile.
//
//   node src/build-slots.ts [goose/goose.3mf] [--voids goose/goose-voids.3mf] [--out goose/goose-slots.3mf] [--parts dir]
//
// Channels (see docs/PLAN.md, "Slide-in magnets"):
// - head: 3 mm straight down from the seat, then forward and down to the
//   face where the beak sits. A white key fills the channel behind the
//   magnet and the beak glues over it.
// - wings: from each seat down and inward to the belly behind that leg,
//   where the stance hides the mouth. A white key fills each.
// - beak: its magnet already slides in from the beak's back; the beak is
//   printed on its own (orange), magnet in, then glued to the face.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { read3mf, type Part } from './threemf.ts';
import { fromManifold, manifold, toManifold } from './fit.ts';
import { mapNegatives, type VoidPrimitive } from './map-voids.ts';
import { buildChannel, columnMajor, type Channel, type ChannelSpec, type V3 } from './slots.ts';
import { write3mfBuild, type Material, type MeshPart } from './threemf-write.ts';
import { serializeStl } from './stl.ts';

const f1 = (n: number) => n.toFixed(1);
const fv = (a: readonly number[]) => a.map(f1).join(', ');

export interface SlotsBuild {
  materials: Material[];
  /** printed in place: body, base, legs (pins cut) */
  goose: { body: ManifoldT; base: ManifoldT; legs: ManifoldT[] };
  beak: ManifoldT;
  eyes?: ManifoldT;
  channels: Record<string, Channel>;
  /** the body before any void was cut, for pictures and checks */
  bodySolid: ManifoldT;
  pins: ManifoldT | null;
}

/** Where each channel comes out, chosen by scanning the body (2026-11-09): single mouth, no break-out, clear of the legs and the leg pins. */
export const MOUTHS: Record<string, { mouth: V3; drop: number }> = {
  head: { mouth: [131, 93, 169.5], drop: 3 },
  left_wing: { mouth: [122, 154, 38.1], drop: 0 },
  right_wing: { mouth: [94, 143, 37.1], drop: 0 },
};

export async function buildSlots(parts: Part[], voidParts: Part[], log = (s: string) => console.log(s)): Promise<SlotsBuild> {
  const { Manifold } = await manifold();
  const voids = mapNegatives(parts, voidParts);
  const normal = parts.filter((p) => p.kind === 'normal');
  const solids = new Map<string, ManifoldT>();
  for (const p of normal) solids.set(p.name, await toManifold(p.mesh));
  const white = normal.find((p) => /white/i.test(p.name))!;
  const nose = normal.find((p) => /nose|beak/i.test(p.name))!;
  const base = normal.find((p) => /cylinder|base/i.test(p.name))!;
  const legs = normal.filter((p) => p !== white && p !== nose && p !== base);
  const eyesPart = [...voidParts, ...parts].find((p) => p.kind === 'normal' && /eye|black/i.test(p.name));
  const negatives = parts.filter((p) => p.kind === 'negative');
  const pins = negatives.length ? Manifold.union(await Promise.all(negatives.map((p) => toManifold(p.mesh)))) : null;

  // materials in the print's filament order, as build-goose
  const slots = [...new Set([...normal, ...(eyesPart ? [eyesPart] : [])].map((p) => p.extruder ?? 1))].sort((a, b) => a - b);
  const materials: Material[] = slots.map((slot) => {
    const users = normal.filter((p) => (p.extruder ?? 1) === slot);
    const names = [...new Set(users.map((p) => p.name.replace(/\s*\(.*\)|\.stl|_\d+$/gi, '').trim()))];
    return { name: names.join(' + ') || 'eyes', color: users.find((p) => p.color)?.color ?? '#1a1a1a' };
  });
  if (eyesPart && !normal.some((p) => (p.extruder ?? 1) === (eyesPart.extruder ?? 1))) materials[slots.indexOf(eyesPart.extruder ?? 1)] = { name: 'eyes', color: '#1a1a1a' };

  // the seats in the body, named as the fit profile names them
  const bodySolid = solids.get(white.name)!;
  const seats = voids.filter((v) => v.anchor === white.name && v.kind !== 'pin');
  const named = new Map<string, VoidPrimitive>();
  for (const s of seats) named.set(s.kind === 'cylinder' ? 'head' : s.center[0] > 115 ? 'left_wing' : 'right_wing', s);
  const channels: Record<string, Channel> = {};
  const cuts: ManifoldT[] = [];
  for (const [name, place] of Object.entries(MOUTHS)) {
    const seat = named.get(name);
    if (!seat) { log(`  ${name}: no seat in the body`); continue; }
    // outward: from the seat toward the surface, along the seat's thin axis
    const axisK = seat.kind === 'box' ? seat.size.indexOf(Math.min(...seat.size)) : 2;
    // outward: the seat's thin axis, pointed at the nearer skin (the head's is up; a wing's is away from the body's middle)
    let outward = seat.axes[axisK];
    const bb = bodySolid.boundingBox();
    const mid = (bb.min[0] + bb.max[0]) / 2;
    const want: V3 = seat.kind === 'cylinder' ? [0, 0, 1] : [seat.center[0] > mid ? 1 : -1, 0, 0];
    if (outward[0] * want[0] + outward[1] * want[1] + outward[2] * want[2] < 0) outward = outward.map((v) => -v) as V3;
    const spec: ChannelSpec = { seat, mouth: place.mouth, drop: place.drop };
    const ch = buildChannel(Manifold, spec, outward, bodySolid);
    channels[name] = ch;
    cuts.push(ch.cut);
    const inside = ch.cut.intersect(bodySolid);
    const outside = ch.cut.subtract(bodySolid).decompose().filter((p) => p.volume() > 0.3);
    log(`  ${name.padEnd(10)} seat ${fv(seat.size)} at (${fv(seat.center)}), channel ${f1(ch.length)} mm to the mouth at (${fv(place.mouth)}), bore ${f1(ch.bore[0])} x ${f1(ch.bore[1])} mm${place.drop ? `, ${place.drop} mm straight drop under the seat` : ''}; ${f1(inside.volume())} mm³ cut, ${outside.length} opening${outside.length === 1 ? '' : 's'}; key ${f1(ch.key.volume())} mm³`);
  }
  const bodyCut = bodySolid.subtract(Manifold.union(cuts));
  const body = pins ? bodyCut.subtract(pins) : bodyCut;
  // the beak: its own voids (seat and slide-in slot) cut; printed loose
  const beakVoids = voids.filter((v) => v.anchor === nose.name);
  let beak = solids.get(nose.name)!;
  if (beakVoids.length) beak = beak.subtract(Manifold.union(await Promise.all(beakVoids.map((v) => toManifold(v.mesh)))));
  log(`  beak: ${beakVoids.length} voids of its own (${beakVoids.map((v) => `${v.kind} ${fv(v.size)}`).join('; ')}), slides in from the back as before`);
  const legSolids = legs.map((l) => { const s = solids.get(l.name)!; return pins ? s.subtract(pins) : s; });
  const baseSolid = pins ? solids.get(base.name)!.subtract(pins) : solids.get(base.name)!;
  const eyes = eyesPart ? await toManifold(eyesPart.mesh) : undefined;
  return { materials, goose: { body, base: baseSolid, legs: legSolids }, beak, eyes, channels, bodySolid, pins };
}

/** Lays a loose part flat on the plate: `down` (world direction) turned to -z, dropped to z = 0, centred on (x, y). */
export function layFlat(m: ManifoldT, down: V3, x: number, y: number): ManifoldT {
  const d = norm(down);
  const target: V3 = [0, 0, -1];
  const axis = cross(d, target);
  const s = Math.hypot(...axis), c = dot(d, target);
  let r = m;
  if (s > 1e-6) {
    const a = norm(axis), ang = Math.atan2(s, c);
    // Rodrigues rotation as a column-major 4x4
    const K = (v: V3): V3 => {
      const cv = cross(a, v);
      return [0, 1, 2].map((i) => v[i] * Math.cos(ang) + cv[i] * Math.sin(ang) + a[i] * dot(a, v) * (1 - Math.cos(ang))) as V3;
    };
    r = m.transform(columnMajor([K([1, 0, 0]), K([0, 1, 0]), K([0, 0, 1])], [0, 0, 0]) as any);
  } else if (c < 0) r = m.rotate([180, 0, 0]);
  const bb = r.boundingBox();
  return r.translate([x - (bb.min[0] + bb.max[0]) / 2, y - (bb.min[1] + bb.max[1]) / 2, -bb.min[2]]);
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

if (process.argv[1]?.endsWith('build-slots.ts')) {
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  const opt = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const src = positional[0] ?? 'goose/goose.3mf';
  const voidsPath = opt('voids') ?? 'goose/goose-voids.3mf';
  const out = opt('out') ?? 'goose/goose-slots.3mf';
  const partsDir = opt('parts');
  const parts = read3mf(src), voidParts = read3mf(voidsPath);
  console.log(`${parts.length} parts in ${src}, voids from ${voidsPath}`);
  const b = await buildSlots(parts, voidParts);
  const { Manifold } = await manifold();
  const mat = (name: RegExp) => Math.max(0, b.materials.findIndex((m) => name.test(m.name)));
  const white = mat(/white/i), orange = mat(/orange/i), green = mat(/cylinder|green|base/i), black = mat(/eyes|black/i);
  const parcel = (name: string, m: ManifoldT, material: number): MeshPart => ({ name, mesh: fromManifold(m), material });
  // loose parts in a row beside the plate's goose (the base is a 100 mm disc; the plate is 256 mm)
  const gooseBB = Manifold.union([b.goose.body, b.goose.base]).boundingBox();
  const row = gooseBB.max[0] + 22;
  let y = gooseBB.min[1] + 10;
  const place = (m: ManifoldT, down: V3) => { const bb = m.boundingBox(); const size = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]]; const flat = layFlat(m, down, row, y + Math.max(size[0], size[1]) / 2); y += Math.max(size[0], size[1]) + 8; return flat; };
  const objects = [
    { name: 'goose', parts: [parcel('body', b.goose.body, white), parcel('base', b.goose.base, green), ...b.goose.legs.map((l, i) => parcel(`leg ${i + 1}`, l, orange))] },
    // the beak lies on its back face (the face that meets the head), which is roughly the direction its slot runs
    { name: 'beak', parts: [parcel('beak', place(b.beak, [-0.4, 0.9, 0.1]), orange)] },
    ...Object.entries(b.channels).map(([name, ch]) => {
      // keys lie on the seat's face plane: the seat's thin axis up
      const axisK = ch.spec.seat.kind === 'box' ? ch.spec.seat.size.indexOf(Math.min(...ch.spec.seat.size)) : 2;
      return { name: `key ${name.replace('_', ' ')}`, parts: [parcel(`key ${name.replace('_', ' ')}`, place(ch.key, ch.spec.seat.axes[axisK]), white)] };
    }),
    ...(b.eyes ? [{ name: 'eyes', parts: [parcel('eyes', place(b.eyes, [0, 0, -1]), black)] }] : []),
  ];
  writeFileSync(out, write3mfBuild(objects, b.materials, 'Gus Gus Goose, slide-in magnets'));
  console.log(`written ${out}: ${objects.map((o) => o.name).join(', ')}; materials ${b.materials.map((m, i) => `${i + 1} ${m.name} ${m.color}`).join(', ')}`);
  if (partsDir) {
    if (!existsSync(partsDir)) mkdirSync(partsDir, { recursive: true });
    for (const o of objects) for (const p of o.parts) writeFileSync(join(partsDir, `${o.name === p.name ? p.name : `${o.name}-${p.name}`}.stl`.replace(/\s+/g, '-')), serializeStl(p.mesh));
    console.log(`STLs in ${partsDir}`);
  }
  const bodies = b.goose.body.decompose().length;
  console.log(`body: ${f1(b.goose.body.volume())} mm³ (${f1(b.bodySolid.volume() - b.goose.body.volume())} mm³ removed), ${bodies} piece${bodies === 1 ? '' : 's'}, ${b.goose.body.numTri()} triangles`);
}

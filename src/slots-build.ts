// Builds the slide-in-magnet print of the goose from the project 3MFs: the
// body with a channel from each magnet seat to a covered mouth, plus the
// loose parts that close the mouths and the parts no longer printed in
// place. Pure (no Node APIs): the CLI in build-slots.ts and the app's Goose
// tab both use it. Nothing here touches the app's goose (goose/goose.stl,
// goose/profile.json): the seats, and so the accessory alignment, are
// exactly the ones in the fit profile.
//
// Channels (see docs/PLAN.md, "Slide-in magnets"):
// - head: 3 mm straight down from the seat, then forward and down to the
//   face where the beak sits. A white key fills the channel behind the
//   magnet; its tongue registers in a pocket in the beak, which glues on.
// - wings: from each seat down and inward to the belly behind that leg,
//   where the stance hides the mouth. A white key fills each.
// - beak: its magnet already slides in from the beak's back; the beak is
//   printed on its own (orange), magnet in, then glued to the face.

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { Part } from './threemf-parse.ts';
import { fromManifold, manifold, toManifold } from './fit.ts';
import { mapNegatives, type VoidPrimitive } from './map-voids.ts';
import { buildChannel, columnMajor, DEFAULT_SLOTS, type Channel, type ChannelSpec, type SlotOptions, type V3 } from './slots.ts';
import type { BuildObject, Material, MeshPart } from './threemf-write.ts';

const f1 = (n: number) => n.toFixed(1);
const fv = (a: readonly number[]) => a.map(f1).join(', ');

export interface SlotsBuild {
  options: SlotOptions;
  materials: Material[];
  /** printed in place: body, base, legs (pins cut) */
  goose: { body: ManifoldT; base: ManifoldT; legs: ManifoldT[] };
  /** the beak with its own voids cut, and the pocket for the head key's tongue */
  beak: ManifoldT;
  eyes?: ManifoldT;
  channels: Record<string, Channel>;
  /** the body before any void was cut, for pictures and checks */
  bodySolid: ManifoldT;
  pins: ManifoldT | null;
  /** notes for the person: what was checked and what to watch */
  notes: string[];
}

/** Where each channel comes out, chosen by scanning the body (2026-11-09): single mouth, no break-out, clear of the legs and the leg pins. */
export const MOUTHS: Record<string, { mouth: V3; drop: number; tongue?: boolean; levelEnd?: boolean }> = {
  head: { mouth: [131, 93, 169.5], drop: 3, tongue: true, levelEnd: false },
  left_wing: { mouth: [123, 155, 38.5], drop: 0 },
  right_wing: { mouth: [95, 144, 37.2], drop: 0 },
};

export async function buildSlots(parts: Part[], voidParts: Part[], options: SlotOptions = DEFAULT_SLOTS, log = (s: string) => console.log(s)): Promise<SlotsBuild> {
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
  const notes: string[] = [];

  // materials in the print's filament order, as build-goose
  const slots = [...new Set([...normal, ...(eyesPart ? [eyesPart] : [])].map((p) => p.extruder ?? 1))].sort((a, b) => a - b);
  const materials: Material[] = slots.map((slot) => {
    const users = normal.filter((p) => (p.extruder ?? 1) === slot);
    const names = [...new Set(users.map((p) => p.name.replace(/\s*\(.*\)|\.stl|_\d+$/gi, '').trim()))];
    return { name: names.join(' + ') || 'eyes', color: users.find((p) => p.color)?.color ?? '#1a1a1a' };
  });

  // the seats in the body, named as the fit profile names them
  const bodySolid = solids.get(white.name)!;
  const seats = voids.filter((v) => v.anchor === white.name && v.kind !== 'pin');
  const bb = bodySolid.boundingBox();
  const mid = (bb.min[0] + bb.max[0]) / 2;
  const named = new Map<string, VoidPrimitive>();
  for (const s of seats) named.set(s.kind === 'cylinder' ? 'head' : s.center[0] > mid ? 'left_wing' : 'right_wing', s);
  const channels: Record<string, Channel> = {};
  const cuts: ManifoldT[] = [];
  for (const [name, place] of Object.entries(MOUTHS)) {
    const seat = named.get(name);
    if (!seat) { log(`  ${name}: no seat in the body`); continue; }
    // outward: the seat's thin axis, pointed at the nearer skin (the head's is up; a wing's is away from the body's middle)
    const axisK = seat.kind === 'box' ? seat.size.indexOf(Math.min(...seat.size)) : 2;
    let outward = seat.axes[axisK];
    const want: V3 = seat.kind === 'cylinder' ? [0, 0, 1] : [seat.center[0] > mid ? 1 : -1, 0, 0];
    if (outward[0] * want[0] + outward[1] * want[1] + outward[2] * want[2] < 0) outward = outward.map((v) => -v) as V3;
    const spec: ChannelSpec = { seat, mouth: place.mouth, drop: place.drop, tongue: place.tongue, levelEnd: place.levelEnd };
    const ch = buildChannel(Manifold, spec, outward, bodySolid, options);
    channels[name] = ch;
    cuts.push(ch.cut);
    const inside = ch.cut.intersect(bodySolid);
    const outside = ch.cut.subtract(bodySolid).decompose().filter((p) => p.volume() > 0.3);
    log(`  ${name.padEnd(10)} seat ${fv(seat.size)} at (${fv(seat.center)}), channel ${f1(ch.length)} mm to the mouth at (${fv(place.mouth)}), bore ${f1(ch.bore[0])} x ${f1(ch.bore[1])} mm${place.drop ? `, ${place.drop} mm straight drop under the seat` : ''}; ${f1(inside.volume())} mm³ cut, ${outside.length} opening${outside.length === 1 ? '' : 's'}; key ${f1(ch.key.volume())} mm³${ch.tongue ? `, tongue ${f1(ch.tongue.volume())} mm³` : ''}`);
    if (outside.length !== 1) notes.push(`${name}: the channel opens ${outside.length} times; it should open once, under its cover.`);
  }
  const bodyCut = bodySolid.subtract(Manifold.union(cuts));
  const body = pins ? bodyCut.subtract(pins) : bodyCut;
  // the beak: its own voids (seat and slide-in slot) cut, and the pocket for the head key's tongue; printed loose
  const beakVoids = voids.filter((v) => v.anchor === nose.name);
  let beak = solids.get(nose.name)!;
  const beakVoidSolid = beakVoids.length ? Manifold.union(await Promise.all(beakVoids.map((v) => toManifold(v.mesh)))) : null;
  if (beakVoidSolid) beak = beak.subtract(beakVoidSolid);
  log(`  beak: ${beakVoids.length} voids of its own (${beakVoids.map((v) => `${v.kind} ${fv(v.size)}`).join('; ')}), slides in from the back as before`);
  const headPocket = channels.head?.pocket;
  if (headPocket) {
    const pocketInBeak = headPocket.intersect(beak);
    const hitsVoid = beakVoidSolid ? headPocket.intersect(beakVoidSolid).volume() : 0;
    const tongueOutside = channels.head.tongue ? channels.head.tongue.subtract(beak).subtract(bodySolid).volume() : 0;
    beak = beak.subtract(headPocket);
    log(`  beak pocket: ${f1(pocketInBeak.volume())} mm³ for the tongue${hitsVoid > 0.01 ? `, ${f1(hitsVoid)} mm³ INTO THE BEAK'S MAGNET SLOT` : ', clear of the beak\'s magnet slot'}${tongueOutside > 0.5 ? `, ${f1(tongueOutside)} mm³ of tongue beside the beak` : ''}`);
    if (hitsVoid > 0.01) notes.push(`The tongue pocket cuts into the beak's own magnet slot by ${f1(hitsVoid)} mm³: move the tongue up (offset) or make it smaller.`);
    if (tongueOutside > 0.5) notes.push(`${f1(tongueOutside)} mm³ of the tongue stands beside the beak rather than in it.`);
  }
  const legSolids = legs.map((l) => { const s = solids.get(l.name)!; return pins ? s.subtract(pins) : s; });
  const baseSolid = pins ? solids.get(base.name)!.subtract(pins) : solids.get(base.name)!;
  const eyes = eyesPart ? await toManifold(eyesPart.mesh) : undefined;
  return { options, materials, goose: { body, base: baseSolid, legs: legSolids }, beak, eyes, channels, bodySolid, pins, notes };
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

/**
 * Which way a key lies on the plate: the swept key on the seat's face plane
 * (thin axis up); a flat key on its wide side; an upright key (level end)
 * on that end, upside down, so its outer face prints with the goose's own
 * layer lines. The head key always lies down: its channel runs nearly level,
 * so upright it would lean too far.
 */
export function keyDown(name: string, ch: Channel): V3 {
  const seat = ch.spec.seat;
  if (ch.options.style === 'swept') {
    const axisK = seat.kind === 'box' ? seat.size.indexOf(Math.min(...seat.size)) : 2;
    return seat.axes[axisK];
  }
  if (ch.options.keyEnd === 'level' && name !== 'head') return [0, 0, 1];
  return ch.frame.through;
}

/** The print: goose (body, base, legs) in place, loose parts in a row beside it. */
export function layoutBuild(b: SlotsBuild): BuildObject[] {
  const mat = (name: RegExp) => Math.max(0, b.materials.findIndex((m) => name.test(m.name)));
  const white = mat(/white/i), orange = mat(/orange/i), green = mat(/cylinder|green|base/i), black = mat(/eyes|black/i);
  const parcel = (name: string, m: ManifoldT, material: number): MeshPart => ({ name, mesh: fromManifold(m), material });
  const bodyBB = b.goose.body.boundingBox(), baseBB = b.goose.base.boundingBox();
  const row = Math.max(bodyBB.max[0], baseBB.max[0]) + 22;
  let y = Math.min(bodyBB.min[1], baseBB.min[1]) + 10;
  const place = (m: ManifoldT, down: V3) => {
    const flat0 = layFlat(m, down, 0, 0);
    const bb = flat0.boundingBox();
    const size = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]];
    const flat = flat0.translate([row, y + size[1] / 2, 0]);
    y += size[1] + 8;
    return flat;
  };
  return [
    { name: 'goose', parts: [parcel('body', b.goose.body, white), parcel('base', b.goose.base, green), ...b.goose.legs.map((l, i) => parcel(`leg ${i + 1}`, l, orange))] },
    // the beak lies on its back face (the face that meets the head), pocket up
    { name: 'beak', parts: [parcel('beak', place(b.beak, [-0.4, 0.9, 0.1]), orange)] },
    ...Object.entries(b.channels).map(([name, ch]) => {
      const label = `key ${name.replace('_', ' ')}`;
      return { name: label, parts: [parcel(label, place(ch.key, keyDown(name, ch)), white)] };
    }),
    ...(b.eyes ? [{ name: 'eyes', parts: [parcel('eyes', place(b.eyes, [0, 0, -1]), black)] }] : []),
  ];
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

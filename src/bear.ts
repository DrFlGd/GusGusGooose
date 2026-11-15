// The bear desk character (Jerred, 2026-11-14): his "Bear V1" model, a curly
// bear sitting up with its paws raised, simplified to 0.02 mm
// (characters/bear/bear-source.stl), painted brown with black eyes and nose,
// its bottom trimmed flat so it stands on a desk, and four magnet seats: in
// the top of the head and in the mouth (the goose's 10 x 4 mm magnets), and
// under each wrist (8 x 3 mm), so an accessory there looks held under the
// paws. Each seat has a slide-in channel with a key that fills it, as on the
// goose and the otter (src/desk-character.ts). Pure (no Node APIs): the CLI
// (build-character.ts) makes the app's bear files from the source model, and
// the app builds the slide-in print from those files with the same code.

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import type { Material } from './threemf-write.ts';
import type { MagnetVoid } from './voids.ts';
import type { FitProfile } from './fit.ts';
import { DEFAULT_PROFILE, fromManifoldTagged, manifold, toManifoldTagged } from './fit.ts';
import { DEFAULT_SLOTS, outerFace, seatSolid, type SlotOptions, type V3 } from './slots.ts';
import { buildCharacterSlots, cropMesh, faceData, modeFilter, smoothBorders, patchNormal, placeSeat, rayHit, SEAT_SKIN, seatFromPoint, watershed, type ChannelPlan, type CharacterSlotsBuild } from './desk-character.ts';

/** mm cut off the bottom of the source model: the rounded seat, feet and tail tip become one flat footing. */
export const BEAR_TRIM = 2.5;

/** Brown (filament 1, the object's own) and black for the eyes and nose. */
export const BEAR_MATERIALS: Material[] = [
  { name: 'brown', color: '#8b5a2b' },
  { name: 'black', color: '#1a1a1a' },
];
export const BROWN = 0, BLACK = 1;

// ---------- paint ----------

/**
 * Seeds for the paint, in the source model's frame (z up, facing −y, 65 x 80
 * x 118 mm; the face is centred on x 37.3 and the head leans a little, so the
 * bear's left eye sits 3 mm higher than its right): rays from the front (F
 * x,z), back (B x,z), above (U x,y) and the sides (L/R y,z).
 */
const SEEDS: [number, 'F' | 'B' | 'U' | 'L' | 'R', number, number][] = [
  // black: the nose and the two eyeballs (each a dome inside a rim)
  [BLACK, 'F', 37.3, 91.2], [BLACK, 'F', 26, 99], [BLACK, 'F', 41.3, 102.2],
  // brown: round the eyes and nose, so each black dome stops at its own crease
  [BROWN, 'F', 37.3, 83], [BROWN, 'F', 31, 86], [BROWN, 'F', 44, 87], [BROWN, 'F', 44.5, 91.5], [BROWN, 'F', 30.5, 91.5], [BROWN, 'F', 33.5, 101], [BROWN, 'F', 26, 104], [BROWN, 'F', 41.3, 107],
  [BROWN, 'F', 20, 96], [BROWN, 'F', 47, 99], [BROWN, 'F', 37.3, 96], [BROWN, 'F', 22, 90], [BROWN, 'F', 52, 92],
  // and everywhere else
  [BROWN, 'F', 34, 112], [BROWN, 'F', 27, 58], [BROWN, 'F', 47, 58], [BROWN, 'F', 37, 45], [BROWN, 'F', 20, 10], [BROWN, 'F', 50, 10],
  [BROWN, 'B', 34, 60], [BROWN, 'B', 34, 100], [BROWN, 'B', 34, 20], [BROWN, 'U', 34, 38], [BROWN, 'L', 40, 60], [BROWN, 'R', 40, 60], [BROWN, 'L', 40, 100], [BROWN, 'R', 40, 100],
];

/**
 * Paints the source model: per-triangle BROWN or BLACK. A watershed from the
 * seeds over the surface, flooding in order of curvature, so the black meets
 * the brown along the crease round the nose and round each eyeball; a mode
 * filter and a half-millimetre smoothing then take the teeth off the borders.
 */
export function paintBear(mesh: IndexedMesh): Uint8Array {
  const fd = faceData(mesh);
  const cast = (dir: string, a: number, b: number) => {
    const [o, d]: [V3, V3] = dir === 'F' ? [[a, -50, b], [0, 1, 0]] : dir === 'B' ? [[a, 200, b], [0, -1, 0]] : dir === 'U' ? [[a, b, 250], [0, 0, -1]] : dir === 'L' ? [[-50, a, b], [1, 0, 0]] : [[150, a, b], [-1, 0, 0]];
    return rayHit(mesh, o, d).face;
  };
  const label = watershed(fd, SEEDS.map(([l, dir, a, b]) => ({ face: cast(dir, a, b), label: l })));
  const out = new Uint8Array(label.length);
  for (let t = 0; t < out.length; t++) out[t] = label[t] < 0 ? BROWN : label[t];
  modeFilter(fd, out);
  smoothBorders(fd, out, 0.5);
  return out;
}

// ---------- magnet seats ----------

/** Where each wrist seat sits, front to back (trimmed frame): under the forearm just behind the hanging paw. */
export const WRIST_Y = 15;
/**
 * The wrists take 8 x 3 mm magnets: the left forearm joins the body through
 * a neck too narrow for a 10 mm magnet to slide back through with any wall
 * left (scanned 2026-11-15); an 8 mm one clears it by about a millimetre.
 */
export const WRIST_SEAT = { diameter: 8.2, depth: 3.2 };

/** The candidate seat with the least plastic over its centre: where the curly surface is flattest across the magnet. */
function flattest(seats: MagnetVoid[]): MagnetVoid {
  return seats.reduce((a, b) => (b.skin! < a.skin! - 1e-6 ? b : a));
}

/**
 * The four seats, found on the trimmed model:
 * - head: on the crown, axis straight up, where the curls are flattest
 *   across the magnet (the top is lumpy, so the very highest curl would
 *   leave 4 to 6 mm of plastic over the magnet's centre);
 * - mouth: in the front of the muzzle under the nose, axis square to it
 *   there (forward and a little down), where the beard is flattest, so a
 *   held thing crosses the mouth;
 * - left_wrist, right_wrist (the bear's own left is +x): under each forearm
 *   where it leaves the hanging paw, axis straight down, so an accessory
 *   there sits under the paw; 8 x 3 mm magnets (WRIST_SEAT).
 */
export function bearSeats(mesh: IndexedMesh): Record<string, MagnetVoid> {
  // the crown: the head's top within 3 mm of its highest point
  // (the searches cast their rays against the part of the bear round each place only)
  const crown = cropMesh(mesh, [10, 15, 90], [60, 60, 200]);
  const tops: { q: V3; z: number }[] = [];
  for (let x = 28; x <= 42; x += 1) for (let y = 30; y <= 44; y += 1) {
    const hit = rayHit(crown, [x, y, 150], [0, 0, -1]);
    if (hit.face >= 0) tops.push({ q: [x, y, 150 - hit.t], z: 150 - hit.t });
  }
  const zTop = Math.max(...tops.map((t) => t.z));
  const head = flattest(tops.filter((t) => t.z > zTop - 3).map((t) => placeSeat(crown, t.q, [0, 0, 1])));
  // the mouth: round the face's middle (x 37.3), 79.5 to 83.5 mm up, under the nose
  const muzzle = cropMesh(mesh, [15, -60, 55], [60, 30, 100]);
  const mouths: MagnetVoid[] = [];
  for (let x = 35.3; x <= 39.31; x += 0.5) for (let z = 79.5; z <= 83.51; z += 0.5) {
    const at = patchNormal(muzzle, [x, 0, z], [0, 1, 0], [1, 0, 0], [0, 0, 1], 4);
    mouths.push(placeSeat(muzzle, at.point, [0, at.normal[1], at.normal[2]], SEAT_SKIN, undefined, 15));
  }
  const mouth = flattest(mouths);
  // the wrists: the forearm's middle across (from its sides 60 mm up), its underside from below
  const wrist = (x0: number, x1: number) => {
    const a = rayHit(mesh, [x0, WRIST_Y, 60], [1, 0, 0]), b = rayHit(mesh, [x1, WRIST_Y, 60], [-1, 0, 0]);
    const x = (x0 + a.t + x1 - b.t) / 2;
    const under = rayHit(mesh, [x, WRIST_Y, 40], [0, 0, 1]);
    return placeSeat(mesh, [x, WRIST_Y, 40 + under.t], [0, 0, -1], SEAT_SKIN, WRIST_SEAT, 6, true);
  };
  return { head, mouth, left_wrist: wrist(37.5, 60), right_wrist: wrist(15, 37) };
}

// ---------- the body ----------

export interface BearBody {
  /** painted, trimmed, the seats cut: what accessories fit against */
  body: ManifoldT;
  /** the same before the seats were cut */
  solid: ManifoldT;
  faceMaterial: Uint8Array;
  mesh: IndexedMesh;
  profile: FitProfile;
  firstID: number;
}

/**
 * From the painted source model: trims the bottom flat (z = 0 afterwards; the
 * cut is brown), places the seats and cuts them.
 */
export async function buildBearBody(source: IndexedMesh, paint: Uint8Array, log = (s: string) => console.log(s)): Promise<BearBody> {
  const { Manifold } = await manifold();
  const firstID = Manifold.reserveIDs(BEAR_MATERIALS.length);
  const tagged = await toManifoldTagged(source, paint, firstID);
  const solid = tagged.trimByPlane([0, 0, 1], BEAR_TRIM).translate([0, 0, -BEAR_TRIM]);
  const trimmed = fromManifoldTagged(solid, firstID, BEAR_MATERIALS.length, BROWN);
  const bb = solid.boundingBox();
  log(`  trimmed ${BEAR_TRIM} mm off the bottom: ${(bb.max[0] - bb.min[0]).toFixed(1)} x ${(bb.max[1] - bb.min[1]).toFixed(1)} x ${bb.max[2].toFixed(1)} mm, footing ${solid.slice(0.01).area().toFixed(0)} mm² in ${solid.slice(0.01).toPolygons().length} pieces`);
  const points = bearSeats(trimmed.mesh);
  const voids: ManifoldT[] = [];
  for (const [name, p] of Object.entries(points)) {
    const seat = seatFromPoint(name, p);
    voids.push(seatSolid(Manifold, seat, 0, outerFace(seat, p.axis)));
    const f = (v: readonly number[]) => v.map((x) => x.toFixed(1)).join(', ');
    log(`  ${name.padEnd(11)} seat ${p.diameter} x ${p.depth} mm, face at (${f(p.faceCenter!)}), axis (${p.axis.map((x) => x.toFixed(3)).join(', ')}), skin ${p.skin!.toFixed(2)} mm at the centre (${SEAT_SKIN} least)`);
  }
  const body = solid.subtract(Manifold.union(voids));
  const out = fromManifoldTagged(body, firstID, BEAR_MATERIALS.length, BROWN);
  const profile: FitProfile = { ...DEFAULT_PROFILE, points, forward: [0, -1, 0] };
  return { body, solid, faceMaterial: out.faceMaterial, mesh: out.mesh, profile, firstID };
}

// ---------- slide-in channels ----------

/**
 * How each channel runs (trimmed frame), chosen by scanning the body
 * (2026-11-15) for a route that opens once and keeps its walls:
 * - head: straight down through the head and the back of the body to the
 *   base, behind the wrists' channels (a 111 mm key, like the otter's);
 * - mouth: straight down and back from the seat to the underside of the
 *   beard, where the key sits flush under the chin (a channel to the base
 *   would have to cross the head's);
 * - wrists: each magnet slides level back out of its forearm, turns in
 *   behind the arm (the left arm joins the body through a narrow neck, so
 *   its route bends twice) and sinks a little, and from there the channel
 *   runs straight down to the base; the key fills that straight part, so a
 *   drop of glue holds each wrist magnet in its seat.
 * The via points start level with each wrist seat's centre (the seats as
 * bearSeats places them); move them with the seats.
 */
export const BEAR_PLANS: Record<string, ChannelPlan> = {
  head: { mouth: [26, 58, 0] },
  mouth: { mouth: [37.3, 14, 74.3], levelEnd: false },
  left_wrist: { mouth: [40, 47, 0], via: [[47, 22.5, 57.7], [44.5, 25.5, 57], [42.5, 29, 55]] },
  right_wrist: { mouth: [26, 36, 0], via: [[26.9, 20.5, 58.8], [27.9, 26, 56.8]] },
};

/** The slide-in print from the app's bear (`body`, seats already cut, and its profile). */
export function buildBearSlots(body: ManifoldT, profile: FitProfile, options: SlotOptions = DEFAULT_SLOTS, log = (s: string) => console.log(s)): Promise<CharacterSlotsBuild> {
  return buildCharacterSlots(body, profile, BEAR_PLANS, BEAR_MATERIALS, options, log);
}

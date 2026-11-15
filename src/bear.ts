// The bear desk character (Jerred, 2026-11-14): his "Bear V1" model, a curly
// bear sitting up with its paws raised, simplified to 0.02 mm
// (characters/bear/bear-source.stl), painted brown with black eyes and nose,
// its bottom trimmed flat so it stands on a desk, and three magnets: one in
// the top of the head (the goose's 10 x 4 mm) with a slide-in channel from
// the base and a key that fills it, as on the goose and the otter
// (src/desk-character.ts), and an 8 x 4 mm one in an open pocket under each
// paw, glued in from below, so an accessory there looks held under the paws.
// Pure (no Node APIs): the CLI (build-character.ts) makes the app's bear
// files from the source model, and the app builds the slide-in print from
// those files with the same code.

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import type { Material } from './threemf-write.ts';
import type { MagnetVoid } from './voids.ts';
import type { FitProfile } from './fit.ts';
import { DEFAULT_PROFILE, frameAt, fromManifoldTagged, manifold, toManifoldTagged } from './fit.ts';
import { DEFAULT_SLOTS, outerFace, seatSolid, type SlotOptions, type V3 } from './slots.ts';
import { add, buildCharacterSlots, cropMesh, cross, faceData, modeFilter, patchNormal, placeSeat, rayHit, SEAT_SKIN, seatFromPoint, smoothBorders, unit, watershed, type ChannelPlan, type CharacterSlotsBuild } from './desk-character.ts';

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

/** The paws take 8 x 4 mm magnets in open pockets (8.2 x 4.2: the magnet and 0.1 mm a side). */
export const PAW_SEAT = { diameter: 8.2, depth: 4.2 };
/**
 * Where each paw's pocket is centred (x, y; trimmed frame, the bear's own
 * left is +x), from a scan of the undersides (2026-11-15): the spot where a
 * pocket square to the underside keeps at least 1.2 mm of plastic round and
 * over the magnet and the underside is most even across it. A 10 x 4 mm
 * magnet keeps 1.2 mm in only a few spots, 5.8 mm up inside the paw: the
 * forearms are about 13 mm across.
 */
export const PAWS: Record<string, [number, number]> = { left_paw: [48.5, 14.5], right_paw: [25.5, 12] };

/** The candidate seat with the least plastic over its centre: where the curly surface is flattest across the magnet. */
function flattest(seats: MagnetVoid[]): MagnetVoid {
  return seats.reduce((a, b) => (b.skin! < a.skin! - 1e-6 ? b : a));
}

/**
 * An open pocket under a paw at (x, y): its axis square to the underside
 * there (a plane fitted across the magnet), its mouth level with the
 * underside's highest point across the magnet, so the magnet sits wholly
 * inside the paw and the pocket opens through the lower curls round it.
 */
export function pawPocket(mesh: IndexedMesh, x: number, y: number, seat = PAW_SEAT): MagnetVoid {
  const r = seat.diameter / 2;
  const fit = patchNormal(mesh, [x, y, 85], [0, 0, 1], [1, 0, 0], [0, 1, 0], r + 0.5);
  const axis = fit.normal;
  const e0 = unit(cross(Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], axis)), e1 = cross(axis, e0);
  // how far out along the axis the underside is, across the magnet: the mouth goes at the innermost
  let inner = Infinity;
  for (const rr of [0, r / 2, r]) for (let j = 0; j < (rr ? 16 : 1); j++) {
    const th = (j / 16) * Math.PI * 2;
    const o = add(add(add(fit.point, axis, 15), e0, rr * Math.cos(th)), e1, rr * Math.sin(th));
    const hit = rayHit(mesh, o, [-axis[0], -axis[1], -axis[2]]);
    if (hit.face >= 0) inner = Math.min(inner, 15 - hit.t);
  }
  const center = add(fit.point, axis, inner);
  return { center, faceCenter: center, axis, diameter: seat.diameter, depth: seat.depth, mode: 'open', floor: add(center, axis, -seat.depth), wallFaces: 0 };
}

/**
 * The three seats, found on the trimmed model:
 * - head: on the crown, axis straight up, where the curls are flattest
 *   across the magnet (the top is lumpy, so the very highest curl would
 *   leave 4 to 6 mm of plastic over the magnet's centre), sealed under the
 *   skin and reached by a slide-in channel;
 * - left_paw, right_paw: open pockets under each paw (PAWS), 8 x 4 mm,
 *   glued in from below.
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
  const arms = cropMesh(mesh, [10, -10, 35], [70, 40, 75]);
  const paws = Object.fromEntries(Object.entries(PAWS).map(([name, [x, y]]) => [name, pawPocket(arms, x, y)]));
  return { head, ...paws };
}

/** The cutter for an open pocket: the seat, and on out through the surface round its mouth. */
function openPocket(M: Awaited<ReturnType<typeof manifold>>['Manifold'], p: MagnetVoid, reach = 10): ManifoldT {
  return M.cylinder(p.depth + reach, p.diameter / 2, p.diameter / 2, 64, false).translate([0, 0, -p.depth]).transform(frameAt(p.center, p.axis) as any);
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
    const f = (v: readonly number[]) => v.map((x) => x.toFixed(1)).join(', ');
    const where = `${name.padEnd(9)} ${p.mode === 'open' ? 'open pocket' : 'seat'} ${p.diameter} x ${p.depth} mm, face at (${f(p.faceCenter!)}), axis (${p.axis.map((x) => x.toFixed(3)).join(', ')})`;
    if (p.mode === 'open') {
      voids.push(openPocket(Manifold, p));
      log(`  ${where}`);
    } else {
      const seat = seatFromPoint(name, p);
      voids.push(seatSolid(Manifold, seat, 0, outerFace(seat, p.axis)));
      log(`  ${where}, skin ${p.skin!.toFixed(2)} mm at the centre (${SEAT_SKIN} least)`);
    }
  }
  const body = solid.subtract(Manifold.union(voids));
  const out = fromManifoldTagged(body, firstID, BEAR_MATERIALS.length, BROWN);
  const profile: FitProfile = { ...DEFAULT_PROFILE, points, forward: [0, -1, 0] };
  return { body, solid, faceMaterial: out.faceMaterial, mesh: out.mesh, profile, firstID };
}

// ---------- slide-in channel ----------

/**
 * The head's channel: from the crown down and back through the body to
 * the base, scanned (2026-11-15) to open once and keep 1.2 mm of
 * wall; its key is about 111 mm long, like the otter's. The paws' pockets
 * are open, so they have no channel.
 */
export const BEAR_PLANS: Record<string, ChannelPlan> = {
  head: { mouth: [26, 58, 0] },
};

/** The slide-in print from the app's bear (`body`, seats already cut, and its profile). */
export function buildBearSlots(body: ManifoldT, profile: FitProfile, options: SlotOptions = DEFAULT_SLOTS, log = (s: string) => console.log(s)): Promise<CharacterSlotsBuild> {
  return buildCharacterSlots(body, profile, BEAR_PLANS, BEAR_MATERIALS, options, log);
}

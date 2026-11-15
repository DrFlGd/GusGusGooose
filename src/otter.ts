// The sea otter desk character (Jerred, 2026-11-09): his "Otter Solid Eyes"
// model painted after the concept art (dark brown body, light brown head and
// belly, black eyes, nose, smile and freckles), its bottom trimmed flat so it
// stands on a desk, a magnet seat in the top of the head and one on the chest
// between the paws (the same 10 x 4 mm magnets as the goose), and a slide-in
// channel from the flat base up to each seat with a key that fills it, as on
// the goose (src/slots.ts). Pure (no Node APIs): the CLI (build-character.ts)
// makes the app's otter files from the source model, and the app builds the
// slide-in print from those files with the same code.

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import type { BuildObject, Material } from './threemf-write.ts';
import type { MagnetVoid } from './voids.ts';
import type { FitProfile } from './fit.ts';
import { DEFAULT_PROFILE, fromManifoldTagged, manifold, toManifoldTagged } from './fit.ts';
import { DEFAULT_SLOTS, outerFace, seatSolid, type Channel, type SlotOptions, type V3 } from './slots.ts';
import {
  buildCharacterSlots, characterKeyDown, characterPaint, faceData, layoutCharacter, modeFilter, placeSeat, rayHit, SEAT_SKIN, seatFromPoint, unit, watershed,
  wholeFaceCodes as codesOf, type ChannelPlan, type CharacterSlotsBuild,
} from './desk-character.ts';

export { MAGNET_SEAT, SEAT_SKIN, placeSeat, rayHit, seatFromPoint } from './desk-character.ts';

/** mm cut off the bottom of the source model: the feet soles, belly and tail tip become one flat footing (two pieces: body and tail). */
export const OTTER_TRIM = 2.5;

/** The concept art's palette, sampled from its paint swatches. Filament 1 is the dark brown (the object's own), 2 light brown, 3 black. */
export const OTTER_MATERIALS: Material[] = [
  { name: 'dark brown', color: '#65321c' },
  { name: 'light brown', color: '#e99c60' },
  { name: 'black', color: '#1a1a1a' },
];
export const DARK = 0, LIGHT = 1, BLACK = 2;

// ---------- paint ----------

/**
 * Seeds for the paint, in the source model's frame (z up, facing −y, 68 x 101
 * x 125 mm, x centre 34): rays from the front (F x,z), back (B), above (U x,y)
 * and sides (L/R y,z) onto the region each colour starts from.
 */
const SEEDS: [number, 'F' | 'B' | 'U' | 'L' | 'R', number, number][] = [
  // light brown: face, cheeks, chin, chest, belly, top and back of the head, head sides
  [LIGHT, 'F', 34, 118], [LIGHT, 'F', 34, 86], [LIGHT, 'F', 12, 96], [LIGHT, 'F', 56, 96], [LIGHT, 'F', 34, 66], [LIGHT, 'F', 34, 40], [LIGHT, 'F', 34, 20],
  [LIGHT, 'U', 34, 50], [LIGHT, 'B', 34, 110], [LIGHT, 'L', 40, 105], [LIGHT, 'R', 40, 105],
  // dark brown: back, sides, paws, feet, tail, ears
  [DARK, 'B', 34, 70], [DARK, 'B', 34, 40], [DARK, 'L', 55, 40], [DARK, 'R', 55, 40], [DARK, 'F', 18, 66], [DARK, 'F', 50, 66], [DARK, 'F', 12, 6], [DARK, 'F', 56, 6],
  [DARK, 'U', 34, 90], [DARK, 'F', 4, 108], [DARK, 'F', 64, 108], [DARK, 'L', 46, 110], [DARK, 'R', 46, 110],
  // black: eyes and nose
  [BLACK, 'F', 21, 107], [BLACK, 'F', 46.5, 107], [BLACK, 'F', 34, 102],
];

/** The face the paint's dots and smile are looked for in (source frame): the front of the head, below the eyes. */
const inFaceZone = (c: Float32Array, t: number) => c[t * 3 + 1] < 32 && c[t * 3 + 2] > 78 && c[t * 3 + 2] < 104;
const inMouthZone = (c: Float32Array, t: number) => c[t * 3 + 1] < 14 && c[t * 3 + 2] > 78 && c[t * 3 + 2] < 99 && c[t * 3] > 14 && c[t * 3] < 54;

/**
 * Paints the source model: per-triangle DARK, LIGHT or BLACK. The colour
 * borders follow the sculpt: a watershed from the seeds over the surface,
 * flooding in order of curvature, so the regions meet along the creases the
 * model has there (the tufted neckline and belly edge, the eye and nose
 * rims). The freckles are the small bumps on the cheeks, the smile the
 * groove under the nose; a mode filter then smooths every border.
 */
export function paintOtter(mesh: IndexedMesh): Uint8Array {
  const fd = faceData(mesh);
  const { centroids: cen, adjacency: adj, curvature: curv } = fd;
  const n = mesh.triangles.length / 3;
  const cast = (dir: string, a: number, b: number) => {
    const [o, d]: [V3, V3] = dir === 'F' ? [[a, -50, b], [0, 1, 0]] : dir === 'B' ? [[a, 200, b], [0, -1, 0]] : dir === 'U' ? [[a, b, 250], [0, 0, -1]] : dir === 'L' ? [[-50, a, b], [1, 0, 0]] : [[150, a, b], [-1, 0, 0]];
    return rayHit(mesh, o, d).face;
  };
  const label = watershed(fd, SEEDS.map(([l, dir, a, b]) => ({ face: cast(dir, a, b), label: l })));
  const out = new Uint8Array(n);
  for (let t = 0; t < n; t++) out[t] = label[t] < 0 ? DARK : label[t];

  // components of the faces `pick` accepts, flooding only through accepted faces
  const components = (pick: (t: number) => boolean) => {
    const seen = new Uint8Array(n), comps: number[][] = [];
    for (let s = 0; s < n; s++) {
      if (seen[s] || !pick(s)) continue;
      const comp = [s]; seen[s] = 1;
      for (let i = 0; i < comp.length; i++) for (const o of adj[comp[i]]) if (!seen[o] && pick(o)) { seen[o] = 1; comp.push(o); }
      comps.push(comp);
    }
    return comps;
  };
  // freckles: the small, sharply convex bumps on the cheeks, painted as round dots as wide as the bump
  const face = (t: number) => out[t] === LIGHT && inFaceZone(cen, t);
  for (const comp of components((t) => face(t) && curv[t] >= 0.5)) {
    if (comp.length < 3) continue;
    const c = [0, 1, 2].map((k) => comp.reduce((s, t) => s + cen[t * 3 + k], 0) / comp.length);
    const dist = (t: number) => Math.hypot(cen[t * 3] - c[0], cen[t * 3 + 1] - c[1], cen[t * 3 + 2] - c[2]);
    const r = Math.min(1.3, Math.max(0.6, Math.max(...comp.map(dist)) + 0.15));
    const q = [...comp], inq = new Set(q);
    for (let i = 0; i < q.length; i++) for (const o of adj[q[i]]) if (!inq.has(o) && face(o) && dist(o) < r) { inq.add(o); q.push(o); }
    for (const t of q) out[t] = BLACK;
  }
  // the smile: the groove under the nose and along the muzzle, widened by a ring of faces so it reads as a line in print
  const smile: number[] = [];
  for (const comp of components((t) => out[t] === LIGHT && inMouthZone(cen, t) && curv[t] <= -0.3)) {
    if (comp.length >= 6) for (const t of comp) { out[t] = BLACK; smile.push(t); }
  }
  for (const t of smile) for (const o of adj[t]) if (out[o] === LIGHT && inMouthZone(cen, o)) out[o] = BLACK;
  modeFilter(fd, out);
  return out;
}

/** Whole-face slicer paint codes: the palette index m is filament m + 1, and the dark brown (filament 1) is the object's own, so it carries none. */
export const wholeFaceCodes = (faceMaterial: Uint8Array): string[] => codesOf(faceMaterial);

// ---------- magnet seats ----------

/** Least-squares surface normal over the patch of `mesh` a set of rays from the front hits: outward, unit. */
function frontNormal(mesh: IndexedMesh, x0: number, z0: number, half: number): { point: V3; normal: V3 } {
  const pts: V3[] = [];
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const x = x0 + (i / 2) * half, z = z0 + (j / 2) * half;
    const hit = rayHit(mesh, [x, -50, z], [0, 1, 0]);
    if (hit.face >= 0) pts.push([x, hit.t - 50, z]);
  }
  // y = a + b (x − x0) + c (z − z0)
  let sxx = 0, sxz = 0, szz = 0, sxy = 0, szy = 0, sy = 0;
  for (const [x, y, z] of pts) { const dx = x - x0, dz = z - z0; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; sxy += dx * y; szy += dz * y; sy += y; }
  const det = sxx * szz - sxz * sxz;
  const b = (sxy * szz - szy * sxz) / det, c = (szy * sxx - sxy * sxz) / det;
  const centre = rayHit(mesh, [x0, -50, z0], [0, 1, 0]);
  return { point: [x0, centre.t - 50, z0], normal: unit([b, -1, c]) };
}

/**
 * The two seats, found on the trimmed model: under the highest point of the
 * head, axis straight up; and on the chest between the paws (x 34, 62 mm up
 * after the trim, where the chest is widest between them), axis square to
 * the chest there (it faces forward and a little up).
 */
export function otterSeats(mesh: IndexedMesh): Record<string, MagnetVoid> {
  // the top of the head: the highest point near the middle
  // the highest point on the middle plane (the model is symmetric about x = 34)
  let apex: V3 = [34, 42, -Infinity];
  for (let y = 34; y <= 50; y += 0.5) {
    const hit = rayHit(mesh, [34, y, 250], [0, 0, -1]);
    if (hit.face >= 0 && 250 - hit.t > apex[2]) apex = [34, y, 250 - hit.t];
  }
  const head = placeSeat(mesh, apex, [0, 0, 1]);
  const chestAt = frontNormal(mesh, 34, 62, 4.5);
  const chest = placeSeat(mesh, chestAt.point, [0, chestAt.normal[1], chestAt.normal[2]]);
  return { head, chest };
}

// ---------- the body ----------

export interface OtterBody {
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
 * cut is dark brown), places the seats and cuts them.
 */
export async function buildOtterBody(source: IndexedMesh, paint: Uint8Array, log = (s: string) => console.log(s)): Promise<OtterBody> {
  const { Manifold } = await manifold();
  const firstID = Manifold.reserveIDs(OTTER_MATERIALS.length);
  const tagged = await toManifoldTagged(source, paint, firstID);
  const solid = tagged.trimByPlane([0, 0, 1], OTTER_TRIM).translate([0, 0, -OTTER_TRIM]);
  const trimmed = fromManifoldTagged(solid, firstID, OTTER_MATERIALS.length, DARK);
  const bb = solid.boundingBox();
  log(`  trimmed ${OTTER_TRIM} mm off the bottom: ${(bb.max[0] - bb.min[0]).toFixed(1)} x ${(bb.max[1] - bb.min[1]).toFixed(1)} x ${bb.max[2].toFixed(1)} mm, footing ${solid.slice(0.01).area().toFixed(0)} mm² in ${solid.slice(0.01).toPolygons().length} pieces`);
  const points = otterSeats(trimmed.mesh);
  const voids: ManifoldT[] = [];
  for (const [name, p] of Object.entries(points)) {
    const seat = seatFromPoint(name, p);
    voids.push(seatSolid(Manifold, seat, 0, outerFace(seat, p.axis)));
    const f = (v: readonly number[]) => v.map((x) => x.toFixed(1)).join(', ');
    log(`  ${name.padEnd(6)} seat ${p.diameter} x ${p.depth} mm, face at (${f(p.faceCenter!)}), axis (${p.axis.map((x) => x.toFixed(3)).join(', ')}), skin ${p.skin!.toFixed(2)} mm at the centre (${SEAT_SKIN} least)`);
  }
  const body = solid.subtract(Manifold.union(voids));
  const out = fromManifoldTagged(body, firstID, OTTER_MATERIALS.length, DARK);
  const profile: FitProfile = { ...DEFAULT_PROFILE, points, forward: [0, -1, 0] };
  return { body, solid, faceMaterial: out.faceMaterial, mesh: out.mesh, profile, firstID };
}

// ---------- slide-in channels ----------

/**
 * Where each channel comes out on the flat base (trimmed frame), chosen by
 * scanning the body (2026-11-09): the chest channel runs down and back from
 * its seat to the body's footing behind the gap between the feet; the head
 * channel runs down the middle of the body to the tail's root, behind it, so
 * the two never meet. Both mouths are under the otter.
 */
export const OTTER_MOUTHS: Record<string, V3> = {
  head: [34, 70.5, 0],
  chest: [34, 45, 0],
};
/** The channel plans: straight from each seat to its mouth in the base. */
export const OTTER_PLANS: Record<string, ChannelPlan> = Object.fromEntries(Object.entries(OTTER_MOUTHS).map(([name, mouth]) => [name, { mouth }]));

export type OtterSlotsBuild = CharacterSlotsBuild;

/**
 * The slide-in print from the app's otter (`body`, seats already cut, and its
 * profile). The keys fill the channels from the base up to the magnet and are
 * flush with the base. No tongue: nothing covers these mouths but the desk.
 */
export function buildOtterSlots(body: ManifoldT, profile: FitProfile, options: SlotOptions = DEFAULT_SLOTS, log = (s: string) => console.log(s)): Promise<OtterSlotsBuild> {
  return buildCharacterSlots(body, profile, OTTER_PLANS, OTTER_MATERIALS, options, log);
}

/**
 * Which way a key lies on the plate: flat keys on a side ('square' end); the
 * upright version and the swept keys stand as they sit in the otter, the end
 * that is part of the base on the plate, so it has the base's finish.
 */
export const otterKeyDown = (ch: Channel): V3 => characterKeyDown(ch);

/** The print: the otter where it stands, the keys side by side beside it, long sides along y. `otter` is the cut body's mesh and paint. */
export const layoutOtter = (b: OtterSlotsBuild, otter: { mesh: IndexedMesh; faceMaterial: Uint8Array }): BuildObject[] => layoutCharacter(b, otter, 'otter');

/** The cut otter's mesh and paint, for export. */
export const otterPaint = (b: OtterSlotsBuild, firstID: number): { mesh: IndexedMesh; faceMaterial: Uint8Array } => characterPaint(b, firstID);

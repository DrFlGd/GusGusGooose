// Clothing for the goose: garments that follow the body's contour and drop
// on over the head, with no magnets.
//
// The body is sampled as a radial profile r(θ, z) about a vertical axis
// through the body. Sweeping that profile downward (running max from the
// top) gives the smallest "drop-on" shape: every cross-section contains
// everything above it, so a rigid garment with that inside slides on from
// the top, the neck clears the head and beak, and nothing curves back in
// near the hem. Offsetting the profile by a disc in the (r, z) plane gives
// the garment's inner (clearance) and outer (clearance + thickness)
// surfaces, which are lofted into one closed shell. An imported garment is
// mapped onto the same profile: each of its vertices keeps its height
// fraction, angle and distance from the garment's own inner surface, and is
// re-seated at that angle and height on the goose's drop-on profile.

import type { CrossSection as CrossSectionT, Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import { fromManifold, manifold, toManifold } from './fit.ts';

export interface BodyProfile {
  /** axis position */
  cx: number;
  cy: number;
  /** direction from the axis to whatever is above the reference range (the head), radians; undefined if nothing is there */
  headDir?: number;
  /** the body's long axis in the reference range (its centre line), radians, pointed toward the head when known */
  bodyDir?: number;
  /** sample heights, ascending */
  z: number[];
  /** radius per [height][angle], mm; 0 where the goose is absent */
  r: Float32Array[];
  nTheta: number;
}

export interface GarmentOptions {
  /** hem height (bottom edge), mm */
  hem: number;
  /** neck height (top edge), mm */
  neck: number;
  /** wall thickness, mm */
  thickness: number;
  /** gap between goose and garment, mm */
  clearance: number;
  /**
   * 'tilt' (default): the cavity follows the body below the neck and the
   * collar opens where the head and beak would pass, so the garment goes on
   * tilted, beak first. 'drop': every section also contains the head and
   * beak, so it drops straight on, at the cost of a front wall that stands
   * well off the chest.
   */
  collar?: 'tilt' | 'drop';
  /** extra gap around the neck at the collar, mm */
  collarGap?: number;
  /** open the collar out from the neck and chest by this much, mm, blended in over the top `neckSpreadHeight` mm of the garment */
  neckSpread?: number;
  neckSpreadHeight?: number;
  /** axis position; default: area-weighted centre of the body between hem and neck */
  centre?: [number, number];
  /** height step for sampling, mm */
  dz?: number;
  /** angular samples around the axis */
  nTheta?: number;
  /** smoothing passes over the profile (never shrinks it below the body) */
  smooth?: number;
  /** neckline at the front: 'crew' (flat), 'v' or 'scoop' (round), cut `necklineDepth` mm below the neck height */
  neckline?: 'crew' | 'v' | 'scoop';
  necklineDepth?: number;
  /** half-width of the neckline opening, degrees around the axis */
  necklineWidth?: number;
  /** a collar tube hugging the neck, this many mm above the neck height (0 = none; the neckline cut opens it at the front) */
  collarHeight?: number;
  /** direction of the front, degrees around the axis; default: toward the head */
  front?: number;
  /** turn the front this many degrees from the automatic direction (the head sits a little off the body axis) */
  frontOffset?: number;
  /** surface texture on the outside */
  fabric?: 'plain' | 'ribbed' | 'puffer';
  /** rib depth or quilt bulge, mm */
  fabricDepth?: number;
  /** ribs around the body, or quilt row height in mm */
  fabricPitch?: number;
  /** number of buttons down the front (0 = none) */
  buttons?: number;
  buttonDiameter?: number;
  /** a placket strip down the front behind the buttons */
  placket?: boolean;
  /** height of a ribbed band at the hem, mm (0 = none) */
  hemBand?: number;
  /** paint horizontal stripes this many mm tall (0 = none); result.faceMaterial alternates 0 and 1 */
  stripes?: number;
  /**
   * lean the drop-on axis so the collar is centred on the neck: 0 keeps it
   * vertical through the body's centre, 1 passes it through the neck's centre
   * at the collar (the garment then goes on along that lean)
   */
  axisToNeck?: number;
  /**
   * follow the body closely, undercuts included (the chest, under the tail),
   * instead of the drop-on shape; only wearable as split halves
   */
  formFit?: boolean;
  /** cut the garment in two: 'sides' (left and right halves, seams at the front and back) or 'front-back' (seams at the sides) */
  split?: 'none' | 'sides' | 'front-back';
  /** magnet pockets per seam */
  splitMagnets?: number;
  /** disc magnets in the seams: diameter and thickness, mm (the pocket has 0.3 and 0.2 mm of play) */
  splitMagnetDiameter?: number;
  splitMagnetThickness?: number;
}

export const DEFAULT_GARMENT: GarmentOptions = {
  hem: 46, neck: 108, thickness: 1.6, clearance: 0.4, collar: 'tilt', collarGap: 1, neckSpread: 0, neckSpreadHeight: 15, dz: 0.75, nTheta: 144, smooth: 2,
  neckline: 'v', necklineDepth: 14, necklineWidth: 45, collarHeight: 0,
  fabric: 'plain', fabricDepth: 0.4, fabricPitch: 48, buttons: 0, buttonDiameter: 3, placket: false, hemBand: 0, stripes: 0, axisToNeck: 1,
  formFit: false, split: 'none', splitMagnets: 3, splitMagnetDiameter: 3, splitMagnetThickness: 1,
};

/** Samples the goose as a radial profile from `zMin` to the top of the model. */
export function bodyProfile(goose: ManifoldT, zMin: number, dz: number, nTheta: number, centre?: [number, number], zRef?: [number, number], frontHint?: number): BodyProfile {
  const bb = goose.boundingBox();
  const zs: number[] = [];
  for (let z = zMin; z < bb.max[2] - 0.05; z += dz) zs.push(z);
  // each ring takes the widest of three sub-slices across its band, so bulges between rings are covered
  const sub = 3;
  const slices = zs.map((z) => {
    const out: [number, number][][][] = [];
    for (let j = 0; j < sub; j++) {
      const zz = Math.min(z + (j * dz) / sub, bb.max[2] - 0.05);
      out.push(goose.slice(zz).toPolygons() as [number, number][][]);
    }
    return out;
  });
  let [cx, cy] = centre ?? [0, 0];
  // area-weighted centroids: of the sections in the garment's height range (the axis) and above it (the head)
  let sx = 0, sy = 0, sa = 0, hx = 0, hy = 0, ha = 0;
  zs.forEach((z, k) => {
    for (const poly of slices[k][0]) {
      const { area, x, y } = polygonCentroid(poly);
      if (zRef && z > zRef[1]) { hx += x * area; hy += y * area; ha += area; }
      else if (!zRef || z >= zRef[0]) { sx += x * area; sy += y * area; sa += area; }
    }
  });
  if (!centre) {
    cx = sa ? sx / sa : (bb.min[0] + bb.max[0]) / 2;
    cy = sa ? sy / sa : (bb.min[1] + bb.max[1]) / 2;
  }
  const headDir = ha ? Math.atan2(hy / ha - cy, hx / ha - cx) : undefined;
  // the body's long axis: principal direction of the section outlines about the axis
  let sxx = 0, sxy = 0, syy = 0;
  zs.forEach((z, k) => {
    if (zRef && (z < zRef[0] || z > zRef[1])) return;
    for (const poly of slices[k][0]) for (const [x, y] of poly) { const dx = x - cx, dy = y - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  });
  let bodyDir: number | undefined;
  if (sxx + syy > 0) {
    bodyDir = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    // pointed toward the head: by the hint when given (in a sheared frame the head itself can end up behind the axis)
    const toward = frontHint ?? headDir;
    if (toward !== undefined && Math.abs(angleDiff(bodyDir, toward)) > Math.PI / 2) bodyDir += Math.PI;
  }
  const cos = new Float64Array(nTheta), sin = new Float64Array(nTheta);
  for (let i = 0; i < nTheta; i++) { const a = (i / nTheta) * Math.PI * 2; cos[i] = Math.cos(a); sin[i] = Math.sin(a); }
  const twoPi = Math.PI * 2;
  const r = slices.map((subSlices) => {
    const row = new Float32Array(nTheta);
    for (const poly of subSlices.flat()) {
      for (let e = 0; e < poly.length; e++) {
        const [px, py] = poly[e], [qx, qy] = poly[(e + 1) % poly.length];
        const ax = px - cx, ay = py - cy, ex = qx - px, ey = qy - py;
        // the angles the edge spans, as the shorter arc from a0 to a1
        const a0 = Math.atan2(ay, ax);
        let da = Math.atan2(qy - cy, qx - cx) - a0;
        if (da > Math.PI) da -= twoPi; else if (da < -Math.PI) da += twoPi;
        const lo = Math.min(a0, a0 + da), hi = Math.max(a0, a0 + da);
        const i0 = Math.ceil((lo / twoPi) * nTheta), i1 = Math.floor((hi / twoPi) * nTheta);
        for (let j = i0; j <= i1; j++) {
          const i = ((j % nTheta) + nTheta) % nTheta;
          // ray (cos, sin)·t = a + e·s
          const den = cos[i] * ey - sin[i] * ex;
          if (Math.abs(den) < 1e-12) continue;
          const s = (ax * sin[i] - ay * cos[i]) / den;
          if (s < -1e-9 || s > 1 + 1e-9) continue;
          const t = (ax * ey - ay * ex) / den;
          if (t > row[i]) row[i] = t;
        }
      }
    }
    return row;
  });
  // a ring takes the widest of its own band and the band below, so the straight
  // loft between two rings never cuts inside the goose
  for (let k = r.length - 1; k > 0; k--) for (let i = 0; i < nTheta; i++) r[k][i] = Math.max(r[k][i], r[k - 1][i]);
  return { cx, cy, headDir, bodyDir, z: zs, r, nTheta };
}

function polygonCentroid(poly: [number, number][]) {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    const c = x0 * y1 - x1 * y0;
    a += c; x += (x0 + x1) * c; y += (y0 + y1) * c;
  }
  a /= 2;
  return a ? { area: Math.abs(a), x: x / (6 * a), y: y / (6 * a) } : { area: 0, x: 0, y: 0 };
}

/** Running max from the top: each section grows to contain everything above it. */
export function sweepDown(p: BodyProfile): BodyProfile {
  const r = p.r.map((row) => Float32Array.from(row));
  for (let k = r.length - 2; k >= 0; k--) for (let i = 0; i < p.nTheta; i++) r[k][i] = Math.max(r[k][i], r[k + 1][i]);
  return { ...p, r };
}

/** Averages each sample with its neighbours in z and θ, `passes` times (shape is re-swept afterwards by callers). */
export function smoothProfile(p: BodyProfile, passes: number): BodyProfile {
  let r = p.r;
  for (let n = 0; n < passes; n++) {
    r = r.map((row, k) => {
      const out = new Float32Array(p.nTheta);
      const up = r[Math.min(k + 1, r.length - 1)], down = r[Math.max(k - 1, 0)];
      for (let i = 0; i < p.nTheta; i++) {
        const l = row[(i + p.nTheta - 1) % p.nTheta], rr = row[(i + 1) % p.nTheta];
        out[i] = (row[i] * 2 + l + rr + up[i] + down[i]) / 6;
      }
      return out;
    });
  }
  return { ...p, r };
}

/**
 * The upper envelope of the profile over a window of about `mm` millimetres
 * around each sample (a max filter). The goose is a sculpt with feather
 * texture of a few tenths of a millimetre; a seat built straight on it
 * copies that texture onto every garment. The envelope rides on the peaks
 * instead, and smoothing it afterwards gives a clean surface that still
 * clears the body everywhere.
 */
export function envelopeProfile(p: BodyProfile, mm: number, dz: number): BodyProfile {
  if (mm <= 0) return p;
  const kz = Math.max(1, Math.round(mm / dz));
  const r = p.r.map((row, k) => {
    const out = new Float32Array(p.nTheta);
    for (let i = 0; i < p.nTheta; i++) {
      // the angular window covers about `mm` at this radius
      const ka = Math.min(p.nTheta >> 2, Math.max(1, Math.round((mm / Math.max(1, row[i])) * p.nTheta / (2 * Math.PI))));
      let m = 0;
      for (let j = Math.max(0, k - kz); j <= Math.min(p.r.length - 1, k + kz); j++) {
        const src = p.r[j];
        for (let a = -ka; a <= ka; a++) m = Math.max(m, src[(i + a + p.nTheta) % p.nTheta]);
      }
      out[i] = m;
    }
    return out;
  });
  return { ...p, r };
}

/** Minkowski sum of the (r, z) profile with a disc of radius d, per angle: a true-thickness offset on walls and shoulders alike. */
export function offsetProfile(p: BodyProfile, d: number): BodyProfile {
  const r = p.r.map((row, k) => {
    const out = Float32Array.from(row, (v) => v + d);
    for (let j = 0; j < p.r.length; j++) {
      const dzj = p.z[j] - p.z[k];
      if (Math.abs(dzj) >= d || j === k) continue;
      const lift = Math.sqrt(d * d - dzj * dzj);
      const src = p.r[j];
      for (let i = 0; i < p.nTheta; i++) out[i] = Math.max(out[i], src[i] + lift);
    }
    return out;
  });
  return { ...p, r };
}

/** Restricts the profile to heights within [zMin, zMax]. */
export function clipProfile(p: BodyProfile, zMin: number, zMax: number): BodyProfile {
  const keep = p.z.map((z, k) => [z, k] as const).filter(([z]) => z >= zMin - 1e-6 && z <= zMax + 1e-6).map(([, k]) => k);
  return { ...p, z: keep.map((k) => p.z[k]), r: keep.map((k) => p.r[k]) };
}

function ringPoint(p: BodyProfile, k: number, i: number): [number, number, number] {
  const a = (i / p.nTheta) * Math.PI * 2;
  return [p.cx + p.r[k][i] * Math.cos(a), p.cy + p.r[k][i] * Math.sin(a), p.z[k]];
}

/** A closed shell between an inner and an outer profile sampled at the same heights. */
export function loftShell(inner: BodyProfile, outer: BodyProfile): IndexedMesh {
  const N = inner.nTheta, K = inner.z.length;
  const positions = new Float32Array(2 * K * N * 3);
  let v = 0;
  for (let k = 0; k < K; k++) for (let i = 0; i < N; i++) { const [x, y, z] = ringPoint(inner, k, i); positions[v++] = x; positions[v++] = y; positions[v++] = z; }
  for (let k = 0; k < K; k++) for (let i = 0; i < N; i++) { const [x, y, z] = ringPoint(outer, k, i); positions[v++] = x; positions[v++] = y; positions[v++] = z; }
  const IN = (k: number, i: number) => k * N + (i % N);
  const OUT = (k: number, i: number) => K * N + k * N + (i % N);
  const tris: number[] = [];
  for (let k = 0; k + 1 < K; k++) for (let i = 0; i < N; i++) {
    // outer wall, normals outward
    tris.push(OUT(k, i), OUT(k, i + 1), OUT(k + 1, i + 1), OUT(k, i), OUT(k + 1, i + 1), OUT(k + 1, i));
    // inner wall, normals inward
    tris.push(IN(k, i), IN(k + 1, i + 1), IN(k, i + 1), IN(k, i), IN(k + 1, i), IN(k + 1, i + 1));
  }
  for (let i = 0; i < N; i++) {
    // hem, normal down
    tris.push(IN(0, i), OUT(0, i + 1), OUT(0, i), IN(0, i), IN(0, i + 1), OUT(0, i + 1));
    // neck, normal up
    tris.push(IN(K - 1, i), OUT(K - 1, i), OUT(K - 1, i + 1), IN(K - 1, i), OUT(K - 1, i + 1), IN(K - 1, i + 1));
  }
  return { positions, triangles: Uint32Array.from(tris) };
}

/** The solid inside a profile (closed with flat caps), for carving an imported garment. */
export function loftSolid(p: BodyProfile): IndexedMesh {
  const N = p.nTheta, K = p.z.length;
  const positions = new Float32Array((K * N + 2) * 3);
  let v = 0;
  for (let k = 0; k < K; k++) for (let i = 0; i < N; i++) { const [x, y, z] = ringPoint(p, k, i); positions[v++] = x; positions[v++] = y; positions[v++] = z; }
  const bottom = K * N, top = K * N + 1;
  positions.set([p.cx, p.cy, p.z[0]], bottom * 3);
  positions.set([p.cx, p.cy, p.z[K - 1]], top * 3);
  const R = (k: number, i: number) => k * N + (i % N);
  const tris: number[] = [];
  for (let k = 0; k + 1 < K; k++) for (let i = 0; i < N; i++) tris.push(R(k, i), R(k, i + 1), R(k + 1, i + 1), R(k, i), R(k + 1, i + 1), R(k + 1, i));
  for (let i = 0; i < N; i++) { tris.push(bottom, R(0, i + 1), R(0, i)); tris.push(top, R(K - 1, i), R(K - 1, i + 1)); }
  return { positions, triangles: Uint32Array.from(tris) };
}

export interface GarmentResult {
  mesh: IndexedMesh;
  solid: ManifoldT;
  /** material index per triangle when a pattern was asked for (stripes) */
  faceMaterial?: Uint8Array;
  centre: [number, number];
  /** the inner (drop-on) profile, for the preview and for wrapping */
  inner: BodyProfile;
  /** the halves when the garment is split, with their magnet pockets; `solid` and `mesh` are both halves together */
  parts?: ManifoldT[];
  warnings: string[];
}

/** Per-sample max of two profiles on the same grid. */
export function maxProfile(a: BodyProfile, b: BodyProfile): BodyProfile {
  return { ...a, r: a.r.map((row, k) => Float32Array.from(row, (v, i) => Math.max(v, b.r[k][i]))) };
}

export interface Cavity {
  /** the goose's swept shape between hem and neck, before any offset */
  swept: BodyProfile;
  /** inner garment surface: swept + clearance */
  inner: BodyProfile;
  /** collar opening radius per angle at the neck */
  hole: Float32Array;
  /** projection of everything above the neck, per angle (what the collar has to pass) */
  headProjection: Float32Array;
  centre: [number, number];
  /** the front of the goose, radians around the axis */
  front: number;
  /** the neck itself plus clearance and gap, per angle: what a collar tube hugs */
  neckRing: Float32Array;
  /** the body as sampled, unswept, between hem and neck: 0 where the body is absent at that height and angle */
  raw: BodyProfile;
  /** heights the collar polygons are built from */
  neckSpan: [number, number];
  /** the frame everything here is measured in: undo it (sign -1 applied, so +1 restores) to get back to the goose's frame */
  shear: Shear;
}

/** A horizontal shear: x += sx (z - z0), y += sy (z - z0). Garments are built in the sheared frame, where the lean of the body toward the neck is straightened out. */
export interface Shear { sx: number; sy: number; z0: number; /** the body's centre at the hem, which the leaned axis passes through */ axis?: [number, number] }

function sliceCentroid(goose: ManifoldT, zs: number[]): [number, number, number] {
  let sx = 0, sy = 0, sa = 0;
  for (const z of zs) {
    for (const poly of goose.slice(z).toPolygons() as [number, number][][]) {
      const { area, x, y } = polygonCentroid(poly);
      sx += x * area; sy += y * area; sa += area;
    }
  }
  return sa ? [sx / sa, sy / sa, sa] : [0, 0, 0];
}

/** The shear that puts the neck's centre at the collar straight above the body's centre at the hem (scaled by `axisToNeck`). */
export function neckShear(goose: ManifoldT, o: GarmentOptions): Shear {
  const lean = o.axisToNeck ?? 1;
  if (!lean) return { sx: 0, sy: 0, z0: o.hem };
  const zs = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 0.5)) / n);
  const [hx, hy, ha] = sliceCentroid(goose, zs(o.hem, o.hem + 8, 4));
  // the neck: the biggest section at the first height above the collar where the body has fallen away
  // (well under the shoulders' area), so the shoulders themselves are not mistaken for it
  const biggest = (z: number) => {
    let best = { area: 0, x: 0, y: 0 }, count = 0;
    for (const poly of goose.slice(z).toPolygons() as [number, number][][]) { const c = polygonCentroid(poly); if (c.area > 1) count++; if (c.area > best.area) best = c; }
    return { ...best, count };
  };
  const shoulder = biggest(o.neck - 2).area;
  const top = goose.boundingBox().max[2];
  let neck = biggest(o.neck + 2);
  for (let z = o.neck + 2; z < top - 0.1; z += 2) {
    const b = biggest(z);
    if (!b.area) break;
    neck = b;
    // one section left (the last of the shoulders has gone), much smaller than the shoulders: the neck
    if (b.count === 1 && b.area < 0.3 * shoulder) break;
  }
  const [nx, ny, na] = [neck.x, neck.y, neck.area];
  if (!ha || !na || o.neck - o.hem < 1) return { sx: 0, sy: 0, z0: o.hem };
  return { sx: (lean * (nx - hx)) / (o.neck - o.hem), sy: (lean * (ny - hy)) / (o.neck - o.hem), z0: o.hem, axis: [hx, hy] };
}

/** Applies the shear (sign +1) or undoes it (sign -1). */
export function shearManifold(m: ManifoldT, s: Shear, sign: 1 | -1): ManifoldT {
  if (!s.sx && !s.sy) return m;
  // an affine transform, which Manifold applies lazily, rather than a per-vertex `warp` callback over a large mesh
  const a = sign * s.sx, b = sign * s.sy;
  return m.transform([1, 0, 0, 0, 0, 1, 0, 0, a, b, 1, 0, -a * s.z0, -b * s.z0, 0, 1]);
}

/** The space a garment between hem and neck must leave for the goose, and the collar opening. Measured in the sheared frame (see `shear`). */
export function cavityProfile(goose: ManifoldT, opts: Partial<GarmentOptions> = {}): Cavity {
  const o = { ...DEFAULT_GARMENT, ...opts };
  const dz = o.dz ?? 1, nTheta = o.nTheta ?? 144;
  const shear = neckShear(goose, o);
  goose = shearManifold(goose, shear, -1);
  // with a lean, the axis is the line through the body's centre at the hem and the neck's centre, which the shear has made vertical
  const leaning = !!(shear.sx || shear.sy);
  // the neck is forward of the body's centre at the hem, so the lean itself says which way the front is
  const p = bodyProfile(goose, o.hem, dz, nTheta, o.centre ?? (leaning ? shear.axis : undefined), [o.hem, o.neck], leaning ? Math.atan2(shear.sy, shear.sx) : undefined);
  const full = sweepDown(p); // everything above each height, head included
  const kNeck = p.z.findIndex((z) => z >= o.neck - 1e-6);
  const headProjection = full.r[Math.min(kNeck < 0 ? p.z.length - 1 : kNeck, p.z.length - 1)];
  let swept: BodyProfile;
  if (o.formFit) {
    // the body as it is, undercuts included; where it is absent at a height, carry the ring below up so nothing pinches to the axis
    swept = clipProfile(p, o.hem, o.neck);
    const r = swept.r.map((row) => Float32Array.from(row));
    for (let k = 1; k < r.length; k++) for (let i = 0; i < nTheta; i++) if (r[k][i] <= 0) r[k][i] = r[k - 1][i];
    swept = { ...swept, r };
    if (o.smooth) swept = maxProfile(smoothProfile(envelopeProfile(swept, o.smooth, dz), o.smooth), swept);
  } else {
    swept = o.collar === 'drop' ? clipProfile(full, o.hem, o.neck) : sweepDown(clipProfile(p, o.hem, o.neck));
    if (o.smooth) swept = maxProfile(sweepDown(smoothProfile(envelopeProfile(swept, o.smooth, dz), o.smooth)), swept);
  }
  let inner = offsetProfile(swept, o.clearance);
  const spread = o.neckSpread ?? 0, spreadH = Math.max(1, o.neckSpreadHeight ?? 15);
  if (spread > 0) {
    // the collar opens out: a smooth ramp from nothing at neck - spreadH to the full spread at the neck
    inner = { ...inner, r: inner.r.map((row, k) => {
      const f = Math.min(1, Math.max(0, (inner.z[k] - (o.neck - spreadH)) / spreadH));
      const g = f * f * (3 - 2 * f);
      return Float32Array.from(row, (v) => v + spread * g);
    }) };
  }
  // the collar: at least the neck plus its gap, at most the cavity top, and up to the head projection
  const neckSlice = sweepDown(clipProfile(p, o.neck, o.neck + 6)).r[0] ?? p.r[p.r.length - 1];
  const top = inner.r[inner.r.length - 1];
  const hole = new Float32Array(nTheta);
  for (let i = 0; i < nTheta; i++) {
    const want = o.collar === 'drop' ? headProjection[i] + o.clearance : Math.min(top[i], headProjection[i] + o.clearance);
    hole[i] = Math.min(top[i], Math.max(neckSlice[i] + o.clearance + (o.collarGap ?? 0), want));
  }
  const neckRing = Float32Array.from(neckSlice, (v) => v + o.clearance + (o.collarGap ?? 0));
  const raw = clipProfile(p, o.hem, o.neck);
  const neckSpan: [number, number] = o.collar === 'drop' ? [o.neck, goose.boundingBox().max[2]] : [o.neck, o.neck + 6];
  // the front is the body's centre line toward the head (the goose sits a little yawed in its project), not plain -y
  const front = (o.front !== undefined ? (o.front * Math.PI) / 180 : p.bodyDir ?? (leaning ? Math.atan2(shear.sy, shear.sx) : p.headDir) ?? -Math.PI / 2) + ((o.frontOffset ?? 0) * Math.PI) / 180;
  return { swept, inner, hole, headProjection, centre: [p.cx, p.cy], front, neckRing, raw, neckSpan, shear };
}

/** Smallest signed angle difference, radians. */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * A solid that removes everything above a height that varies around the
 * axis (the neckline): an annulus from rIn to rOut whose underside is z(θ),
 * walled up to zTop.
 */
function heightCutter(cx: number, cy: number, zOf: (theta: number) => number, N: number, rIn: number, rOut: number, zTop: number): IndexedMesh {
  const positions: number[] = [];
  const ring = (r: number, zf: (t: number) => number) => {
    const start = positions.length / 3;
    for (let i = 0; i < N; i++) { const t = (i / N) * Math.PI * 2; positions.push(cx + r * Math.cos(t), cy + r * Math.sin(t), zf(t)); }
    return start;
  };
  const innerLow = ring(rIn, zOf), outerLow = ring(rOut, zOf), innerHigh = ring(rIn, () => zTop), outerHigh = ring(rOut, () => zTop);
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => { tris.push(a, b, c, a, c, d); };
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    quad(innerLow + i, outerLow + i, outerLow + j, innerLow + j);      // underside, normal down
    quad(outerLow + i, outerHigh + i, outerHigh + j, outerLow + j);    // outer wall, normal out
    quad(innerLow + j, innerHigh + j, innerHigh + i, innerLow + i);    // inner wall, normal in
    quad(innerHigh + i, innerHigh + j, outerHigh + j, outerHigh + i);  // top, normal up
  }
  return { positions: Float32Array.from(positions), triangles: Uint32Array.from(tris) };
}

/** The mesh as a Manifold with positive volume, flipping it if it came out inside out. */
async function orient(m: IndexedMesh): Promise<ManifoldT> {
  const man = await toManifold(m);
  if (man.volume() >= 0) return man;
  const tri = Uint32Array.from(m.triangles);
  for (let i = 0; i < tri.length; i += 3) { const x = tri[i + 1]; tri[i + 1] = tri[i + 2]; tri[i + 2] = x; }
  return toManifold({ positions: m.positions, triangles: tri });
}

/**
 * Cuts a finished garment (goose frame) in two along a plane through the
 * leaned axis, with disc-magnet pockets facing each other across each seam.
 * Where the wall is thinner than the magnet needs, a round pad is added on
 * the outside of the seam first.
 */
export async function splitGarment(solid: ManifoldT, cav: Pick<Cavity, 'centre' | 'front' | 'shear'>, o: GarmentOptions, warnings: string[]): Promise<{ solid: ManifoldT; parts: ManifoldT[] }> {
  const { Manifold, CrossSection } = await manifold();
  const axis = [cav.shear.sx, cav.shear.sy, 1];
  const along = o.split === 'sides' ? [Math.cos(cav.front), Math.sin(cav.front), 0] : [-Math.sin(cav.front), Math.cos(cav.front), 0];
  // plane normal = along x axis, normalised
  let n = [along[1] * axis[2] - along[2] * axis[1], along[2] * axis[0] - along[0] * axis[2], along[0] * axis[1] - along[1] * axis[0]];
  const nl = Math.hypot(n[0], n[1], n[2]);
  n = n.map((v) => v / nl);
  const p0 = [cav.centre[0], cav.centre[1], cav.shear.z0];
  const d = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2];
  const D = o.splitMagnetDiameter ?? 3, T = o.splitMagnetThickness ?? 1, M = Math.max(0, Math.round(o.splitMagnets ?? 3));
  const need = D + 1.2; // wall needed to hold a pocket with 0.6 mm either side
  type Site = { x: number; y: number; z: number; out: [number, number]; thick: number; side: number };
  const t = [-n[1], n[0]]; // horizontal direction in the plane
  // every wall crossing of the plane, at heights 1.5 mm apart: a seam is one side's run of crossings
  const crossings: Site[] = [];
  for (let z = o.hem + 1; z <= o.neck - 1; z += 1.5) {
    const px = p0[0] + cav.shear.sx * (z - cav.shear.z0), py = p0[1] + cav.shear.sy * (z - cav.shear.z0);
    const strip = CrossSection.square([400, 0.4], true).rotate((Math.atan2(t[1], t[0]) * 180) / Math.PI).translate([px, py]);
    for (const poly of solid.slice(z).intersect(strip).toPolygons() as [number, number][][]) {
      const c = polygonCentroid(poly);
      if (c.area < 0.05) continue;
      let lo = Infinity, hi = -Infinity;
      for (const [x, y] of poly) { const s = (x - px) * t[0] + (y - py) * t[1]; lo = Math.min(lo, s); hi = Math.max(hi, s); }
      const side = (c.x - px) * t[0] + (c.y - py) * t[1] >= 0 ? 1 : -1;
      crossings.push({ x: c.x, y: c.y, z, out: [t[0] * side, t[1] * side], thick: hi - lo, side });
    }
  }
  // M pockets spread evenly over each seam's height, with D clear of its ends
  const sites: Site[] = [];
  for (const side of [1, -1]) {
    const seam = crossings.filter((c) => c.side === side).sort((a, b) => a.z - b.z);
    if (!seam.length) continue;
    const zLo = seam[0].z + D, zHi = seam[seam.length - 1].z - D;
    for (let j = 0; j < M; j++) {
      const want = M === 1 ? (zLo + zHi) / 2 : zLo + ((zHi - zLo) * j) / (M - 1);
      let best = seam[0];
      for (const c of seam) if (Math.abs(c.z - want) < Math.abs(best.z - want)) best = c;
      if (!sites.some((s) => s.side === side && Math.abs(s.z - best.z) < D)) sites.push(best);
    }
  }
  if (!sites.length) { warnings.push('no wall crossed the cut plane; the garment was not split'); return { solid, parts: [solid] }; }
  const pads: ManifoldT[] = [], pockets: ManifoldT[] = [];
  let padded = 0;
  const alongN = (m: ManifoldT) => {
    // a cylinder built along +z, turned onto the plane normal
    const yaw = (Math.atan2(n[1], n[0]) * 180) / Math.PI, pitch = (Math.acos(Math.max(-1, Math.min(1, n[2]))) * 180) / Math.PI;
    return m.rotate([0, pitch, 0]).rotate([0, 0, yaw]);
  };
  for (const s of sites) {
    let [x, y] = [s.x, s.y];
    if (s.thick < need) {
      // a pad on the outside: its inner face flush with the wall's inner face
      const padD = need + 0.4;
      x = s.x - s.out[0] * (s.thick / 2) + s.out[0] * (padD / 2);
      y = s.y - s.out[1] * (s.thick / 2) + s.out[1] * (padD / 2);
      pads.push(alongN(Manifold.cylinder(2 * (T + 0.2) + 1.6, padD / 2, padD / 2, 32, true)).translate(x, y, s.z));
      padded++;
    }
    pockets.push(alongN(Manifold.cylinder(2 * (T + 0.2), (D + 0.3) / 2, (D + 0.3) / 2, 32, true)).translate(x, y, s.z));
  }
  if (pads.length) solid = solid.add(Manifold.union(pads));
  solid = solid.subtract(Manifold.union(pockets));
  const parts = [solid.trimByPlane(n as [number, number, number], d), solid.trimByPlane(n.map((v) => -v) as [number, number, number], -d)].filter((m) => m.volume() > 1);
  warnings.push(`split into ${parts.length} halves with ${sites.length} magnet pockets for ${D} x ${T} mm discs${padded ? ` (${padded} on pads where the wall is under ${need.toFixed(1)} mm)` : ''}`);
  return { solid, parts };
}

/**
 * A solid covering everything above the body's top surface at each angle
 * (plus `t`), capped at the neck height: subtracting it cuts a loft off
 * where the body slopes away behind the neck, so nothing is drawn in toward
 * the axis there.
 */
function aboveBodyCutter(cav: Cavity, o: GarmentOptions, t: number): IndexedMesh {
  const N = cav.raw.nTheta;
  const zTopAt = new Float32Array(N).fill(o.hem);
  for (let k = 0; k < cav.raw.z.length; k++) for (let i = 0; i < N; i++) if (cav.raw.r[k][i] > 0) zTopAt[i] = cav.raw.z[k];
  const smoothTop = Float32Array.from(zTopAt, (_, i) => Math.max(zTopAt[(i + N - 1) % N], zTopAt[i], zTopAt[(i + 1) % N]));
  const dz = cav.raw.z.length > 1 ? cav.raw.z[1] - cav.raw.z[0] : 1;
  return heightCutter(cav.centre[0], cav.centre[1], (th) => {
    const i = Math.round((th / (Math.PI * 2)) * N) % N;
    return Math.min(o.neck, smoothTop[i] + dz) + t;
  }, N, 0.01, 300, o.neck + 200);
}

/** A shirt, sweater or coat: a shell that follows the goose between hem and neck. */
export async function contourGarment(goose: ManifoldT, opts: Partial<GarmentOptions> = {}): Promise<GarmentResult> {
  const o = { ...DEFAULT_GARMENT, ...opts };
  if (o.neck - o.hem < 3 * (o.dz ?? 1) + o.thickness) throw new Error('neck must be above the hem');
  const { Manifold } = await manifold();
  const cav = cavityProfile(goose, o);
  goose = shearManifold(goose, cav.shear, -1);
  const N = cav.inner.nTheta, t = o.thickness;
  const outer = offsetProfile(cav.swept, o.clearance + t);
  const K = cav.inner.z.length;
  const theta = (i: number) => (i / N) * Math.PI * 2;
  const inner: BodyProfile = cav.inner;
  const out: BodyProfile = { ...outer, z: [...outer.z], r: outer.r.map((row) => Float32Array.from(row)) };
  // surface: fabric texture, hem band and placket are small bumps on the outside
  const depth = o.fabricDepth ?? 0, pitch = o.fabricPitch ?? 48, band = o.hemBand ?? 0;
  for (let k = 0; k < K; k++) {
    const z = out.z[k];
    for (let i = 0; i < N; i++) {
      let bump = 0;
      if (o.fabric === 'ribbed') bump += depth * 0.5 * (1 + Math.cos(theta(i) * Math.round(pitch)));
      if (o.fabric === 'puffer') bump += depth * Math.pow(Math.abs(Math.sin((Math.PI * (z - o.hem)) / Math.max(2, pitch))), 0.6);
      if (band > 0 && z < o.hem + band) bump = Math.max(bump, 0.3 + 0.3 * (1 + Math.cos(theta(i) * 96)) * 0.5);
      if (o.placket) { const half = Math.atan2(2.5, out.r[k][i]); if (Math.abs(angleDiff(theta(i), cav.front)) < half) bump = Math.max(bump, 0.7); }
      out.r[k][i] += bump;
    }
  }
  // guarantee the shell has thickness everywhere
  for (let k = 0; k < inner.r.length; k++) for (let i = 0; i < N; i++) out.r[k][i] = Math.max(out.r[k][i], inner.r[k][i] + t);
  const mesh = loftShell(inner, out);
  let solid = await toManifold(mesh);
  // where the body ends below the neck height (behind the neck, the back slopes away), the garment ends too
  solid = solid.subtract(await orient(aboveBodyCutter(cav, o, t)));
  // the collar plate: the shoulders around the neck, as flat 2D shapes, so it is a ring around the neck and not a cone to the axis
  const { CrossSection } = await manifold();
  const shoulders = CrossSection.union([goose.slice(o.neck - 0.5), goose.slice(o.neck - 2)]).offset(o.clearance + t + (o.neckSpread ?? 0), 'Round', 2, 32);
  const neckSlices: CrossSectionT[] = [];
  for (let z = cav.neckSpan[0]; z <= cav.neckSpan[1]; z += 1) neckSlices.push(goose.slice(Math.min(z, cav.neckSpan[1] - 0.01)));
  const neckHole = CrossSection.union(neckSlices).offset(o.clearance + (o.collarGap ?? 0) + (o.neckSpread ?? 0), 'Round', 2, 32);
  // the plate starts a little below the loft's top ring so the two always join; the body's cavity is carved out of it
  const loftTop = cav.inner.z[cav.inner.z.length - 1];
  let plate = Manifold.extrude(shoulders.subtract(neckHole), o.neck + t - (loftTop - 0.5)).translate(0, 0, loftTop - 0.5);
  const cavityMesh = loftSolid({ ...cav.inner, z: cav.inner.z.map((z, k) => (k === 0 ? z - 5 : z)) });
  plate = plate.subtract(await toManifold(cavityMesh));
  solid = solid.add(plate);
  const collarH = o.collarHeight ?? 0;
  if (collarH > 0) {
    const tube = Manifold.extrude(neckHole.offset(t, 'Round', 2, 32).subtract(neckHole), collarH).translate(0, 0, o.neck + t);
    solid = solid.add(tube);
  }
  const topZ = o.neck + t + collarH;
  // neckline: cut the front down from the top edge
  const nd = o.necklineDepth ?? 0, nw = ((o.necklineWidth ?? 45) * Math.PI) / 180;
  if (o.neckline !== 'crew' && nd > 0 && nw > 0) {
    const zCut = (th: number) => {
      const a = Math.abs(angleDiff(th, cav.front));
      const f = a >= nw ? 0 : o.neckline === 'v' ? 1 - a / nw : Math.cos((Math.PI / 2) * (a / nw));
      return topZ + 1 - f * (topZ + 1 - (o.neck - nd));
    };
    solid = solid.subtract(await orient(heightCutter(cav.centre[0], cav.centre[1], zCut, N, 0.01, 300, topZ + 60)));
  }
  // back to the goose's frame; buttons stay round, so they go on after
  solid = shearManifold(solid, cav.shear, 1);
  const nb = Math.max(0, Math.round(o.buttons ?? 0));
  if (nb > 0) {
    const bd = o.buttonDiameter ?? 3;
    const zTop = (o.neckline !== 'crew' && nd > 0 ? o.neck - nd : o.neck) - bd, zBot = o.hem + band + bd;
    const buttons: ManifoldT[] = [];
    for (let n = 0; n < nb; n++) {
      const z = nb === 1 ? (zTop + zBot) / 2 : zTop - ((zTop - zBot) * n) / (nb - 1);
      if (z < o.hem || z > o.neck) continue;
      const k = Math.min(K - 1, Math.max(0, Math.round((z - o.hem) / (out.z[1] - out.z[0]))));
      const i = Math.round((cav.front / (Math.PI * 2)) * N + N) % N;
      const r = out.r[k][i] + bd * 0.15;
      const x = cav.centre[0] + r * Math.cos(cav.front) + cav.shear.sx * (z - cav.shear.z0);
      const y = cav.centre[1] + r * Math.sin(cav.front) + cav.shear.sy * (z - cav.shear.z0);
      buttons.push(Manifold.sphere(bd / 2, 32).translate(x, y, z));
    }
    if (buttons.length) solid = solid.add(Manifold.union(buttons));
  }
  const warnings: string[] = [];
  // keep the garment itself: a sliver of plate left over a wing tip or a bump is not part of it
  const bodies = solid.decompose().sort((a, b) => b.volume() - a.volume());
  if (bodies.length > 1) {
    const dropped = bodies.slice(1).reduce((v, b) => v + b.volume(), 0);
    if (dropped > 1) warnings.push(`dropped ${bodies.length - 1} loose piece(s), ${dropped.toFixed(1)} mm³`);
    solid = bodies[0];
  }
  let parts: ManifoldT[] | undefined;
  if (o.formFit && (o.split ?? 'none') === 'none') warnings.push('a form-fitting garment cannot slide on; split it to wear it');
  if (o.split && o.split !== 'none') ({ solid, parts } = await splitGarment(solid, cav, o, warnings));
  const result = fromManifold(solid);
  // stripes: paint by height band
  let faceMaterial: Uint8Array | undefined;
  if (o.stripes && o.stripes > 0) {
    const n = result.triangles.length / 3;
    faceMaterial = new Uint8Array(n);
    for (let f = 0; f < n; f++) {
      const a = result.triangles[f * 3] * 3, b = result.triangles[f * 3 + 1] * 3, c = result.triangles[f * 3 + 2] * 3;
      const z = (result.positions[a + 2] + result.positions[b + 2] + result.positions[c + 2]) / 3;
      faceMaterial[f] = Math.floor((z - o.hem) / o.stripes) % 2 === 1 ? 1 : 0;
    }
  }
  const hemR = cav.inner.r[0];
  if (Math.min(...hemR) < t) warnings.push('the hem touches the axis; raise the hem');
  const holeW = 2 * Math.max(...cav.hole), headW = 2 * Math.max(...cav.headProjection);
  const tight = cav.hole.some((h, i) => h < cav.headProjection[i] + o.clearance - 1e-6);
  const note = o.collar === 'drop' ? 'drops straight on' : tight ? 'goes on tilted, beak first through the neckline' : 'drops straight on';
  return { mesh: result, solid, faceMaterial, centre: cav.centre, inner: cav.inner, parts, warnings: [...warnings, `collar up to ${holeW.toFixed(0)} mm across (head and beak project ${headW.toFixed(0)} mm): ${note}`] };
}

export interface WrapOptions extends GarmentOptions {
  /** 'shell' keeps the garment's own thickness map; 'solid' seats the garment's outer surface at thickness and hollows it */
  mode?: 'auto' | 'shell' | 'solid';
  /** mm of the garment's top (collar) kept at its true proportions; the rest stretches to reach the hem (0 = stretch all) */
  keepTop?: number;
  /** remove a closed bottom (pen pots): 'auto' detects it, or a height in mm to cut off, 0 = keep */
  floor?: 'auto' | number;
  /** turn the model about its own axis, degrees, on top of the automatic facing (its -y lands on the goose's front) */
  garmentTurn?: number;
  /** where the model's axis is, mm from the centre of its bounding box */
  garmentShift?: [number, number];
  /** the band of the model that lands between hem and neck, mm above its bottom (after any floor is removed); the rest is cut away */
  garmentBand?: [number, number];
  /** mm cut off the model's sides in its own frame: [left (-x), right (+x), front (-y), back (+y)] */
  garmentCrop?: [number, number, number, number];
  /** a smooth layer this thick between the body and the model, so a thin or noisy model has solid material behind it; the model moves out by the same amount */
  liner?: number;
  /** passes of mesh smoothing on the model before it is stretched (0 = none): takes out fine surface texture, which a tall model squashed onto the body would otherwise show as crumple */
  smoothModel?: number;
}

/**
 * Taubin smoothing of a mesh: alternate shrinking and inflating Laplacian
 * steps, so fine texture goes while the overall shape and size stay.
 */
export function smoothMesh(mesh: IndexedMesh, passes: number): IndexedMesh {
  if (passes <= 0) return mesh;
  const P = Float32Array.from(mesh.positions), T = mesh.triangles, nv = P.length / 3;
  // neighbour lists as CSR
  const deg = new Int32Array(nv + 1);
  for (let i = 0; i < T.length; i += 3) { deg[T[i] + 1] += 2; deg[T[i + 1] + 1] += 2; deg[T[i + 2] + 1] += 2; }
  for (let v = 1; v <= nv; v++) deg[v] += deg[v - 1];
  const fill = Int32Array.from(deg.subarray(0, nv)), nb = new Int32Array(deg[nv]);
  for (let i = 0; i < T.length; i += 3) {
    const a = T[i], b = T[i + 1], c = T[i + 2];
    nb[fill[a]++] = b; nb[fill[a]++] = c; nb[fill[b]++] = a; nb[fill[b]++] = c; nb[fill[c]++] = a; nb[fill[c]++] = b;
  }
  const Q = new Float32Array(P.length);
  const step = (lambda: number) => {
    for (let v = 0; v < nv; v++) {
      const n = deg[v + 1] - deg[v];
      if (!n) { Q[v * 3] = P[v * 3]; Q[v * 3 + 1] = P[v * 3 + 1]; Q[v * 3 + 2] = P[v * 3 + 2]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (let e = deg[v]; e < deg[v + 1]; e++) { const w = nb[e] * 3; sx += P[w]; sy += P[w + 1]; sz += P[w + 2]; }
      Q[v * 3] = P[v * 3] + lambda * (sx / n - P[v * 3]);
      Q[v * 3 + 1] = P[v * 3 + 1] + lambda * (sy / n - P[v * 3 + 1]);
      Q[v * 3 + 2] = P[v * 3 + 2] + lambda * (sz / n - P[v * 3 + 2]);
    }
    P.set(Q);
  };
  for (let n = 0; n < passes; n++) { step(0.5); step(-0.53); }
  return { positions: P, triangles: T };
}

/**
 * Nearest and farthest crossing of a section's edges along rays from (cx, cy),
 * per angle; angle i is measured in the turned frame (ray direction i - turn).
 * Angles no edge crosses keep rmin = Infinity and rmax = 0.
 */
function radialExtents(polys: [number, number][][], cx: number, cy: number, N: number, turn: number, rmin: Float32Array, rmax: Float32Array) {
  const twoPi = Math.PI * 2;
  for (const poly of polys) {
    for (let e = 0; e < poly.length; e++) {
      const [px, py] = poly[e], [qx, qy] = poly[(e + 1) % poly.length];
      const ax = px - cx, ay = py - cy, ex = qx - px, ey = qy - py;
      // the turned angles the edge spans, as the shorter arc
      const a0 = Math.atan2(ay, ax) + turn;
      let da = Math.atan2(qy - cy, qx - cx) + turn - a0;
      if (da > Math.PI) da -= twoPi; else if (da < -Math.PI) da += twoPi;
      const lo = Math.min(a0, a0 + da), hi = Math.max(a0, a0 + da);
      const i0 = Math.ceil((lo / twoPi) * N), i1 = Math.floor((hi / twoPi) * N);
      for (let j = i0; j <= i1; j++) {
        const i = ((j % N) + N) % N;
        const ang = (i / N) * twoPi - turn, cs = Math.cos(ang), sn = Math.sin(ang);
        const den = cs * ey - sn * ex;
        if (Math.abs(den) < 1e-12) continue;
        const s = (ax * sn - ay * cs) / den;
        if (s < -1e-9 || s > 1 + 1e-9) continue;
        const t = (ax * ey - ay * ex) / den;
        if (t <= 0) continue;
        if (t < rmin[i]) rmin[i] = t;
        if (t > rmax[i]) rmax[i] = t;
      }
    }
  }
}

/** The model's mean radius about an axis, over its height: what the wrap scales to the body's mean radius. */
export function garmentMeanRadius(garment: ManifoldT, cx: number, cy: number): number {
  const bb = garment.boundingBox();
  const p = bodyProfile(garment, bb.min[2] + 0.1, Math.max(0.5, (bb.max[2] - bb.min[2]) / 24), 72, [cx, cy]);
  let sum = 0, n = 0;
  for (const row of p.r) for (const v of row) if (v > 0) { sum += v; n++; }
  return n ? sum / n : 0;
}

/** The model after the floor, the chosen band and the side crops are cut, and where its axis is. */
export function trimGarment(garment: ManifoldT, o: Partial<WrapOptions>, warnings: string[] = []) {
  const floor = o.floor === undefined || o.floor === 'auto' ? floorHeight(garment) : o.floor;
  if (floor > 0) {
    garment = garment.trimByPlane([0, 0, 1], garment.boundingBox().min[2] + floor + 0.2);
    warnings.push(`removed a ${floor.toFixed(1)} mm closed bottom`);
  }
  const band = o.garmentBand;
  if (band) {
    const z0 = garment.boundingBox().min[2];
    if (band[0] > 0) garment = garment.trimByPlane([0, 0, 1], z0 + band[0]);
    if (Number.isFinite(band[1]) && band[1] > band[0]) garment = garment.trimByPlane([0, 0, -1], -(z0 + band[1]));
  }
  let bb = garment.boundingBox();
  // the axis is set before any side crop, so cropping a side does not move the rest of the model
  const gcx = (bb.min[0] + bb.max[0]) / 2 + (o.garmentShift?.[0] ?? 0), gcy = (bb.min[1] + bb.max[1]) / 2 + (o.garmentShift?.[1] ?? 0);
  const crop = o.garmentCrop;
  if (crop) {
    if (crop[0] > 0) garment = garment.trimByPlane([1, 0, 0], bb.min[0] + crop[0]);
    if (crop[1] > 0) garment = garment.trimByPlane([-1, 0, 0], -(bb.max[0] - crop[1]));
    if (crop[2] > 0) garment = garment.trimByPlane([0, 1, 0], bb.min[1] + crop[2]);
    if (crop[3] > 0) garment = garment.trimByPlane([0, -1, 0], -(bb.max[1] - crop[3]));
    bb = garment.boundingBox();
  }
  return { garment, bb, gcx, gcy };
}

/** An affine preview of where the wrap puts the model: column-major 4x4 matrix in the goose's frame (the real wrap also bends it to the body). */
export interface WrapFrame { matrix: number[]; widthScale: number; heightScale: number; turn: number; shear: Shear }

export function wrapFrame(garment: ManifoldT, cav: Cavity, opts: Partial<WrapOptions> = {}): WrapFrame {
  const o = { ...DEFAULT_GARMENT, mode: 'auto' as const, keepTop: 0, floor: 'auto' as const, ...opts };
  const { bb, gcx, gcy } = trimGarment(garment, o, []);
  const turn = cav.front + Math.PI / 2 + ((o.garmentTurn ?? 0) * Math.PI) / 180;
  let meanInner = 0, cnt = 0;
  for (const row of cav.inner.r) for (const v of row) { meanInner += v; cnt++; }
  meanInner /= cnt || 1;
  const meanOuter = garmentMeanRadius(garment, gcx, gcy);
  const widthScale = meanOuter > 0 ? meanInner / meanOuter : 1;
  const heightScale = (o.neck - o.hem) / Math.max(1e-6, bb.max[2] - bb.min[2]);
  const c = Math.cos(turn), sn = Math.sin(turn), w = widthScale, h = heightScale, { sx, sy, z0 } = cav.shear;
  // M = Shear · T(cx, cy, hem) · S(w, w, h) · Rz(turn) · T(-gcx, -gcy, -gz0), column-major
  const [cx, cy] = cav.centre;
  const a = [w * c, w * sn, 0, 0, -w * sn, w * c, 0, 0, 0, 0, h, 0, cx - w * (c * gcx - sn * gcy), cy - w * (sn * gcx + c * gcy), o.hem - h * bb.min[2], 1];
  // shear rows: x' = x + sx (z - z0), y' = y + sy (z - z0)
  const m = a.slice();
  for (let col = 0; col < 4; col++) { m[col * 4] += sx * a[col * 4 + 2]; m[col * 4 + 1] += sy * a[col * 4 + 2]; }
  m[12] -= sx * z0; m[13] -= sy * z0;
  return { matrix: m, widthScale, heightScale, turn, shear: cav.shear };
}

/** Height of a closed floor at the bottom of a model, 0 if it is open underneath. */
export function floorHeight(garment: ManifoldT): number {
  const bb = garment.boundingBox();
  const h = bb.max[2] - bb.min[2];
  // the floor ends where the cavity starts: the section is no longer one filled disc (a hole appears, or it is well short of
  // its hull); thick-walled models (a hoodie with hands in its pocket) still fill 60% of their hull above the floor
  let last = 0;
  for (let z = bb.min[2] + 0.4; z < bb.min[2] + 0.4 * h; z += 0.5) {
    const cs = garment.slice(z);
    const area = cs.area(), hull = cs.hull().area();
    if (!hull || cs.toPolygons().length > 1 || area / hull < 0.9) return last;
    last = z - bb.min[2];
  }
  return last;
}

/**
 * Stretches an imported garment (its own frame: hem at z = 0, +Z up, roughly
 * centred on its axis) over the goose between hem and neck, then hollows it
 * with the drop-on solid so it slides over the head.
 */
export async function wrapGarment(garment: ManifoldT, goose: ManifoldT, opts: Partial<WrapOptions> = {}): Promise<GarmentResult & { mode: 'shell' | 'solid' }> {
  const o = { ...DEFAULT_GARMENT, mode: 'auto' as const, keepTop: 0, floor: 'auto' as const, ...opts };
  const { Manifold } = await manifold();
  const cav = cavityProfile(goose, o);
  const { inner, front, shear } = cav;
  const warnings: string[] = [];
  // the garment faces -y in its own frame; turn it so that lands on the goose's front
  const turn = front + Math.PI / 2 + ((o.garmentTurn ?? 0) * Math.PI) / 180;
  // pen pots and vases have a closed bottom: cut it off so the garment is open at the hem; then keep only the chosen band
  const trimmed = trimGarment(garment, o, warnings);
  garment = trimmed.garment;
  const { bb, gcx, gcy } = trimmed;
  // split long edges first, or the straight triangles of a coarse part (sleeves, collars, floors on an otherwise fine model)
  // would cut through the goose's curves and kink once their corners are mapped; fine parts are left as they are
  const maxEdge = Math.min(3, Math.max(1, (bb.max[2] - bb.min[2]) / 50));
  let refined = garment.refineToLength(maxEdge);
  if (refined.numTri() > 3_000_000) refined = garment.refineToLength(maxEdge * 3);
  const g = smoothMesh(fromManifold(refined), o.smoothModel ?? 0);
  const gz0 = bb.min[2], gh = bb.max[2] - bb.min[2];
  const N = inner.nTheta, bands = Math.max(8, Math.round(gh / 2));
  // per (angle, height band): the garment's nearest and farthest surface from its axis, measured on a section through
  // the band's centre (exact, so a coarse or unevenly meshed inside does not leave gaps that would dent the seat)
  const rmin = new Float32Array(N * bands).fill(Infinity), rmax = new Float32Array(N * bands).fill(0);
  for (let b = 0; b < bands; b++) {
    const zb = gz0 + ((b + 0.5) / bands) * gh;
    radialExtents(garment.slice(zb).toPolygons() as [number, number][][], gcx, gcy, N, turn, rmin.subarray(b * N, (b + 1) * N), rmax.subarray(b * N, (b + 1) * N));
  }
  const nv = g.positions.length / 3;
  const theta = new Float32Array(nv), u = new Float32Array(nv), rad = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = g.positions[v * 3] - gcx, y = g.positions[v * 3 + 1] - gcy, z = g.positions[v * 3 + 2];
    theta[v] = (Math.atan2(y, x) + turn + Math.PI * 4) % (Math.PI * 2);
    u[v] = Math.min(1, Math.max(0, (z - gz0) / gh));
    rad[v] = Math.hypot(x, y);
  }
  // the inner reference is the wall, not a stray bit near the axis (a drawstring end, a floor remnant): never less than half
  // the band's typical outer radius. The band's median, not the bin's own outer radius, so a sleeve or pocket standing out
  // from the body does not pull the wall's reference out with it and step the surface along its outline
  for (let b = 0; b < bands; b++) {
    const row = Array.from(rmax.subarray(b * N, (b + 1) * N)).filter((v) => v > 0).sort((p, q) => p - q);
    if (!row.length) continue;
    const floor = 0.5 * row[row.length >> 1];
    for (let i = b * N; i < (b + 1) * N; i++) if (rmin[i] !== Infinity) rmin[i] = Math.max(rmin[i], floor);
  }
  // fill empty bins from neighbours so every vertex has a reference
  for (let pass = 0; pass < N; pass++) {
    let changed = false;
    for (let b = 0; b < bands; b++) for (let i = 0; i < N; i++) {
      const idx = b * N + i;
      if (rmin[idx] !== Infinity) continue;
      for (const j of [b * N + (i + 1) % N, b * N + (i + N - 1) % N, (b > 0 ? b - 1 : b) * N + i, (b + 1 < bands ? b + 1 : b) * N + i]) {
        if (rmin[j] !== Infinity) { rmin[idx] = rmin[j]; rmax[idx] = rmax[j]; changed = true; break; }
      }
    }
    if (!changed) break;
  }
  // shell or solid? a shell has an inner surface well inside its outer one over most bins
  let mode = o.mode;
  if (mode === 'auto') {
    // a shell has a cavity running up through it: most sections across the middle of its height are rings (more than one
    // polygon, or well under their hull's area); a thick puffer is still a shell, a solid bust or dome is not
    let rings = 0, total = 0;
    for (let f = 0.2; f <= 0.8; f += 0.1) {
      const cs = garment.slice(gz0 + f * gh);
      const hull = cs.hull().area();
      if (!hull) continue;
      total++;
      if (cs.toPolygons().length > 1 || cs.area() < 0.85 * hull) rings++;
    }
    mode = total && rings >= 0.6 * total ? 'shell' : 'solid';
  }
  const sampleInner = (th: number, zz: number) => {
    // bilinear in the profile: height index and angle index
    const kf = Math.min(inner.z.length - 1, Math.max(0, (zz - inner.z[0]) / (inner.z[inner.z.length - 1] - inner.z[0]) * (inner.z.length - 1)));
    const k0 = Math.floor(kf), k1 = Math.min(inner.z.length - 1, k0 + 1), fk = kf - k0;
    const af = th / (Math.PI * 2) * N, i0 = Math.floor(af) % N, i1 = (i0 + 1) % N, fa = af - Math.floor(af);
    const row = (k: number) => inner.r[k][i0] * (1 - fa) + inner.r[k][i1] * fa;
    return row(k0) * (1 - fk) + row(k1) * fk;
  };
  // height map: the top `keepTop` mm of the garment keep their proportions (scaled by the body/garment width ratio), the rest stretches to the hem
  let meanInner = 0, cnt = 0;
  for (const row of inner.r) for (const v of row) { meanInner += v; cnt++; }
  meanInner /= cnt || 1;
  const meanOuter = garmentMeanRadius(garment, gcx, gcy);
  const widthScale = meanOuter > 0 ? meanInner / meanOuter : 1;
  const keepTop = Math.min(o.keepTop ?? 0, gh);
  const keptHeight = Math.min(keepTop * widthScale, 0.8 * (o.neck - o.hem));
  const zOf = (uu: number) => {
    const fromTop = (1 - uu) * gh; // mm below the garment's top edge, in its own frame
    if (keepTop <= 0 || fromTop <= keepTop) return o.neck - fromTop * (keepTop > 0 ? keptHeight / keepTop : (o.neck - o.hem) / gh);
    return o.neck - keptHeight - ((fromTop - keepTop) / Math.max(1e-6, gh - keepTop)) * (o.neck - o.hem - keptHeight);
  };
  const liner = Math.max(0, o.liner ?? 0);
  // the reference radii are read bilinearly between band centres and bin centres, so the seat does not step at each band (stripes)
  const ref = (table: Float32Array, th: number, uu: number) => {
    const bf = uu * bands - 0.5, b0 = Math.max(0, Math.min(bands - 1, Math.floor(bf))), b1 = Math.min(bands - 1, b0 + 1), fb = Math.min(1, Math.max(0, bf - b0));
    const af = (th / (Math.PI * 2)) * N - 0.5, i0 = ((Math.floor(af) % N) + N) % N, i1 = (i0 + 1) % N, fa = af - Math.floor(af);
    const row = (b: number) => table[b * N + i0] * (1 - fa) + table[b * N + i1] * fa;
    return row(b0) * (1 - fb) + row(b1) * fb;
  };
  const positions = new Float32Array(g.positions.length);
  for (let v = 0; v < nv; v++) {
    const d = mode === 'shell' ? rad[v] - ref(rmin, theta[v], u[v]) : o.thickness + rad[v] - ref(rmax, theta[v], u[v]);
    const z = zOf(u[v]);
    // 0.3 mm margin keeps the garment's inside clear of the carving solid, so the cut leaves no slivers or holes
    // the goose pushes the garment out; where the body is absent at that height (behind the neck) the garment keeps its own scaled shape
    const pushed = sampleInner(theta[v], z) + 0.3 + liner + Math.max(d, mode === 'shell' ? 0 : -1e9);
    const own = rad[v] * widthScale + liner;
    const r = Math.max(pushed, own);
    positions[v * 3] = inner.cx + r * Math.cos(theta[v]);
    positions[v * 3 + 1] = inner.cy + r * Math.sin(theta[v]);
    positions[v * 3 + 2] = z;
  }
  let solid: ManifoldT;
  try {
    solid = await toManifold({ positions, triangles: g.triangles });
  } catch (e) {
    throw new Error(`the stretched garment is not a valid solid (${(e as Error).message}); try a simpler model or a smoother fit`);
  }
  // hollow it with the drop-on solid, extended below the hem and above the neck so the cut is clean
  const core = clipProfile(inner, o.hem, o.neck);
  const coreMesh = loftSolid({ ...core, z: core.z.map((z, k) => (k === 0 ? z - 5 : k === core.z.length - 1 ? z + 5 : z)) });
  let hollow = solid.subtract(await toManifold(coreMesh));
  if (liner > 0) {
    // the liner: a smooth shell from the clearance surface out to where the model now sits, cut off where the body ends behind the neck
    let shell = await toManifold(loftShell(core, offsetProfile(core, liner + 0.35)));
    shell = shell.subtract(await orient(aboveBodyCutter(cav, o, liner + 0.35)));
    hollow = hollow.add(shell);
  }
  const carved = shearManifold(hollow, shear, 1);
  const bodies = carved.decompose().filter((b) => b.volume() > 1);
  let result = bodies.length > 1 ? Manifold.union(bodies) : bodies[0] ?? carved;
  if (bodies.length !== 1) warnings.push(`${bodies.length} separate pieces after hollowing (${bodies.map((b) => b.volume().toFixed(0)).join(', ')} mm³)`);
  if (result.volume() < 0.3 * solid.volume()) warnings.push('most of the garment was inside the goose; raise the thickness or use solid mode');
  let parts: ManifoldT[] | undefined;
  if (o.formFit && (o.split ?? 'none') === 'none') warnings.push('a form-fitting garment cannot slide on; split it to wear it');
  if (o.split && o.split !== 'none') ({ solid: result, parts } = await splitGarment(result, cav, o, warnings));
  return { mesh: fromManifold(result), solid: result, centre: [inner.cx, inner.cy], inner, parts, warnings, mode };
}

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

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import { fromManifold, manifold, toManifold } from './fit.ts';

export interface BodyProfile {
  /** axis position */
  cx: number;
  cy: number;
  /** direction from the axis to whatever is above the reference range (the head), radians; undefined if nothing is there */
  headDir?: number;
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
}

export const DEFAULT_GARMENT: GarmentOptions = {
  hem: 46, neck: 108, thickness: 1.6, clearance: 0.4, collar: 'tilt', collarGap: 1, dz: 0.75, nTheta: 144, smooth: 2,
  neckline: 'v', necklineDepth: 14, necklineWidth: 45, collarHeight: 0,
  fabric: 'plain', fabricDepth: 0.4, fabricPitch: 48, buttons: 0, buttonDiameter: 3, placket: false, hemBand: 0, stripes: 0,
};

/** Samples the goose as a radial profile from `zMin` to the top of the model. */
export function bodyProfile(goose: ManifoldT, zMin: number, dz: number, nTheta: number, centre?: [number, number], zRef?: [number, number]): BodyProfile {
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
  return { cx, cy, headDir, z: zs, r, nTheta };
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
}

/** The space a garment between hem and neck must leave for the goose, and the collar opening. */
export function cavityProfile(goose: ManifoldT, opts: Partial<GarmentOptions> = {}): Cavity {
  const o = { ...DEFAULT_GARMENT, ...opts };
  const dz = o.dz ?? 1, nTheta = o.nTheta ?? 144;
  const p = bodyProfile(goose, o.hem, dz, nTheta, o.centre, [o.hem, o.neck]);
  const full = sweepDown(p); // everything above each height, head included
  const kNeck = p.z.findIndex((z) => z >= o.neck - 1e-6);
  const headProjection = full.r[Math.min(kNeck < 0 ? p.z.length - 1 : kNeck, p.z.length - 1)];
  let swept = o.collar === 'drop' ? clipProfile(full, o.hem, o.neck) : sweepDown(clipProfile(p, o.hem, o.neck));
  if (o.smooth) swept = maxProfile(sweepDown(smoothProfile(swept, o.smooth)), swept);
  const inner = offsetProfile(swept, o.clearance);
  // the collar: at least the neck plus its gap, at most the cavity top, and up to the head projection
  const neckSlice = sweepDown(clipProfile(p, o.neck, o.neck + 6)).r[0] ?? p.r[p.r.length - 1];
  const top = inner.r[inner.r.length - 1];
  const hole = new Float32Array(nTheta);
  for (let i = 0; i < nTheta; i++) {
    const want = o.collar === 'drop' ? headProjection[i] + o.clearance : Math.min(top[i], headProjection[i] + o.clearance);
    hole[i] = Math.min(top[i], Math.max(neckSlice[i] + o.clearance + (o.collarGap ?? 0), want));
  }
  const neckRing = Float32Array.from(neckSlice, (v) => v + o.clearance + (o.collarGap ?? 0));
  const front = (o.front !== undefined ? (o.front * Math.PI) / 180 : p.headDir ?? -Math.PI / 2) + ((o.frontOffset ?? 0) * Math.PI) / 180;
  return { swept, inner, hole, headProjection, centre: [p.cx, p.cy], front, neckRing };
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

/** A shirt, sweater or coat: a shell that follows the goose between hem and neck. */
export async function contourGarment(goose: ManifoldT, opts: Partial<GarmentOptions> = {}): Promise<GarmentResult> {
  const o = { ...DEFAULT_GARMENT, ...opts };
  if (o.neck - o.hem < 3 * (o.dz ?? 1) + o.thickness) throw new Error('neck must be above the hem');
  const { Manifold } = await manifold();
  const cav = cavityProfile(goose, o);
  const N = cav.inner.nTheta, t = o.thickness;
  const outer = offsetProfile(cav.swept, o.clearance + t);
  const K = cav.inner.z.length;
  const theta = (i: number) => (i / N) * Math.PI * 2;
  // the collar plate sits on top of the cavity: two rings above the neck with the hole radius
  const plateZ = [o.neck + 0.05, o.neck + t];
  const innerZ = [...cav.inner.z, ...plateZ], innerR = [...cav.inner.r, Float32Array.from(cav.hole), Float32Array.from(cav.hole)];
  const outerTop = outer.r[K - 1];
  const outerZ = [...outer.z, ...plateZ], outerR = [...outer.r, Float32Array.from(outerTop), Float32Array.from(outerTop)];
  // a collar tube hugging the neck above the plate
  const collarH = o.collarHeight ?? 0;
  if (collarH > 0) {
    for (const z of [o.neck + t + 0.05, o.neck + t + collarH]) {
      innerZ.push(z); innerR.push(Float32Array.from(cav.neckRing));
      outerZ.push(z); outerR.push(Float32Array.from(cav.neckRing, (v) => v + t));
    }
  }
  const inner: BodyProfile = { ...cav.inner, z: innerZ, r: innerR };
  const out: BodyProfile = { ...outer, z: outerZ, r: outerR };
  // surface: fabric texture, hem band and placket are small bumps on the outside, below the plate only
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
  const topZ = innerZ[innerZ.length - 1];
  // neckline: cut the front down from the top edge
  const nd = o.necklineDepth ?? 0, nw = ((o.necklineWidth ?? 45) * Math.PI) / 180;
  if (o.neckline !== 'crew' && nd > 0 && nw > 0) {
    const zCut = (th: number) => {
      const a = Math.abs(angleDiff(th, cav.front));
      const f = a >= nw ? 0 : o.neckline === 'v' ? 1 - a / nw : Math.cos((Math.PI / 2) * (a / nw));
      return topZ + 1 - f * (topZ + 1 - (o.neck - nd));
    };
    const cutterMesh = heightCutter(cav.centre[0], cav.centre[1], zCut, N, 0.5, 300, topZ + 60);
    let cutter = await toManifold(cutterMesh);
    if (cutter.volume() < 0) {
      // inside out: flip every triangle
      const tri = Uint32Array.from(cutterMesh.triangles);
      for (let i = 0; i < tri.length; i += 3) { const x = tri[i + 1]; tri[i + 1] = tri[i + 2]; tri[i + 2] = x; }
      cutter = await toManifold({ positions: cutterMesh.positions, triangles: tri });
    }
    solid = solid.subtract(cutter);
  }
  // buttons down the front
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
      buttons.push(Manifold.sphere(bd / 2, 32).translate(cav.centre[0] + r * Math.cos(cav.front), cav.centre[1] + r * Math.sin(cav.front), z));
    }
    if (buttons.length) solid = solid.add(Manifold.union(buttons));
  }
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
  const warnings: string[] = [];
  const hemR = cav.inner.r[0];
  if (Math.min(...hemR) < t) warnings.push('the hem touches the axis; raise the hem');
  const holeW = 2 * Math.max(...cav.hole), headW = 2 * Math.max(...cav.headProjection);
  const tight = cav.hole.some((h, i) => h < cav.headProjection[i] + o.clearance - 1e-6);
  const note = o.collar === 'drop' ? 'drops straight on' : tight ? 'goes on tilted, beak first through the neckline' : 'drops straight on';
  return { mesh: result, solid, faceMaterial, centre: cav.centre, inner: cav.inner, warnings: [...warnings, `collar up to ${holeW.toFixed(0)} mm across (head and beak project ${headW.toFixed(0)} mm): ${note}`] };
}

export interface WrapOptions extends GarmentOptions {
  /** 'shell' keeps the garment's own thickness map; 'solid' seats the garment's outer surface at thickness and hollows it */
  mode?: 'auto' | 'shell' | 'solid';
  /** mm of the garment's top (collar) kept at its true proportions; the rest stretches to reach the hem (0 = stretch all) */
  keepTop?: number;
  /** remove a closed bottom (pen pots): 'auto' detects it, or a height in mm to cut off, 0 = keep */
  floor?: 'auto' | number;
}

/** Height of a closed floor at the bottom of a model, 0 if it is open underneath. */
export function floorHeight(garment: ManifoldT): number {
  const bb = garment.boundingBox();
  const h = bb.max[2] - bb.min[2];
  let last = 0;
  for (let z = bb.min[2] + 0.4; z < bb.min[2] + 0.4 * h; z += 0.5) {
    const cs = garment.slice(z);
    const area = cs.area(), hull = cs.hull().area();
    if (!hull || area / hull < 0.6) return last;
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
  const { inner } = cavityProfile(goose, o);
  const warnings: string[] = [];
  // pen pots and vases have a closed bottom: cut it off so the garment is open at the hem
  const floor = o.floor === 'auto' ? floorHeight(garment) : o.floor;
  if (floor > 0) {
    garment = garment.trimByPlane([0, 0, 1], garment.boundingBox().min[2] + floor + 0.2);
    warnings.push(`removed a ${floor.toFixed(1)} mm closed bottom`);
  }
  const bb = garment.boundingBox();
  // split long edges first, or the straight triangles of a simple model would cut through the goose's curves once their corners are mapped
  const maxEdge = Math.max(0.75, (bb.max[2] - bb.min[2]) / 30);
  const g = fromManifold(garment.numTri() > 400000 ? garment : garment.refineToLength(maxEdge));
  const gcx = (bb.min[0] + bb.max[0]) / 2, gcy = (bb.min[1] + bb.max[1]) / 2;
  const gz0 = bb.min[2], gh = bb.max[2] - bb.min[2];
  const N = inner.nTheta, bands = Math.max(8, Math.round(gh / 2));
  // per (angle bin, height band): the garment's nearest and farthest radius
  const rmin = new Float32Array(N * bands).fill(Infinity), rmax = new Float32Array(N * bands).fill(0);
  const nv = g.positions.length / 3;
  const theta = new Float32Array(nv), u = new Float32Array(nv), rad = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = g.positions[v * 3] - gcx, y = g.positions[v * 3 + 1] - gcy, z = g.positions[v * 3 + 2];
    theta[v] = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
    u[v] = Math.min(1, Math.max(0, (z - gz0) / gh));
    rad[v] = Math.hypot(x, y);
    const bin = Math.floor(theta[v] / (Math.PI * 2) * N) % N, band = Math.min(bands - 1, Math.floor(u[v] * bands));
    const idx = band * N + bin;
    rmin[idx] = Math.min(rmin[idx], rad[v]); rmax[idx] = Math.max(rmax[idx], rad[v]);
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
    const ratios: number[] = [];
    for (let i = 0; i < N * bands; i++) if (rmax[i] > 0 && rmin[i] !== Infinity) ratios.push((rmax[i] - rmin[i]) / rmax[i]);
    ratios.sort((a, b) => a - b);
    mode = ratios.length && ratios[Math.floor(ratios.length / 2)] < 0.5 ? 'shell' : 'solid';
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
  let meanInner = 0, meanOuter = 0, cnt = 0;
  for (const row of inner.r) for (const v of row) { meanInner += v; cnt++; }
  meanInner /= cnt || 1;
  cnt = 0;
  for (let i = 0; i < N * bands; i++) if (rmax[i] > 0) { meanOuter += rmax[i]; cnt++; }
  meanOuter /= cnt || 1;
  const widthScale = meanOuter > 0 ? meanInner / meanOuter : 1;
  const keepTop = Math.min(o.keepTop ?? 0, gh);
  const keptHeight = Math.min(keepTop * widthScale, 0.8 * (o.neck - o.hem));
  const zOf = (uu: number) => {
    const fromTop = (1 - uu) * gh; // mm below the garment's top edge, in its own frame
    if (keepTop <= 0 || fromTop <= keepTop) return o.neck - fromTop * (keepTop > 0 ? keptHeight / keepTop : (o.neck - o.hem) / gh);
    return o.neck - keptHeight - ((fromTop - keepTop) / Math.max(1e-6, gh - keepTop)) * (o.neck - o.hem - keptHeight);
  };
  const positions = new Float32Array(g.positions.length);
  for (let v = 0; v < nv; v++) {
    const bin = Math.floor(theta[v] / (Math.PI * 2) * N) % N, band = Math.min(bands - 1, Math.floor(u[v] * bands));
    const idx = band * N + bin;
    const d = mode === 'shell' ? rad[v] - rmin[idx] : o.thickness + rad[v] - rmax[idx];
    const z = zOf(u[v]);
    // 0.3 mm margin keeps the garment's inside clear of the carving solid, so the cut leaves no slivers or holes
    const r = sampleInner(theta[v], z) + 0.3 + Math.max(d, mode === 'shell' ? 0 : -1e9);
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
  const carved = solid.subtract(await toManifold(coreMesh));
  const bodies = carved.decompose().filter((b) => b.volume() > 1);
  const result = bodies.length > 1 ? Manifold.union(bodies) : bodies[0] ?? carved;
  if (bodies.length !== 1) warnings.push(`${bodies.length} separate pieces after hollowing`);
  if (result.volume() < 0.3 * solid.volume()) warnings.push('most of the garment was inside the goose; raise the thickness or use solid mode');
  return { mesh: fromManifold(result), solid: result, centre: [inner.cx, inner.cy], inner, warnings, mode };
}

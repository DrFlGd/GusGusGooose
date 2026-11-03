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
}

export const DEFAULT_GARMENT: GarmentOptions = { hem: 46, neck: 108, thickness: 1.6, clearance: 0.4, collar: 'tilt', collarGap: 1, dz: 0.75, nTheta: 144, smooth: 2 };

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
  if (!centre) {
    // area-weighted centroid of the sections in the garment's height range
    let sx = 0, sy = 0, sa = 0;
    zs.forEach((z, k) => {
      if (zRef && (z < zRef[0] || z > zRef[1])) return;
      for (const poly of slices[k][0]) {
        const { area, x, y } = polygonCentroid(poly);
        sx += x * area; sy += y * area; sa += area;
      }
    });
    cx = sa ? sx / sa : (bb.min[0] + bb.max[0]) / 2;
    cy = sa ? sy / sa : (bb.min[1] + bb.max[1]) / 2;
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
  return { cx, cy, z: zs, r, nTheta };
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
  return { swept, inner, hole, headProjection, centre: [p.cx, p.cy] };
}

/** A shirt, sweater or coat: a shell that follows the goose between hem and neck. */
export async function contourGarment(goose: ManifoldT, opts: Partial<GarmentOptions> = {}): Promise<GarmentResult> {
  const o = { ...DEFAULT_GARMENT, ...opts };
  if (o.neck - o.hem < 3 * (o.dz ?? 1) + o.thickness) throw new Error('neck must be above the hem');
  const cav = cavityProfile(goose, o);
  const outer = offsetProfile(cav.swept, o.clearance + o.thickness);
  // the collar plate sits on top of the cavity: two rings above the neck with the hole radius
  const K = cav.inner.z.length;
  const plateZ = [o.neck + 0.05, o.neck + o.thickness];
  const inner: BodyProfile = { ...cav.inner, z: [...cav.inner.z, ...plateZ], r: [...cav.inner.r, Float32Array.from(cav.hole), Float32Array.from(cav.hole)] };
  const outerTop = outer.r[K - 1];
  outer.z = [...outer.z, ...plateZ];
  outer.r = [...outer.r, Float32Array.from(outerTop), Float32Array.from(outerTop)];
  // guarantee the shell has thickness everywhere
  for (let k = 0; k < inner.r.length; k++) for (let i = 0; i < inner.nTheta; i++) outer.r[k][i] = Math.max(outer.r[k][i], inner.r[k][i] + o.thickness);
  const mesh = loftShell(inner, outer);
  const solid = await toManifold(mesh);
  const warnings: string[] = [];
  const hemR = cav.inner.r[0];
  if (Math.min(...hemR) < o.thickness) warnings.push('the hem touches the axis; raise the hem');
  const holeW = 2 * Math.max(...cav.hole), headW = 2 * Math.max(...cav.headProjection);
  const tight = cav.hole.some((h, i) => h < cav.headProjection[i] + o.clearance - 1e-6);
  const note = o.collar === 'drop' ? 'drops straight on' : tight ? 'goes on tilted, beak first through the collar' : 'drops straight on';
  return { mesh, solid, centre: cav.centre, inner: cav.inner, warnings: [...warnings, `collar up to ${holeW.toFixed(0)} mm across (head and beak project ${headW.toFixed(0)} mm): ${note}`] };
}

export interface WrapOptions extends GarmentOptions {
  /** 'shell' keeps the garment's own thickness map; 'solid' seats the garment's outer surface at thickness and hollows it */
  mode?: 'auto' | 'shell' | 'solid';
}

/**
 * Stretches an imported garment (its own frame: hem at z = 0, +Z up, roughly
 * centred on its axis) over the goose between hem and neck, then hollows it
 * with the drop-on solid so it slides over the head.
 */
export async function wrapGarment(garment: ManifoldT, goose: ManifoldT, opts: Partial<WrapOptions> = {}): Promise<GarmentResult & { mode: 'shell' | 'solid' }> {
  const o = { ...DEFAULT_GARMENT, mode: 'auto' as const, ...opts };
  const { Manifold } = await manifold();
  const { inner } = cavityProfile(goose, o);
  const bb = garment.boundingBox();
  // split long edges first, or the straight triangles of a simple model would cut through the goose's curves once their corners are mapped
  const maxEdge = Math.max(0.75, (bb.max[2] - bb.min[2]) / 30);
  const g = fromManifold(garment.refineToLength(maxEdge));
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
  const positions = new Float32Array(g.positions.length);
  for (let v = 0; v < nv; v++) {
    const bin = Math.floor(theta[v] / (Math.PI * 2) * N) % N, band = Math.min(bands - 1, Math.floor(u[v] * bands));
    const idx = band * N + bin;
    const d = mode === 'shell' ? rad[v] - rmin[idx] : o.thickness + rad[v] - rmax[idx];
    const z = o.hem + u[v] * (o.neck - o.hem);
    const r = sampleInner(theta[v], z) + Math.max(d, mode === 'shell' ? 0 : -1e9);
    positions[v * 3] = inner.cx + r * Math.cos(theta[v]);
    positions[v * 3 + 1] = inner.cy + r * Math.sin(theta[v]);
    positions[v * 3 + 2] = z;
  }
  const warnings: string[] = [];
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

// Slide-in magnet channels for the goose body: instead of pausing the print
// to drop each magnet into its void, a channel runs from the void (the seat,
// unchanged, so accessories still align) to a mouth on the surface that a
// separate part covers: the beak for the head, and a flush white key in each
// belly mouth behind the legs for the wings (the beak's own magnet already
// slides in from the beak's back). The magnet slides up the channel, an
// accessory held on the outside pulls it into its seat, a drop of glue
// fixes it, and the key or the beak closes the mouth. Pure geometry: no Node
// APIs, so the browser app builds the same thing.
//
// Two channel shapes (Jerred, 2026-11-09):
// - `swept`: the seat itself swept along the path, so the channel is only as
//   big as the magnet needs; its walls slope, so the key has six sides.
// - `flat`: a rectangular bore square to the channel, just big enough for
//   the seat's silhouette, clipped so it never passes the seat's outer face.
//   The key is a flat-sided bar that prints lying on a side, or upright
//   (its inner end cut level with the goose's layers, so printed on that
//   end, upside down, its outer face has the same layer lines as the belly).

import type { Manifold as ManifoldT, ManifoldToplevel } from 'manifold-3d';
import type { VoidPrimitive } from './map-voids.ts';

export type V3 = [number, number, number];

export type ChannelStyle = 'swept' | 'flat';
/** How the key's inner end is cut: square to the channel, or level with the goose's layers (for printing upright). */
export type KeyEnd = 'square' | 'level';

export interface SlotOptions {
  style: ChannelStyle;
  keyEnd: KeyEnd;
  /** channel clearance per side over the magnet void, mm */
  channelClear: number;
  /** how much smaller than the channel the key is, per side, mm */
  keyClear: number;
  /** the key stops this far short of the magnet's travel, mm */
  keyGap: number;
  /** the registration tongue on the head key, into the beak; null for a flush key */
  tongue: TongueOptions | null;
  /** flat style: where the rectangular bore begins, mm along the channel from the junction (default: once the seat's whole silhouette has passed) */
  boreStart?: number;
}

export interface TongueOptions {
  /** how far the tongue stands out of the face, mm */
  proud: number;
  /** pocket clearance per side, mm */
  clear: number;
  /** tongue cross-section: across the channel, and through it, mm */
  size: [number, number];
  /** offset of the tongue from the channel's centre line, through the channel (positive is toward the seat's outer face), mm */
  offset: number;
}

export const DEFAULT_SLOTS: SlotOptions = {
  style: 'flat',
  keyEnd: 'square',
  channelClear: 0.15,
  keyClear: 0.2,
  keyGap: 1.0,
  tongue: { proud: 1.5, clear: 0.15, size: [6, 2], offset: 2.1 },
  boreStart: 0,
};

export interface ChannelSpec {
  /** which seat this channel serves (`VoidPrimitive.name` is not unique, so the seat is passed by value) */
  seat: VoidPrimitive;
  /** where the magnet comes out: a point on the body surface (the channel is extended past it) */
  mouth: V3;
  /**
   * Final snug travel: the seat is swept this far along `dropAxis` (the
   * seat's own plane) before the oblique leg to the mouth begins, so the
   * magnet's last move into its seat is straight and tight. 0 for none.
   */
  drop: number;
  dropAxis?: V3;
  /** whether this channel's key carries the registration tongue (the head's, into the beak) */
  tongue?: boolean;
  /** false for a channel whose key must not take the level end (the head's runs nearly level, so it would lose the key) */
  levelEnd?: boolean;
}

export interface Channel {
  spec: ChannelSpec;
  options: SlotOptions;
  /** direction of the oblique leg, seat to mouth, unit */
  direction: V3;
  /** the channel's frame: across the bore, through the bore (toward the seat's outer face), and along it */
  frame: { across: V3; through: V3; along: V3 };
  /** the junction between the drop and the oblique leg (the seat centre when there is no drop) */
  junction: V3;
  /** the void to cut from the body: the seat and the whole channel, with clearance */
  cut: ManifoldT;
  /** the key that fills the channel behind the magnet, in world coordinates (inside the body, plus its tongue) */
  key: ManifoldT;
  /** the part of the key outside the body (the tongue), or null */
  tongue: ManifoldT | null;
  /** the pocket to cut from the cover part for the tongue, or null */
  pocket: ManifoldT | null;
  /** a magnet-sized solid in the seat, for pictures */
  magnet: ManifoldT;
  /** the channel cross-section square to the oblique leg, mm: across, and through */
  bore: [number, number];
  /** channel length from the seat centre to the mouth */
  length: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

/**
 * The seat as a solid, grown by `grow` on every side but the outer face
 * (the face toward the surface, index `outer` of the seat's axes with sign
 * `outerSign`), which stays put so the magnet's resting place is unchanged.
 */
export function seatSolid(M: ManifoldToplevel['Manifold'], seat: VoidPrimitive, grow: number, outer: { axis: number; sign: number }): ManifoldT {
  const size = seat.size.map((s) => s + 2 * grow) as V3;
  // keep the outer face: shift the centre inward by the growth along that axis
  const centre = add(seat.center, seat.axes[outer.axis], -outer.sign * grow);
  const local = seat.kind === 'cylinder'
    ? M.cylinder(size[2], size[0] / 2, size[0] / 2, 96, true)
    : M.cube(size, true);
  return local.transform(columnMajor(seat.axes, centre) as any);
}

/** Which of the seat's axes points at the surface, with the sign toward it, from the fit profile's outward axis. */
export function outerFace(seat: VoidPrimitive, outward: V3): { axis: number; sign: number } {
  let best = 0, bestDot = -Infinity;
  for (let k = 0; k < 3; k++) { const d = Math.abs(dot(seat.axes[k], outward)); if (d > bestDot) { bestDot = d; best = k; } }
  return { axis: best, sign: Math.sign(dot(seat.axes[best], outward)) || 1 };
}

/** Column-major 4x4 whose columns are the local axes and origin. */
export function columnMajor(axes: [V3, V3, V3], origin: V3): number[] {
  return [...axes[0], 0, ...axes[1], 0, ...axes[2], 0, ...origin, 1];
}

/** A solid swept along a polyline of its centre positions: the union of the hulls of each consecutive pair. */
export function sweep(M: ManifoldToplevel['Manifold'], solid: ManifoldT, from: V3, through: V3[]): ManifoldT {
  const hulls: ManifoldT[] = [];
  let prev = from;
  for (const p of through) {
    hulls.push(M.hull([solid.translate(sub(prev, from) as any), solid.translate(sub(p, from) as any)]));
    prev = p;
  }
  return hulls.length === 1 ? hulls[0] : M.union(hulls);
}

/** The corners of a seat grown by `grow` (the outer face kept), for projections. */
function seatCorners(seat: VoidPrimitive, grow: number, outer: { axis: number; sign: number }): V3[] {
  const size = seat.size.map((s) => s + 2 * grow) as V3;
  const centre = add(seat.center, seat.axes[outer.axis], -outer.sign * grow);
  const out: V3[] = [];
  if (seat.kind === 'cylinder') {
    // the rim of both faces
    for (const s of [-1, 1]) for (let j = 0; j < 48; j++) {
      const th = (j / 48) * Math.PI * 2;
      out.push(add(add(add(centre, seat.axes[2], (s * size[2]) / 2), seat.axes[0], (Math.cos(th) * size[0]) / 2), seat.axes[1], (Math.sin(th) * size[1]) / 2));
    }
  } else {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      out.push(add(add(add(centre, seat.axes[0], (sx * size[0]) / 2), seat.axes[1], (sy * size[1]) / 2), seat.axes[2], (sz * size[2]) / 2));
    }
  }
  return out;
}

/** A half-space: everything with `dot(p, n) <= d`. */
function halfSpace(M: ManifoldToplevel['Manifold'], n: V3, d: number): ManifoldT {
  const nn = unit(n);
  const helper: V3 = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = unit(cross(helper, nn)), e2 = cross(nn, e1);
  const S = 600;
  return M.cube([S, S, S], true).transform(columnMajor([e1, e2, nn], add(scale(nn, d - S / 2), [0, 0, 0])) as any);
}

/**
 * Builds one channel. `outward` is the seat's outward axis from the fit
 * profile (so the outer face is known); `body` is the solid body before any
 * cut, which trims the key flush with the surface; `extra` is how far past
 * the mouth the cut reaches, so it opens cleanly.
 */
export function buildChannel(M: ManifoldToplevel['Manifold'], spec: ChannelSpec, outward: V3, body: ManifoldT, options: SlotOptions = DEFAULT_SLOTS, extra = 8): Channel {
  const { seat } = spec;
  const outer = outerFace(seat, outward);
  const outAxis = scale(seat.axes[outer.axis], outer.sign);
  const c = seat.center;
  const dropAxis = spec.dropAxis ?? ([0, 0, -1] as V3);
  const junction = spec.drop > 0 ? add(c, unit(dropAxis), spec.drop) : c;
  const along = unit(sub(spec.mouth, junction));
  const end = add(spec.mouth, along, extra);
  // the frame: across = the seat's widest side axis made square to the channel; through = toward the outer face
  const sides = [0, 1, 2].filter((k) => k !== outer.axis);
  const wide = sides.sort((a, b) => Math.abs(dot(seat.axes[a], along)) - Math.abs(dot(seat.axes[b], along)))[0];
  let across = unit(sub(seat.axes[wide], scale(along, dot(seat.axes[wide], along))));
  let through = cross(along, across);
  if (dot(through, outAxis) < 0) { through = scale(through, -1); across = scale(across, -1); }
  const frame = { across, through, along };
  // the seat's silhouette square to the channel, with clearance
  // (after a drop the magnet starts its oblique travel at the junction, so the silhouette is taken there)
  const grown = seatCorners(seat, options.channelClear, outer).map((p) => add(p, sub(junction, c)));
  const extent = (v: V3, pts: V3[]) => { let lo = Infinity, hi = -Infinity; for (const p of pts) { const t = dot(sub(p, junction), v); lo = Math.min(lo, t); hi = Math.max(hi, t); } return [lo, hi] as [number, number]; };
  const [a0, a1] = extent(across, grown), [t0, t1] = extent(through, grown), [l0, l1] = extent(along, grown);
  const bore: [number, number] = [a1 - a0, t1 - t0];
  const faceLimit = dot(add(c, outAxis, seat.size[outer.axis] / 2), outAxis); // never past the seat's outer face
  const lMouth = dot(sub(spec.mouth, junction), along);
  const boreSolid = (shrink: number, from: number, to: number) => {
    const w = bore[0] - 2 * shrink, h = bore[1] - 2 * shrink;
    const centre = add(add(add(junction, across, (a0 + a1) / 2), through, (t0 + t1) / 2), along, (from + to) / 2);
    return M.cube([w, h, to - from], true).transform(columnMajor([across, through, along], centre) as any);
  };
  const path = spec.drop > 0 ? [junction, end] : [end];
  const seatGrown = seatSolid(M, seat, options.channelClear, outer);
  let cut: ManifoldT, inner: ManifoldT;
  if (options.style === 'swept') {
    cut = sweep(M, seatGrown, c, path);
    inner = sweep(M, seatSolid(M, seat, options.channelClear - options.keyClear, outer), c, path);
  } else {
    // the magnet leaves the seat along the swept transition (as tight as the swept channel), and the rectangular
    // bore takes over once the whole silhouette has passed; a bore reaching back over the seat would open the wing's top
    const clip = halfSpace(M, outAxis, faceLimit);
    const L1 = l1 - l0;
    const start = Math.min(L1 - 0.5, options.boreStart ?? L1 - 0.5);
    const transition = sweep(M, seatGrown, c, [...(spec.drop > 0 ? [junction] : []), add(junction, along, L1)]);
    cut = M.union([transition, boreSolid(0, start, lMouth + extra).intersect(clip)]);
    inner = boreSolid(options.keyClear, start, lMouth + extra).intersect(clip);
  }
  // where the magnet travels snugly: the key stops short of it
  const magnetZone = sweep(M, seatSolid(M, seat, options.channelClear + options.keyGap, outer), c, spec.drop > 0 ? [junction] : [add(c, along, 0.01)]);
  let behindMagnet: ManifoldT;
  if (options.style === 'flat' && options.keyEnd === 'level' && spec.levelEnd !== false) {
    // level with the goose's layers: a horizontal plane under the lowest point of the magnet's travel
    const zMin = magnetZone.boundingBox().min[2];
    behindMagnet = inner.intersect(halfSpace(M, [0, 0, 1], zMin));
  } else {
    const lEnd = extent(along, cornersOf(magnetZone))[1];
    behindMagnet = inner.subtract(halfSpace(M, along, lEnd + dot(junction, along)));
  }
  let key = behindMagnet.intersect(body);
  let tongue: ManifoldT | null = null, pocket: ManifoldT | null = null;
  if (spec.tongue && options.tongue) {
    const t = options.tongue;
    const centre = add(add(junction, across, (a0 + a1) / 2), through, (t0 + t1) / 2 + t.offset);
    const bar = (grow: number, from: number, to: number) => M.cube([t.size[0] + 2 * grow, t.size[1] + 2 * grow, to - from], true).transform(columnMajor([across, through, along], add(centre, along, (from + to) / 2)) as any);
    // the tongue: a bar from inside the key to `proud` past the mouth, never wider than the key, only the part outside the body
    tongue = bar(0, lMouth - 6, lMouth + t.proud).intersect(inner).subtract(body);
    pocket = bar(t.clear, lMouth - 6, lMouth + t.proud + t.clear);
    key = M.union([key, tongue]);
  }
  const magnet = seatSolid(M, seat, -0.1, outer);
  return { spec, options, direction: along, frame, junction, cut, key, tongue, pocket, magnet, bore, length: len(sub(spec.mouth, c)) };
}

function cornersOf(m: ManifoldT): V3[] {
  const bb = m.boundingBox();
  const out: V3[] = [];
  for (const x of [bb.min[0], bb.max[0]]) for (const y of [bb.min[1], bb.max[1]]) for (const z of [bb.min[2], bb.max[2]]) out.push([x, y, z]);
  // the box's corners over-reach an oblique solid; the mesh's own vertices are exact
  const mesh = m.getMesh();
  const P = mesh.vertProperties, n = mesh.numProp;
  const exact: V3[] = [];
  for (let i = 0; i < P.length; i += n) exact.push([P[i], P[i + 1], P[i + 2]]);
  return exact.length ? exact : out;
}

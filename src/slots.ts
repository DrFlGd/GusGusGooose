// Slide-in magnet channels for the goose body: instead of pausing the print
// to drop each magnet into its void, a channel runs from the void (the seat,
// unchanged, so accessories still align) to a mouth on the surface that a
// separate part covers: the beak for the head, and a flush white key in each
// belly mouth behind the legs for the wings (the beak's own magnet already
// slides in from the beak's back). The magnet slides up the channel, an
// accessory held on the outside pulls it into its seat, a drop of glue
// fixes it, and the key or the beak closes the mouth. Pure geometry: no Node
// APIs, so the browser could use it too.

import type { Manifold as ManifoldT, ManifoldToplevel } from 'manifold-3d';
import type { VoidPrimitive } from './map-voids.ts';

export type V3 = [number, number, number];

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
}

/** Channel clearance per side over the magnet void. The void is the magnet plus the print's own fit; a slide needs a little more. */
export const CHANNEL_CLEAR = 0.15;
/** How much smaller than the channel the key is, per side. */
export const KEY_CLEAR = 0.2;
/** The key stops this far short of the magnet's seat. */
export const KEY_GAP = 1.0;

export interface Channel {
  spec: ChannelSpec;
  /** direction of the oblique leg, seat to mouth, unit */
  direction: V3;
  /** the junction between the drop and the oblique leg (the seat centre when there is no drop) */
  junction: V3;
  /** the void to cut from the body: the seat and the whole channel, with clearance */
  cut: ManifoldT;
  /** the key that fills the channel behind the magnet, in world coordinates (inside the body) */
  key: ManifoldT;
  /** a magnet-sized solid in the seat, for pictures */
  magnet: ManifoldT;
  /** the channel cross-section perpendicular to the oblique leg, mm: across the seat's width, and through its thickness */
  bore: [number, number];
  /** channel length from the seat centre to the mouth */
  length: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

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

/**
 * Builds one channel. `outward` is the seat's outward axis from the fit
 * profile (so the outer face is known); `body` is the solid body before any
 * cut, which trims the key flush with the surface; `extra` is how far past
 * the mouth the cut reaches, so it opens cleanly.
 */
export function buildChannel(M: ManifoldToplevel['Manifold'], spec: ChannelSpec, outward: V3, body: ManifoldT, extra = 8): Channel {
  const { seat } = spec;
  const outer = outerFace(seat, outward);
  const c = seat.center;
  const dropAxis = spec.dropAxis ?? ([0, 0, -1] as V3);
  const junction = spec.drop > 0 ? add(c, unit(dropAxis), spec.drop) : c;
  const direction = unit(sub(spec.mouth, junction));
  const end = add(spec.mouth, direction, extra);
  const path = spec.drop > 0 ? [junction, end] : [end];
  const cut = sweep(M, seatSolid(M, seat, CHANNEL_CLEAR, outer), c, path);
  // the key: the same sweep, smaller, trimmed to the body, stopping short of where the magnet travels snugly
  const inner = sweep(M, seatSolid(M, seat, CHANNEL_CLEAR - KEY_CLEAR, outer), c, path);
  const magnetZone = sweep(M, seatSolid(M, seat, CHANNEL_CLEAR + KEY_GAP, outer), c, spec.drop > 0 ? [junction] : [add(c, direction, 0.01)]);
  const key = inner.intersect(body).subtract(magnetZone);
  const magnet = seatSolid(M, seat, -0.1, outer);
  // bore: the seat's silhouette along the oblique leg
  const thick = seat.size[outer.axis];
  const sides = [0, 1, 2].filter((k) => k !== outer.axis);
  const tiltIn = Math.asin(Math.min(1, Math.abs(dot(direction, seat.axes[outer.axis]))));
  const tiltSide = Math.asin(Math.min(1, Math.abs(dot(direction, seat.axes[sides[0]]))));
  const w0 = seat.size[sides[0]], w1 = seat.size[sides[1]];
  const bore: [number, number] = [
    w1 * Math.cos(tiltSide) + w0 * Math.sin(tiltSide) + 2 * CHANNEL_CLEAR,
    thick * Math.cos(tiltIn) + Math.max(w0, w1) * Math.sin(tiltIn) + 2 * CHANNEL_CLEAR,
  ];
  return { spec, direction, junction, cut, key, magnet, bore, length: len(sub(spec.mouth, c)) };
}

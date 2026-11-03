// Flat accessories from a picture: the traced outline becomes a plate of a
// set depth, each colour of the picture an inlay on the front (and the back),
// and a mounting puck is added where the magnet goes: under the plate for an
// accessory that lies on the goose, or at its bottom edge for one that stands
// up on the head. The result is tagged with its colours like an imported 3MF,
// so it goes through prepare, fit, paint and export unchanged.

import type { Manifold as ManifoldT, CrossSection as CrossSectionT } from 'manifold-3d';
import { fromManifold, manifold, toManifoldTagged } from './fit.ts';
import type { Material } from './threemf-write.ts';
import { bounds, pointInside, rectSize, signedArea, type Contour, type RGB } from './vendor/contour.ts';

export interface FlatDesign {
  /** the picture's own units (pixels or SVG units), y up */
  width: number;
  height: number;
  /** everything opaque, as outlines (holes clockwise) */
  silhouette: Contour[];
  regions: { color: RGB; contours: Contour[] }[];
}

export interface FlatMount {
  /** puck: a cylinder for the magnet on the back or under the bottom edge; plate: the magnet goes into the plate itself; none */
  kind: 'puck' | 'plate' | 'none';
  /**
   * flat: the magnet is parallel to the picture, which lies on the goose with its back down; standing: the magnet is
   * perpendicular to the picture, which stands up on the goose, face out
   */
  orientation: 'flat' | 'standing';
  /**
   * the surface the puck joins: the picture's back (flat: under the picture; standing: behind it at its bottom
   * edge, so the puck rests on the goose with the picture just in front of it) or its bottom edge (standing only:
   * the puck right under the edge, the picture centred on it). Default: back.
   */
  attach?: 'back' | 'bottom';
  /** where the puck meets the picture, mm from the picture's centre (default: the deepest point inside the outline, or the bottom centre when standing) */
  at?: [number, number];
  diameter: number;
  height: number;
}

export interface FlatOptions {
  /** the picture's width across, mm */
  width: number;
  /** plate thickness, mm */
  depth: number;
  /** how deep each colour is cut into the face, mm (0 keeps the colours as paint only) */
  inlayDepth: number;
  sides: 'front' | 'both';
  /** outline added round the picture in the base colour, mm; also joins loose pieces */
  margin: number;
  /** fill the holes of the outline (a letter O becomes a disc) */
  fillHoles: boolean;
  mount: FlatMount;
}

export const DEFAULT_FLAT: FlatOptions = { width: 30, depth: 3, inlayDepth: 0.6, sides: 'front', margin: 0, fillHoles: false, mount: { kind: 'puck', orientation: 'flat', diameter: 14, height: 5 } };

export interface FlatResult {
  solid: ManifoldT;
  materials: Material[];
  firstID: number;
  /** where the puck is, mm from the picture's centre */
  mountAt: [number, number];
  /** picture size, mm */
  size: [number, number];
  warnings: string[];
}

const hex = (c: RGB) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const polys = (contours: Contour[]): [number, number][][] => contours.map((c) => { const p: [number, number][] = []; for (let i = 0; i < c.length; i += 2) p.push([c[i], c[i + 1]]); return p; });

/** Builds the accessory. `design` comes from `traceImage` (pictures) or `svgDesign` (vector files). */
export async function buildFlat(design: FlatDesign, opts: FlatOptions): Promise<FlatResult> {
  const { Manifold, CrossSection } = await manifold();
  const warnings: string[] = [];
  const src = design.silhouette.length ? design.silhouette : design.regions.flatMap((r) => r.contours);
  const b = rectSize(bounds(src));
  if (!(b.width > 0 && b.height > 0)) throw new Error('the picture has no outline to build from');
  const k = opts.width / b.width;
  const toMm = (contours: Contour[]) => contours.map((c) => { const o = new Array<number>(c.length); for (let i = 0; i < c.length; i += 2) { o[i] = (c[i] - b.cx) * k; o[i + 1] = (c[i + 1] - b.cy) * k; } return o; });
  const sil = toMm(src);
  let plate: CrossSectionT = new CrossSection(polys(sil), 'NonZero');
  if (opts.margin > 0) {
    // close small gaps between pieces, then grow by the margin
    const r = Math.max(1, Math.min(4, opts.width * 0.03));
    plate = plate.offset(opts.margin + r, 'Round', 2, 32).offset(-r, 'Round', 2, 32);
  }
  if (opts.fillHoles) plate = new CrossSection(polys((plate.toPolygons() as [number, number][][]).map((p) => p.flat()).filter((c) => signedArea(c) > 0)), 'NonZero');
  if (plate.isEmpty()) throw new Error('the picture has no area to build from');
  const pieces = plate.decompose().length;
  if (pieces > 1) warnings.push(`the outline is ${pieces} separate pieces; add a margin to join them`);

  // colours: the biggest region is the plate's own colour, the others are inlays, smallest first so details win
  const regions = design.regions
    .map((r) => ({ color: r.color, section: new CrossSection(polys(toMm(r.contours)), 'EvenOdd').intersect(plate) }))
    .map((r) => ({ ...r, area: r.section.area() }))
    .filter((r) => r.area > 0.2)
    .sort((a, b2) => b2.area - a.area);
  const base = regions[0];
  const materials: Material[] = [{ name: 'Base', color: base ? hex(base.color) : '#e9dcc3' }];
  const inlays: { section: CrossSectionT; material: number }[] = [];
  let taken: CrossSectionT | null = null;
  const depth = Math.max(0.6, opts.depth);
  const inlay = Math.max(0, Math.min(opts.inlayDepth, (opts.sides === 'both' ? depth / 2 : depth) - 0.4));
  for (const r of regions.slice(1).reverse()) {
    let s = r.section;
    if (taken) s = s.subtract(taken);
    if (s.isEmpty() || s.area() < 0.2) continue;
    taken = taken ? taken.add(s) : s;
    materials.push({ name: `Colour ${materials.length}`, color: hex(r.color) });
    inlays.push({ section: s, material: materials.length - 1 });
  }
  const firstID = Manifold.reserveIDs(materials.length);
  const tag = async (m: ManifoldT, material: number) => { const mesh = fromManifold(m); return toManifoldTagged(mesh, new Uint8Array(mesh.triangles.length / 3).fill(material), firstID); };

  // the plate with the inlays let in (as paint when the inlay depth is 0)
  let body = plate.extrude(depth);
  const parts: Promise<ManifoldT>[] = [];
  if (inlay > 0 && taken) {
    const front = taken.extrude(inlay + 0.01).translate(0, 0, depth - inlay);
    body = body.subtract(front);
    if (opts.sides === 'both') body = body.subtract(taken.extrude(inlay + 0.01).translate(0, 0, -0.01));
  }
  parts.push(tag(body, 0));
  for (const i of inlays) {
    const front = i.section.extrude(inlay > 0 ? inlay : 0.02).translate(0, 0, depth - (inlay > 0 ? inlay : 0.02));
    parts.push(tag(front, i.material));
    if (opts.sides === 'both') parts.push(tag(i.section.extrude(inlay > 0 ? inlay : 0.02), i.material));
  }
  if (inlay === 0 && inlays.length) warnings.push('inlay depth 0: the colours are paint only; the faces are a thin skin on the plate');
  let solid = Manifold.union(await Promise.all(parts));

  // the mount
  const m = opts.mount;
  const plateContours = (plate.toPolygons() as [number, number][][]).map((p) => p.flat());
  let mountAt: [number, number] = m.at ?? (m.orientation === 'standing' ? [0, -b.height * k / 2] : poleOf(plateContours));
  if (m.orientation === 'standing') {
    // image y becomes up; the plate's back faces +y and its front -y, its bottom edge at z = 0
    const bottom = -b.height * k / 2;
    mountAt = [mountAt[0], bottom];
    solid = solid.rotate([90, 0, 0]).translate(0, depth / 2, -bottom);
    const r = m.diameter / 2;
    if (m.kind === 'puck' && (m.attach ?? 'back') === 'back') {
      // the puck stands on the goose behind the picture, let into its back; the picture rests beside it, just in front
      const overlap = Math.min(1.5, depth * 0.5);
      const py = depth / 2 + r - overlap;
      const puck = Manifold.cylinder(m.height, r, r, 64, false).translate(mountAt[0], py, 0);
      solid = solid.add(puck).translate(-mountAt[0], -py, 0);
      const hb = b.height * k;
      if (m.height > hb * 0.6) warnings.push(`the puck is ${m.height.toFixed(1)} mm tall, most of the picture's ${hb.toFixed(1)} mm height`);
    } else {
      if (m.kind === 'puck') {
        const puck = Manifold.cylinder(m.height + Math.min(1.5, depth * 0.6), r, r, 64, false).translate(mountAt[0], 0, 0);
        solid = solid.translate(0, 0, m.height).add(puck);
        if (m.diameter < depth) warnings.push('the puck is narrower than the plate is thick');
      } else if (m.kind === 'plate') {
        warnings.push('a standing picture needs a puck; the magnet cannot go into its edge');
      }
      // the magnet is at the origin: the picture slides so the mount is there
      solid = solid.translate(-mountAt[0], 0, 0);
    }
  } else {
    if (m.kind === 'puck') {
      if (!pointInside(plateContours, mountAt[0], mountAt[1])) warnings.push('the puck sits outside the picture; move it onto the outline');
      const puck = Manifold.cylinder(m.height + Math.min(1, depth / 2), m.diameter / 2, m.diameter / 2, 64, false).translate(mountAt[0], mountAt[1], 0);
      solid = solid.translate(0, 0, m.height).add(puck);
    } else if (m.kind === 'plate' && depth < 4) {
      warnings.push(`a ${depth} mm plate is thin for a magnet inside it; the fit warns if the floor over the pocket is too thin`);
    }
    // the fit cuts the pocket at the origin (into the puck, or into the plate's back): the picture slides so the mount is there
    solid = solid.translate(-mountAt[0], -mountAt[1], 0);
  }
  const sb = solid.boundingBox();
  return { solid, materials, firstID, mountAt, size: [b.width * k, b.height * k], warnings: warnings.concat(sb.min[2] < -1e-6 ? ['the model dips below its base'] : []) };
}

/** The point deepest inside a set of outlines (the pole of inaccessibility), by a grid search. */
export function poleOf(contours: Contour[], steps = 48): [number, number] {
  const r = bounds(contours);
  const dist = (x: number, y: number) => {
    let d = Infinity;
    for (const c of contours) for (let i = 0; i < c.length; i += 2) {
      const j = (i + 2) % c.length;
      const ax = c[i], ay = c[i + 1], bx = c[j], by = c[j + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      d = Math.min(d, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
    return d;
  };
  let best: [number, number] = [(r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2], bestD = -1;
  const sx = (r.maxX - r.minX) / steps, sy = (r.maxY - r.minY) / steps;
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
    const x = r.minX + i * sx, y = r.minY + j * sy;
    if (!pointInside(contours, x, y)) continue;
    const d = dist(x, y);
    if (d > bestD) { bestD = d; best = [x, y]; }
  }
  // refine round the best cell
  for (let pass = 0; pass < 3; pass++) {
    const h = Math.max(sx, sy) / 2 ** (pass + 1);
    for (const [ox, oy] of [[-h, 0], [h, 0], [0, -h], [0, h], [-h, -h], [h, h], [-h, h], [h, -h]]) {
      const x = best[0] + ox, y = best[1] + oy;
      if (!pointInside(contours, x, y)) continue;
      const d = dist(x, y);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best;
}

/** A design from an SVG: one region per fill colour, the silhouette their union. */
export function svgDesign(shapes: { contours: Contour[]; fill?: string }[]): FlatDesign {
  const byFill = new Map<string, Contour[]>();
  for (const s of shapes) {
    const key = (s.fill ?? '#000000').toLowerCase();
    byFill.set(key, [...(byFill.get(key) ?? []), ...s.contours]);
  }
  const regions = [...byFill.entries()].map(([fill, contours]) => ({ color: cssColor(fill), contours }));
  const all = regions.flatMap((r) => r.contours);
  const r = bounds(all);
  return { width: r.maxX - r.minX, height: r.maxY - r.minY, silhouette: all, regions };
}

const NAMED: Record<string, RGB> = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], orange: [255, 165, 0], pink: [255, 192, 203], purple: [128, 0, 128], gray: [128, 128, 128], grey: [128, 128, 128], brown: [165, 42, 42], gold: [255, 215, 0], silver: [192, 192, 192], lime: [0, 255, 0], navy: [0, 0, 128], teal: [0, 128, 128], cyan: [0, 255, 255], magenta: [255, 0, 255] };
/** A CSS colour (#rgb, #rrggbb, rgb(), or a common name) as RGB bytes; unknown ones are black. */
export function cssColor(s: string): RGB {
  const t = s.trim().toLowerCase();
  if (NAMED[t]) return NAMED[t];
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (m3) return [parseInt(m3[1] + m3[1], 16), parseInt(m3[2] + m3[2], 16), parseInt(m3[3] + m3[3], 16)];
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/.exec(t);
  if (m6) return [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)];
  const rgb = /^rgba?\(([^)]+)\)/.exec(t);
  if (rgb) { const v = rgb[1].split(/[\s,]+/).map(Number); return [v[0] || 0, v[1] || 0, v[2] || 0]; }
  return [0, 0, 0];
}

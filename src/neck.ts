// The neck as a place to wear things: a press-fit band round the neck (a C
// that clips on from the front, since the head is too big to pass a ring)
// carries an accessory on its front: glued flat against it, or on two tabs
// that plug into slots in the accessory's back. The accessory is carved
// against the goose and the band like any fit, and the band stays its own
// part for printing.

import type { Manifold as ManifoldT, CrossSection as CrossSectionT } from 'manifold-3d';
import { fitAccessory, frameFromAxes, fromManifold, manifold, type FitProfile, type FitResult, type Placement } from './fit.ts';
import type { MagnetVoid } from './voids.ts';

type V3 = [number, number, number];

export interface NeckOptions {
  /** height of the band's centre on the goose, mm */
  height: number;
  bandHeight: number;
  thickness: number;
  /** gap between the band and the neck, mm */
  clearance: number;
  /** how much of the neck's width the opening at the back spans (under 1 so the band snaps on and stays) */
  opening: number;
  attach: 'glue' | 'tabs';
  tabDiameter: number;
  tabLength: number;
  /** distance between the two tabs across the front (0 = one tab in the middle) */
  tabSpacing: number;
  /** play round each tab in its slot, on the diameter */
  tabClearance: number;
}

export const DEFAULT_NECK: NeckOptions = { height: 140, bandHeight: 5, thickness: 1.2, clearance: 0.3, opening: 0.85, attach: 'tabs', tabDiameter: 3, tabLength: 2, tabSpacing: 10, tabClearance: 0.3 };

export interface NeckBand {
  /** the band with its tabs at the length asked for (the fit may shorten them to suit the accessory) */
  band: ManifoldT;
  /** the band without its tabs */
  ring: ManifoldT;
  /** the accessory's place: on the band's front, facing forward */
  point: MagnetVoid;
  /** the tabs' centres on the band's outer face, and their direction */
  tabs: V3[];
  forward: V3;
  /** neck width across at the band, and the opening left at the back, mm */
  neckWidth: number;
  openingWidth: number;
  warnings: string[];
}

/** The goose's forward direction in the plane, from the head to the beak when the profile has both, else -y. */
export function forwardOf(profile: FitProfile): V3 {
  const h = profile.points.head, b = profile.points.beak;
  if (h && b) {
    const dx = b.center[0] - h.center[0], dy = b.center[1] - h.center[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l, 0];
  }
  return [0, -1, 0];
}

/** Builds the band round the neck at the chosen height and works out where the accessory goes. */
export async function makeNeckBand(goose: ManifoldT, profile: FitProfile, opts: NeckOptions): Promise<NeckBand> {
  const { Manifold, CrossSection } = await manifold();
  const warnings: string[] = [];
  const forward = forwardOf(profile);
  const across: V3 = [-forward[1], forward[0], 0];
  // the neck's outline over the band's height: the largest loop at the bottom, middle and top, joined
  const zs = [opts.height - opts.bandHeight / 2 + 0.1, opts.height, opts.height + opts.bandHeight / 2 - 0.1];
  const loops: CrossSectionT[] = [];
  for (const z of zs) {
    const polys = goose.slice(z).toPolygons() as [number, number][][];
    const outers = polys.filter((p) => area(p) > 0).sort((a, b) => area(b) - area(a));
    if (!outers.length) throw new Error(`nothing to put a band round at ${z.toFixed(0)} mm`);
    loops.push(new CrossSection([outers[0]], 'Positive'));
  }
  const neck = CrossSection.union(loops);
  const nb = neck.bounds();
  const c = [(nb.min[0] + nb.max[0]) / 2, (nb.min[1] + nb.max[1]) / 2];
  const inner = neck.offset(opts.clearance, 'Round', 2, 48);
  const outer = inner.offset(opts.thickness, 'Round', 2, 48);
  let band = outer.subtract(inner).extrude(opts.bandHeight).translate(0, 0, opts.height - opts.bandHeight / 2);
  // the neck's width across the forward direction, and the opening at the back
  const width = extent(neck.toPolygons() as [number, number][][], across);
  const openingWidth = Math.max(2, width * Math.min(0.95, Math.max(0.2, opts.opening)));
  const reach = width + 2 * opts.thickness + 10;
  const cut = Manifold.cube([reach, openingWidth, opts.bandHeight + 2], true)
    .translate(-reach / 2, 0, 0) // behind the centre
    .transform(frameFromAxes([c[0], c[1], opts.height], forward, [0, 0, 1]) as any);
  band = band.subtract(cut);
  if (opts.opening >= 0.95) warnings.push('an opening this wide will not hold the band on; 0.8 to 0.9 of the neck snaps on and grips');
  // the front of the band: where the outer outline crosses the forward line through the centre; the tabs where it
  // crosses the lines to either side, since the neck is round and the outline falls away from the middle
  const outerPolys = outer.toPolygons() as [number, number][][];
  const frontAt = (s: number): V3 => {
    let best = -Infinity;
    for (const p of outerPolys) for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length];
      const sa = (ax - c[0]) * across[0] + (ay - c[1]) * across[1] - s, sb = (bx - c[0]) * across[0] + (by - c[1]) * across[1] - s;
      if (sa > 0 === sb > 0) continue;
      const t = sa / (sa - sb);
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      best = Math.max(best, (x - c[0]) * forward[0] + (y - c[1]) * forward[1]);
    }
    if (best === -Infinity) throw new Error('the band has no front');
    return [c[0] + forward[0] * best + across[0] * s, c[1] + forward[1] * best + across[1] * s, opts.height];
  };
  const center = frontAt(0);
  const tabs: V3[] = opts.attach === 'tabs' ? (opts.tabSpacing > 0 ? [-0.5, 0.5] : [0]).map((s) => frontAt(s * opts.tabSpacing)) : [];
  const ring = band;
  if (tabs.length) band = band.add(await tabSolids(tabs, forward, opts.tabDiameter, opts.tabLength));
  if (tabs.length && opts.tabDiameter + 1 > opts.bandHeight) warnings.push('the tabs are nearly as tall as the band; a taller band holds them better');
  const point: MagnetVoid = { center, floor: center, axis: forward, diameter: opts.bandHeight, depth: 0, shape: 'cylinder', mode: 'open', wallFaces: 0, sideAxis: [0, 0, 1] };
  return { band, ring, point, tabs, forward, neckWidth: width, openingWidth, warnings };
}

/** The tabs: cylinders standing `length` out of the band's face at each point, along `forward` (1 mm let into the band). */
async function tabSolids(tabs: V3[], forward: V3, diameter: number, length: number): Promise<ManifoldT> {
  const { Manifold } = await manifold();
  const r = diameter / 2;
  return Manifold.union(tabs.map((t) => Manifold.cylinder(length + 1, r, r, 32, false).translate(0, 0, -1).transform(frameFromAxes(t, [0, 0, 1], forward) as any)));
}

/** The material an accessory must keep in front of a slot's end, mm. */
export const SLOT_SKIN = 0.8;

/**
 * Fits an accessory on the band: carved against the goose and the band
 * together (no magnet pocket), then given a blind slot for each tab. A slot
 * never goes through: it stops `SLOT_SKIN` short of the accessory's front,
 * and when the accessory is too thin for the tabs asked for they are
 * shortened to suit (both the same), or left off with a warning to glue it
 * when even a 1 mm tab will not fit. The band is returned as its own part,
 * with its tabs at the length used.
 */
export async function fitOnNeck(goose: ManifoldT, accessory: ManifoldT, profile: FitProfile, band: NeckBand, placement: Omit<Placement, 'point' | 'pocket'>, opts: NeckOptions): Promise<FitResult & { band: ManifoldT; tabLength: number }> {
  const { Manifold } = await manifold();
  const against = goose.add(band.ring);
  const prof: FitProfile = { ...profile, points: { ...profile.points, neck: band.point } };
  const result = await fitAccessory(against, accessory, prof, { ...placement, point: 'neck', pocket: { none: true } });
  const warnings = [...result.warnings, ...band.warnings];
  let solid = result.solid;
  let finalBand = band.ring;
  let tabLength = 0;
  if (band.tabs.length) {
    const r = (opts.tabDiameter + opts.tabClearance) / 2;
    // how far the accessory reaches in front of each tab's base, along the tab
    const fronts = band.tabs.map((t) => {
      const probe = Manifold.cylinder(60, r, r, 32, false).transform(frameFromAxes(t, [0, 0, 1], band.forward) as any);
      const hit = fromManifold(solid.intersect(probe));
      let front = -Infinity;
      for (let i = 0; i < hit.positions.length; i += 3) front = Math.max(front, (hit.positions[i] - t[0]) * band.forward[0] + (hit.positions[i + 1] - t[1]) * band.forward[1] + (hit.positions[i + 2] - t[2]) * band.forward[2]);
      return front;
    });
    const room = Math.min(...fronts) - SLOT_SKIN - opts.tabClearance;
    tabLength = Math.min(opts.tabLength, Math.floor(room * 10) / 10);
    if (!(tabLength >= 1)) {
      warnings.push(`the accessory is too thin behind the tabs for slots (${Number.isFinite(room) ? `${Math.max(0, room).toFixed(1)} mm of room` : 'nothing behind them'}); the band is left without tabs: glue it, or make the accessory thicker`);
      tabLength = 0;
    } else {
      if (tabLength < opts.tabLength) warnings.push(`tabs shortened to ${tabLength.toFixed(1)} mm so the slots stop ${SLOT_SKIN} mm short of the front`);
      const depth = tabLength + opts.tabClearance;
      const slots = band.tabs.map((t) => Manifold.cylinder(depth + 2, r, r, 32, false).translate(0, 0, -2).transform(frameFromAxes(t, [0, 0, 1], band.forward) as any));
      solid = solid.subtract(Manifold.union(slots));
      finalBand = band.ring.add(await tabSolids(band.tabs, band.forward, opts.tabDiameter, tabLength));
    }
  }
  return { ...result, solid, mesh: fromManifold(solid), band: finalBand, tabLength, warnings };
}

function area(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
  return a / 2;
}

function extent(polys: [number, number][][], dir: V3): number {
  let lo = Infinity, hi = -Infinity;
  for (const p of polys) for (const [x, y] of p) { const d = x * dir[0] + y * dir[1]; lo = Math.min(lo, d); hi = Math.max(hi, d); }
  return hi - lo;
}

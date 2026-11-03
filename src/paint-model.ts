// The paint on a part, apart from any viewer: a colour per mesh triangle and,
// for a triangle painted in more than one colour, the slicer's split of it
// (paint-tree.ts). The tools work in both: the brush splits triangles where
// its edge crosses them, a screen stamp (text, a polygon, a picture) splits
// them where its colours change down to about a pixel, and the bucket fills
// across leaves and whole triangles alike. The mesh never changes, so a
// coarse part takes fine paint without Refine. Undo shares untouched trees
// with the live paint (a tree is copied the first time it changes after a
// snapshot). Pure: the browser's PaintState draws it, the tests drive it.

import type { IndexedMesh } from './stl.ts';
import {
  bakePaint, CORNERS, cloneTree, collapse, encodePaint, forEachLeaf, majority, setLeaf, splitLong,
  type BakedPaint, type Bary, type PaintNode,
} from './paint-tree.ts';
import { faceAdjacency, faceNormals, floodRegion } from './paint-fill.ts';

/** A screen picture of what to paint: per pixel a palette index, or −1 for nothing; row 0 at the top. */
export interface LabelImage { labels: Int16Array; width: number; height: number }

/** How the part lies on the screen, for a stamp. */
export interface StampView {
  /** a world point → its pixel (x right, y down) */
  project(x: number, y: number, z: number): [number, number];
  /** whether mesh triangle `f` is what shows at that pixel (or one touching it, which is close enough at a pixel) */
  visible(f: number, x: number, y: number): boolean;
}

export interface StampOptions {
  /** stop splitting once a piece is this many pixels across (default 1.5) */
  minPx?: number;
  /** or this many millimetres (default 0.05): finer than any nozzle */
  minEdge?: number;
}

/** deepest split (a sliver halves only its long sides, so it may take more levels than a square-ish face) */
export const MAX_DEPTH = 24;

export class PaintModel {
  /** each mesh triangle's colour; for a triangle with a tree, the colour covering most of it */
  readonly faceMaterial: Uint8Array;
  /** triangles painted in more than one colour */
  trees = new Map<number, PaintNode>();
  readonly centroids: Float32Array;
  /** each triangle's farthest corner from its centroid */
  readonly radii: Float32Array;
  readonly count: number;
  readonly mesh: IndexedMesh;
  /** triangles whose look changed since the viewer last caught up; `all` when everything may have */
  protected dirty = new Set<number>();
  protected all = false;
  private frozen = new WeakSet<PaintNode>();
  private history: { faceMaterial: Uint8Array; trees: Map<number, PaintNode> }[] = [];
  private version = 0;
  private bakedCache: { version: number; baked: BakedPaint; adjacency?: Int32Array; normals?: Float32Array } | null = null;
  private adjacency: Int32Array | null = null;
  private normals: Float32Array | null = null;

  constructor(mesh: IndexedMesh) {
    this.mesh = mesh;
    const n = (this.count = mesh.triangles.length / 3);
    this.faceMaterial = new Uint8Array(n);
    this.centroids = new Float32Array(n * 3);
    this.radii = new Float32Array(n);
    const P = mesh.positions, T = mesh.triangles;
    for (let i = 0; i < n; i++) {
      const a = T[i * 3] * 3, b = T[i * 3 + 1] * 3, c = T[i * 3 + 2] * 3;
      const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      this.centroids[i * 3] = x; this.centroids[i * 3 + 1] = y; this.centroids[i * 3 + 2] = z;
      let r = 0;
      for (const v of [a, b, c]) r = Math.max(r, Math.hypot(P[v] - x, P[v + 1] - y, P[v + 2] - z));
      this.radii[i] = r;
    }
  }

  /** Called after every change; the viewer catches up here. */
  protected changed(): void { this.version++; }

  /** A point of triangle `f` from its corner weights, into `out`. */
  point(f: number, w: Bary, out: number[] = [0, 0, 0]): number[] {
    const P = this.mesh.positions, T = this.mesh.triangles;
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    for (let d = 0; d < 3; d++) out[d] = P[a + d] * w[0] + P[b + d] * w[1] + P[c + d] * w[2];
    return out;
  }

  /** Whether two triangles share a corner. */
  touches(f: number, g: number): boolean {
    const T = this.mesh.triangles;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (T[f * 3 + i] === T[g * 3 + j]) return true;
    return false;
  }

  get faceNormals(): Float32Array { return (this.normals ??= faceNormals(this.mesh)); }
  get faceAdjacency(): Int32Array { return (this.adjacency ??= faceAdjacency(this.mesh)); }

  /** The tree of triangle `f`, ready to change: a new one-leaf tree, or a copy of one a snapshot still holds. */
  protected editTree(f: number): PaintNode {
    let t = this.trees.get(f);
    if (!t) { t = { v: CORNERS, material: this.faceMaterial[f] }; this.trees.set(f, t); }
    else if (this.frozen.has(t)) { t = cloneTree(t); this.trees.set(f, t); }
    return t;
  }

  /** After editing a tree: merge what became one colour, and drop the tree when the whole triangle did. */
  protected settle(f: number): void {
    const t = this.trees.get(f);
    if (t) {
      if (collapse(t)) { this.faceMaterial[f] = t.material; this.trees.delete(f); }
      else this.faceMaterial[f] = majority(t);
    }
    this.dirty.add(f);
  }

  /** Colours a whole triangle. True if that changed anything. */
  protected setFace(f: number, material: number): boolean {
    if (!this.trees.has(f) && this.faceMaterial[f] === material) return false;
    this.trees.delete(f);
    this.faceMaterial[f] = material;
    this.dirty.add(f);
    return true;
  }

  /** Paints whole triangles. Returns how many changed. */
  paintFaces(faces: ArrayLike<number>, material: number): number {
    let changed = 0;
    for (let i = 0; i < faces.length; i++) if (this.setFace(faces[i], material)) changed++;
    if (changed) this.changed();
    return changed;
  }

  /**
   * Paints everything within `radius` of `p`, splitting the triangles its
   * edge crosses until the pieces are under `minEdge` (default 4 % of the
   * radius, between 0.03 and 0.4 mm). Returns how many triangles changed.
   */
  brush(p: { x: number; y: number; z: number }, radius: number, material: number, minEdge = Math.min(0.4, Math.max(0.03, radius * 0.04))): number {
    const c = this.centroids, r2 = radius * radius;
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
    const P = this.mesh.positions, T = this.mesh.triangles;
    const corner = (v: number, out: number[]) => { out[0] = P[v * 3]; out[1] = P[v * 3 + 1]; out[2] = P[v * 3 + 2]; return out; };
    const d2 = (q: number[]) => (q[0] - p.x) ** 2 + (q[1] - p.y) ** 2 + (q[2] - p.z) ** 2;
    let changed = 0;
    const visit = (f: number, n: PaintNode, depth: number): boolean => {
      this.point(f, n.v[0], A); this.point(f, n.v[1], B); this.point(f, n.v[2], C);
      if (d2(A) <= r2 && d2(B) <= r2 && d2(C) <= r2) {
        if (!n.children && n.material === material) return false;
        setLeaf(n, material);
        return true;
      }
      if (triangleDistance2(p, A, B, C) > r2) return false;
      if (!n.children && n.material === material) return false;
      const e2 = minEdge * minEdge;
      const long: [boolean, boolean, boolean] = [dist2(A, B) > e2, dist2(B, C) > e2, dist2(C, A) > e2];
      if (!(long[0] || long[1] || long[2]) || depth >= MAX_DEPTH) {
        // small enough: all of it or none, by its middle
        const m = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
        if (d2(m) > r2) return false;
        setLeaf(n, material);
        return true;
      }
      if (!n.children) splitLong(n, long);
      let any = false;
      for (const ch of n.children!) if (visit(f, ch, depth + 1)) any = true;
      return any;
    };
    for (let f = 0; f < this.count; f++) {
      const dx = c[f * 3] - p.x, dy = c[f * 3 + 1] - p.y, dz = c[f * 3 + 2] - p.z;
      const reach = radius + this.radii[f];
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      corner(T[f * 3], A); corner(T[f * 3 + 1], B); corner(T[f * 3 + 2], C);
      if (d2(A) <= r2 && d2(B) <= r2 && d2(C) <= r2) { if (this.setFace(f, material)) changed++; continue; }
      if (!this.trees.has(f) && this.faceMaterial[f] === material) continue;
      if (triangleDistance2(p, A, B, C) > r2) continue;
      if (visit(f, this.editTree(f), 0)) changed++;
      this.settle(f);
    }
    if (changed) this.changed();
    return changed;
  }

  /**
   * Paints a screen stamp onto the triangles in `candidates`: each piece
   * that lies under one label throughout (and shows on screen) takes it;
   * pieces under a change of label are split until they are about a pixel
   * across, then take the label under their middle. Returns how many
   * triangles changed.
   */
  paintLabels(img: LabelImage, view: StampView, candidates: Iterable<number>, opts: StampOptions = {}): number {
    const { labels: L, width: W, height: H } = img;
    const minPx = opts.minPx ?? 1.5, minEdge = opts.minEdge ?? 0.05;
    // summed counts of label changes between neighbouring pixels, across and down, so any box asks "one label?" in O(1)
    const SW = W + 1;
    const sh = new Int32Array(SW * (H + 1)), sv = new Int32Array(SW * (H + 1));
    let lx0 = W, ly0 = H, lx1 = -1, ly1 = -1;
    for (let y = 0; y < H; y++) {
      let rowH = 0, rowV = 0;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (L[i] >= 0) { if (x < lx0) lx0 = x; if (x > lx1) lx1 = x; if (y < ly0) ly0 = y; if (y > ly1) ly1 = y; }
        rowH += x + 1 < W && L[i] !== L[i + 1] ? 1 : 0;
        rowV += y + 1 < H && L[i] !== L[i + W] ? 1 : 0;
        sh[(y + 1) * SW + x + 1] = sh[y * SW + x + 1] + rowH;
        sv[(y + 1) * SW + x + 1] = sv[y * SW + x + 1] + rowV;
      }
    }
    if (lx1 < 0) return 0;
    const sum = (s: Int32Array, x0: number, y0: number, x1: number, y1: number) => s[(y1 + 1) * SW + x1 + 1] - s[y0 * SW + x1 + 1] - s[(y1 + 1) * SW + x0] + s[y0 * SW + x0];
    /** the one label over a pixel box (inclusive, on the image), or null when it changes inside */
    const uniform = (x0: number, y0: number, x1: number, y1: number): number | null => {
      if (x1 > x0 && sum(sh, x0, y0, x1 - 1, y1) > 0) return null;
      if (y1 > y0 && sum(sv, x0, y0, x1, y1 - 1) > 0) return null;
      return L[y0 * W + x0];
    };
    const clampX = (v: number) => Math.max(0, Math.min(W - 1, Math.floor(v)));
    const clampY = (v: number) => Math.max(0, Math.min(H - 1, Math.floor(v)));
    const onImage = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
    const visit = (f: number, n: PaintNode, depth: number): boolean => {
      this.point(f, n.v[0], A); this.point(f, n.v[1], B); this.point(f, n.v[2], C);
      const a = view.project(A[0], A[1], A[2]), b = view.project(B[0], B[1], B[2]), c = view.project(C[0], C[1], C[2]);
      const minx = Math.min(a[0], b[0], c[0]), maxx = Math.max(a[0], b[0], c[0]);
      const miny = Math.min(a[1], b[1], c[1]), maxy = Math.max(a[1], b[1], c[1]);
      if (maxx < lx0 || minx >= lx1 + 1 || maxy < ly0 || miny >= ly1 + 1) return false; // nowhere near the stamp
      const u = uniform(clampX(minx), clampY(miny), clampX(maxx), clampY(maxy));
      if (u !== null && u < 0) return false;
      const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
      const inView = minx >= 0 && miny >= 0 && maxx < W && maxy < H;
      let seen = 0;
      for (const [x, y] of [a, b, c, [cx, cy]]) if (onImage(x, y) && view.visible(f, x, y)) seen++;
      if (u !== null && seen === 4 && inView) {
        if (!n.children && n.material === u) return false;
        setLeaf(n, u);
        return true;
      }
      // a side is worth splitting while it spans more than a pixel or so and more than the finest the print shows
      const pxLong = (p: number[], q: number[]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 > minPx * minPx;
      const long: [boolean, boolean, boolean] = [pxLong(a, b) && dist2(A, B) > minEdge * minEdge, pxLong(b, c) && dist2(B, C) > minEdge * minEdge, pxLong(c, a) && dist2(C, A) > minEdge * minEdge];
      const px = Math.sqrt(Math.max((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2, (b[0] - c[0]) ** 2 + (b[1] - c[1]) ** 2, (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2));
      if (!(long[0] || long[1] || long[2]) || depth >= MAX_DEPTH) {
        // as small as it gets: the label under its middle, if it shows there
        if (!onImage(cx, cy) || !view.visible(f, cx, cy)) return false;
        const label = L[Math.floor(cy) * W + Math.floor(cx)];
        if (label < 0 || (!n.children && n.material === label)) return false;
        setLeaf(n, label);
        return true;
      }
      if (seen === 0 && px < 6) return false; // hidden behind something
      if (!n.children) splitLong(n, long);
      let any = false;
      for (const ch of n.children!) if (visit(f, ch, depth + 1)) any = true;
      return any;
    };
    let changed = 0;
    for (const f of candidates) {
      if (visit(f, this.editTree(f), 0)) changed++;
      this.settle(f);
    }
    if (changed) this.changed();
    return changed;
  }

  /**
   * Bucket fill from leaf `leaf` of triangle `face` (−1: the whole
   * triangle): the connected region of its colour, not across creases
   * sharper than `maxAngleDeg`. Returns how many triangles changed.
   */
  bucket(face: number, leaf: number, material: number, maxAngleDeg: number): number {
    if (!this.trees.size) return this.paintFaces(floodRegion(this.faceAdjacency, this.faceNormals, this.faceMaterial, face, maxAngleDeg), material);
    const b = this.bakedWithAdjacency();
    let seed = -1;
    for (let i = 0; i < b.baked.source.length; i++) if (b.baked.source[i] === face && (leaf < 0 || b.baked.leafIndex[i] === leaf)) { seed = i; break; }
    if (seed < 0) return 0;
    const region = floodRegion(b.adjacency!, b.normals!, b.baked.faceMaterial, seed, maxAngleDeg);
    const whole = new Set<number>(), parts = new Map<number, Set<number>>();
    for (const i of region) {
      const f = b.baked.source[i], k = b.baked.leafIndex[i];
      if (k < 0) whole.add(f);
      else { let s = parts.get(f); if (!s) parts.set(f, (s = new Set())); s.add(k); }
    }
    let changed = 0;
    for (const f of whole) if (this.setFace(f, material)) changed++;
    for (const [f, ks] of parts) {
      const t = this.editTree(f);
      let k = 0, any = false;
      forEachLeaf(t, (l) => { if (ks.has(k++) && l.material !== material) { l.material = material; any = true; } });
      if (any) changed++;
      this.settle(f);
    }
    if (changed) this.changed();
    return changed;
  }

  /** Every triangle one colour. */
  fillAll(material: number): void {
    this.trees.clear();
    this.faceMaterial.fill(material);
    this.all = true;
    this.changed();
  }

  /** Sets every triangle's colour (no trees), e.g. from a fit's material runs. */
  setFaces(faceMaterial: Uint8Array): void {
    this.trees.clear();
    this.faceMaterial.set(faceMaterial);
    this.all = true;
    this.changed();
  }

  snapshot(): void {
    for (const t of this.trees.values()) this.frozen.add(t);
    this.history.push({ faceMaterial: Uint8Array.from(this.faceMaterial), trees: new Map(this.trees) });
    if (this.history.length > 50) this.history.shift();
  }

  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.faceMaterial.set(prev.faceMaterial);
    this.trees = prev.trees;
    this.all = true;
    this.changed();
    return true;
  }

  get painted(): boolean { return this.trees.size > 0 || this.faceMaterial.some((m) => m !== 0); }

  /** Triangles with any paint on them. */
  get paintedFaces(): number {
    let n = 0;
    for (let f = 0; f < this.count; f++) if (this.faceMaterial[f] !== 0 || this.trees.has(f)) n++;
    return n;
  }

  /** Every palette index that shows somewhere. */
  materialsUsed(): Set<number> {
    const used = new Set<number>();
    for (let f = 0; f < this.count; f++) if (!this.trees.has(f)) used.add(this.faceMaterial[f]);
    for (const t of this.trees.values()) forEachLeaf(t, (l) => used.add(l.material));
    return used;
  }

  /** The paint as whole triangles (leaves made real, T-junctions closed); the mesh itself when nothing is split. */
  baked(): BakedPaint { return this.bakedWithAdjacency(false).baked; }

  private bakedWithAdjacency(adjacency = true) {
    if (this.bakedCache?.version !== this.version) {
      const baked: BakedPaint = this.trees.size
        ? bakePaint(this.mesh, this.faceMaterial, this.trees)
        : { mesh: this.mesh, faceMaterial: Uint8Array.from(this.faceMaterial), source: Uint32Array.from({ length: this.count }, (_, i) => i), leafIndex: new Int32Array(this.count).fill(-1) };
      this.bakedCache = { version: this.version, baked };
    }
    if (adjacency && !this.bakedCache.adjacency) {
      this.bakedCache.adjacency = faceAdjacency(this.bakedCache.baked.mesh);
      this.bakedCache.normals = faceNormals(this.bakedCache.baked.mesh);
    }
    return this.bakedCache;
  }

  /**
   * The slicer paint code of every triangle ('' for unpainted), as Bambu
   * Studio writes `paint_color` and PrusaSlicer `slic3rpe:mmu_segmentation`.
   * `stateOf` maps a palette index to the slicer's state (0 = the object's
   * own filament, n = filament n).
   */
  paintCodes(stateOf: (material: number) => number): string[] {
    const whole = new Map<number, string>();
    const out: string[] = new Array(this.count);
    for (let f = 0; f < this.count; f++) {
      const t = this.trees.get(f);
      if (t) { out[f] = encodePaint(t, stateOf); continue; }
      const m = this.faceMaterial[f];
      if (!stateOf(m)) { out[f] = ''; continue; }
      let code = whole.get(m);
      if (code === undefined) whole.set(m, (code = encodePaint({ v: CORNERS, material: m }, stateOf)));
      out[f] = code;
    }
    return out;
  }

  /** Takes the paint of another part by nearest point (after a refit or a refine of a different mesh). */
  carryFrom(previous: PaintModel): void {
    const b = previous.baked();
    const P = b.mesh.positions, T = b.mesh.triangles, m = T.length / 3;
    const pts = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) for (let d = 0; d < 3; d++) pts[i * 3 + d] = (P[T[i * 3] * 3 + d] + P[T[i * 3 + 1] * 3 + d] + P[T[i * 3 + 2] * 3 + d]) / 3;
    const nearest = nearestPoints(pts);
    this.trees.clear();
    const c = this.centroids;
    for (let f = 0; f < this.count; f++) this.faceMaterial[f] = b.faceMaterial[nearest(c[f * 3], c[f * 3 + 1], c[f * 3 + 2])];
    this.all = true;
    this.changed();
  }
}

const dist2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Squared distance from `p` to the triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
export function triangleDistance2(p: { x: number; y: number; z: number }, a: number[], b: number[], c: number[]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p.x - a[0], p.y - a[1], p.z - a[2]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const at = (s: number, t: number) => { const q = [a[0] + ab[0] * s + ac[0] * t, a[1] + ab[1] * s + ac[1] * t, a[2] + ab[2] * s + ac[2] * t]; return (q[0] - p.x) ** 2 + (q[1] - p.y) ** 2 + (q[2] - p.z) ** 2; };
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bp = [p.x - b[0], p.y - b[1], p.z - b[2]];
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp = [p.x - c[0], p.y - c[1], p.z - c[2]];
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return at(1 - w, w); }
  const denom = 1 / (va + vb + vc);
  return at(vb * denom, vc * denom);
}

/** Nearest-point lookup over packed xyz points, on a uniform grid. */
export function nearestPoints(pts: Float32Array): (x: number, y: number, z: number) => number {
  const n = pts.length / 3;
  if (!n) return () => 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i++) { const d = i % 3; lo[d] = Math.min(lo[d], pts[i]); hi[d] = Math.max(hi[d], pts[i]); }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
  const cells = Math.max(1, Math.min(128, Math.round(Math.cbrt(n / 2))));
  const size = span / cells;
  const dims = [0, 1, 2].map((d) => Math.max(1, Math.ceil((hi[d] - lo[d]) / size) + 1));
  const cellOf = (v: number, d: number) => Math.max(0, Math.min(dims[d] - 1, Math.floor((v - lo[d]) / size)));
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number, k: number) => (i * dims[1] + j) * dims[2] + k;
  for (let p = 0; p < n; p++) {
    const k = key(cellOf(pts[p * 3], 0), cellOf(pts[p * 3 + 1], 1), cellOf(pts[p * 3 + 2], 2));
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(p);
  }
  return (x, y, z) => {
    const ci = cellOf(x, 0), cj = cellOf(y, 1), ck = cellOf(z, 2);
    let best = 0, bestD = Infinity;
    for (let r = 0; r <= Math.max(...dims); r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) for (let k = ck - r; k <= ck + r; k++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue; // the shell of this ring only
        if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) continue;
        const list = grid.get(key(i, j, k));
        if (!list) continue;
        for (const p of list) {
          const d = (pts[p * 3] - x) ** 2 + (pts[p * 3 + 1] - y) ** 2 + (pts[p * 3 + 2] - z) ** 2;
          if (d < bestD) { bestD = d; best = p; }
        }
      }
      // every point in a later ring is at least r cells away
      if (bestD < Infinity && Math.sqrt(bestD) <= r * size) break;
    }
    return best;
  };
}

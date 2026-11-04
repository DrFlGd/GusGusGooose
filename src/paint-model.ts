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

  /** Puts back saved paint on the same mesh: every triangle's colour and the trees of those painted in part. */
  restore(faceMaterial: Uint8Array, trees: Map<number, PaintNode>): void {
    if (faceMaterial.length !== this.count) throw new Error(`saved paint has ${faceMaterial.length} faces, the part ${this.count}`);
    this.faceMaterial.set(faceMaterial);
    this.trees = new Map([...trees].filter(([f]) => f >= 0 && f < this.count));
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

  /** Takes the paint of another part where it lies in the same place (a refit without a move, a different mesh). */
  carryFrom(previous: PaintModel): void { this.transferFrom(previous, (p) => p); }

  /**
   * Takes another part's paint: `toPrevious` maps a point of this part to
   * where it was on that one (the same accessory fitted again after a move,
   * say; it must be a move, so lengths and flat faces stay as they are).
   * Each face takes the colour of the old surface under it, and is split
   * where that changes, down to `minEdge` mm, so paint inside faces carries
   * over as such. Only old faces facing the same way count, so the far side
   * of a thin wall or the next face round a corner does not bleed in; a face
   * with nothing under it (where the goose carves the part differently now)
   * takes the colour nearest to it.
   */
  transferFrom(previous: PaintModel, toPrevious: (p: number[]) => number[], minEdge = 0.06): void {
    const b = previous.baked();
    const grid = new TriangleGrid(b.mesh);
    const labels = b.faceMaterial;
    const edges = new ColourEdges(b.mesh, labels);
    const tol = 0.01; // the old surface lies within this of the new one where they are the same surface
    const e2 = minEdge * minEdge;
    // colour edges near the piece, as a stack: a piece's list follows its parent's, its children's lists follow it
    let buf = new Int32Array(1 << 12);
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
    // this face's corners where they were, and its plane there
    let fa = A, fb = B, fc = C, nx = 0, ny = 0, nz = 0, flat = false;
    const facing = (t: number) => grid.facing(t, nx, ny, nz) > 0.3;
    const at = (w: Bary, out: number[]) => { for (let d = 0; d < 3; d++) out[d] = w[0] * fa[d] + w[1] * fb[d] + w[2] * fc[d]; };
    const a = [0, 0, 0], bb = [0, 0, 0], c = [0, 0, 0];
    const recent = [-1, -1, -1, -1];
    let slot = 0;
    /**
     * The colour of the old surface at a place: of the old triangle (facing this face's way) nearest it. Unless `exact`,
     * any within `tol` will do: for a piece no colour edge comes near, all of those are its colour.
     */
    const colourAt = (x: number, y: number, z: number, exact = false): number => {
      // pieces come in order, so the triangle under the last few is often under this one too
      if (!exact) for (const t of recent) if (t >= 0 && grid.distance2(t, x, y, z) <= tol * tol && (!flat || facing(t))) return labels[t];
      const [t, d] = grid.nearest(x, y, z, flat ? facing : undefined, 0.5, exact ? 1e-5 : tol); // a place on a triangle has none nearer
      if (d <= tol * tol) { recent[slot] = t; slot = (slot + 1) & 3; }
      return labels[d < Infinity ? t : grid.nearest(x, y, z)[0]];
    };
    // a piece of the face, with the colour edges that could cross it (buf[from..to], those near its parent): it is one
    // colour when none comes within `tol` of it, else split along them
    const visit = (n: PaintNode, from: number, to: number, depth: number) => {
      at(n.v[0], a); at(n.v[1], bb); at(n.v[2], c);
      const mx = (a[0] + bb[0] + c[0]) / 3, my = (a[1] + bb[1] + c[1]) / 3, mz = (a[2] + bb[2] + c[2]) / 3;
      const reach = Math.sqrt(Math.max((a[0] - mx) ** 2 + (a[1] - my) ** 2 + (a[2] - mz) ** 2, (bb[0] - mx) ** 2 + (bb[1] - my) ** 2 + (bb[2] - mz) ** 2, (c[0] - mx) ** 2 + (c[1] - my) ** 2 + (c[2] - mz) ** 2)) + tol;
      if (buf.length < to + (to - from)) { const grown = new Int32Array(Math.max(buf.length * 2, to + (to - from))); grown.set(buf.subarray(0, to)); buf = grown; }
      let top = to;
      const cen = edges.centre, half = edges.half;
      for (let i = from; i < to; i++) {
        const e = buf[i];
        // loose tests, cheap first, together tight: within reach of the piece's middle, near its plane, and near the piece
        const qx = cen[e * 3], qy = cen[e * 3 + 1], qz = cen[e * 3 + 2], r = half[e] + tol;
        const dx = qx - mx, dy = qy - my, dz = qz - mz;
        if (dx * dx + dy * dy + dz * dz > (reach + half[e]) ** 2) continue;
        if (flat && Math.abs(nx * dx + ny * dy + nz * dz) > r) continue;
        if (pointTriangle2(qx, qy, qz, a[0], a[1], a[2], bb[0], bb[1], bb[2], c[0], c[1], c[2]) > r * r) continue;
        if (half[e] > tol && edges.distance2(e, mx, my, mz) > reach * reach) continue;
        buf[top++] = e;
      }
      if (top === to) { n.material = colourAt(mx, my, mz); return; } // one colour
      const long: [boolean, boolean, boolean] = [dist2(a, bb) > e2, dist2(bb, c) > e2, dist2(c, a) > e2];
      if ((long[0] || long[1] || long[2]) && depth < MAX_DEPTH) {
        splitLong(n, long);
        for (const ch of n.children!) visit(ch, to, top, depth + 1);
        return;
      }
      n.material = colourAt(mx, my, mz, true); // too small to split further: what is under its middle
    };
    const lo = [0, 0, 0], hi = [0, 0, 0];
    this.trees.clear();
    for (let f = 0; f < this.count; f++) {
      const t: PaintNode = { v: CORNERS, material: 0 };
      this.point(f, CORNERS[0], A); this.point(f, CORNERS[1], B); this.point(f, CORNERS[2], C);
      fa = toPrevious(A); fb = toPrevious(B); fc = toPrevious(C);
      nx = (fb[1] - fa[1]) * (fc[2] - fa[2]) - (fb[2] - fa[2]) * (fc[1] - fa[1]);
      ny = (fb[2] - fa[2]) * (fc[0] - fa[0]) - (fb[0] - fa[0]) * (fc[2] - fa[2]);
      nz = (fb[0] - fa[0]) * (fc[1] - fa[1]) - (fb[1] - fa[1]) * (fc[0] - fa[0]);
      const len = Math.hypot(nx, ny, nz);
      flat = len > 1e-12;
      if (flat) { nx /= len; ny /= len; nz /= len; }
      // the colour edges near this face between old faces facing its way (a corner between two colours is not an edge here)
      for (let d = 0; d < 3; d++) { lo[d] = Math.min(fa[d], fb[d], fc[d]) - tol; hi[d] = Math.max(fa[d], fb[d], fc[d]) + tol; }
      const near = edges.inBox(lo, hi, flat ? (e) => facing(edges.tri[e * 2]) && facing(edges.tri[e * 2 + 1]) : undefined);
      if (!near.length) { this.faceMaterial[f] = colourAt((fa[0] + fb[0] + fc[0]) / 3, (fa[1] + fb[1] + fc[1]) / 3, (fa[2] + fb[2] + fc[2]) / 3); continue; } // no colour edge on it
      if (buf.length < near.length * 2) buf = new Int32Array(near.length * 4);
      buf.set(near);
      visit(t, 0, near.length, 0);
      if (collapse(t)) this.faceMaterial[f] = t.material;
      else { this.trees.set(f, t); this.faceMaterial[f] = majority(t); }
    }
    this.all = true;
    this.changed();
  }
}

/**
 * The colour edges of a painted mesh: the sides between two triangles of
 * different colours, each with its two triangles, on a uniform grid.
 */
export class ColourEdges {
  readonly ends: Float32Array;
  readonly tri: Int32Array;
  readonly centre: Float32Array;
  readonly half: Float32Array;
  readonly count: number;
  private lo = [0, 0, 0];
  private size = 1;
  private dims = [1, 1, 1];
  private cells = new Map<number, number[]>();
  private seen: Uint32Array;
  private tick = 0;

  constructor(mesh: IndexedMesh, labels: ArrayLike<number>) {
    const P = mesh.positions, T = mesh.triangles, nv = P.length / 3;
    const open = new Map<number, number>(); // a side seen once: (from, to) → its triangle
    const found: number[] = [];
    for (let t = 0; t < T.length / 3; t++) for (let k = 0; k < 3; k++) {
      const i = T[t * 3 + k], j = T[t * 3 + ((k + 1) % 3)];
      const back = open.get(j * nv + i);
      if (back === undefined) { open.set(i * nv + j, t); continue; }
      open.delete(j * nv + i);
      if (labels[back] !== labels[t]) found.push(i, j, back, t);
    }
    const n = (this.count = found.length / 4);
    this.ends = new Float32Array(n * 6); this.tri = new Int32Array(n * 2); this.centre = new Float32Array(n * 3); this.half = new Float32Array(n);
    this.seen = new Uint32Array(n);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let e = 0; e < n; e++) {
      const i = found[e * 4], j = found[e * 4 + 1];
      for (let d = 0; d < 3; d++) {
        const p = P[i * 3 + d], q = P[j * 3 + d];
        this.ends[e * 6 + d] = p; this.ends[e * 6 + 3 + d] = q; this.centre[e * 3 + d] = (p + q) / 2;
        lo[d] = Math.min(lo[d], p, q); hi[d] = Math.max(hi[d], p, q);
      }
      this.half[e] = Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]) / 2;
      this.tri[e * 2] = found[e * 4 + 2]; this.tri[e * 2 + 1] = found[e * 4 + 3];
    }
    if (!n) return;
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    this.lo = lo;
    this.size = span / Math.max(1, Math.min(128, Math.round(Math.sqrt(n) / 2)));
    this.dims = [0, 1, 2].map((d) => Math.max(1, Math.ceil((hi[d] - lo[d]) / this.size) + 1));
    for (let e = 0; e < n; e++) {
      const r0 = [0, 1, 2].map((d) => this.cell(Math.min(this.ends[e * 6 + d], this.ends[e * 6 + 3 + d]), d));
      const r1 = [0, 1, 2].map((d) => this.cell(Math.max(this.ends[e * 6 + d], this.ends[e * 6 + 3 + d]), d));
      for (let i = r0[0]; i <= r1[0]; i++) for (let j = r0[1]; j <= r1[1]; j++) for (let k = r0[2]; k <= r1[2]; k++) {
        const key = this.key(i, j, k);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(e);
      }
    }
  }

  private cell(v: number, d: number) { return Math.max(0, Math.min(this.dims[d] - 1, Math.floor((v - this.lo[d]) / this.size))); }
  private key(i: number, j: number, k: number) { return (i * this.dims[1] + j) * this.dims[2] + k; }

  /** The edges (that `accept` takes) listed in the cells a box overlaps. */
  inBox(lo: number[], hi: number[], accept?: (e: number) => boolean): number[] {
    const out: number[] = [];
    if (!this.count) return out;
    if (++this.tick === 0xffffffff) { this.seen.fill(0); this.tick = 1; }
    const stamp = this.tick, seen = this.seen;
    const i0 = this.cell(lo[0], 0), i1 = this.cell(hi[0], 0), j0 = this.cell(lo[1], 1), j1 = this.cell(hi[1], 1), k0 = this.cell(lo[2], 2), k1 = this.cell(hi[2], 2);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const list = this.cells.get(this.key(i, j, k));
      if (!list) continue;
      for (const e of list) {
        if (seen[e] === stamp) continue;
        seen[e] = stamp;
        if (!accept || accept(e)) out.push(e);
      }
    }
    return out;
  }

  /** Squared distance from a place to edge `e`. */
  distance2(e: number, x: number, y: number, z: number): number {
    const E = this.ends, o = e * 6;
    const dx = E[o + 3] - E[o], dy = E[o + 4] - E[o + 1], dz = E[o + 5] - E[o + 2];
    const l2 = dx * dx + dy * dy + dz * dz;
    let u = l2 > 0 ? ((x - E[o]) * dx + (y - E[o + 1]) * dy + (z - E[o + 2]) * dz) / l2 : 0;
    u = Math.max(0, Math.min(1, u));
    return (E[o] + dx * u - x) ** 2 + (E[o + 1] + dy * u - y) ** 2 + (E[o + 2] + dz * u - z) ** 2;
  }
}

const dist2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Squared distance from `p` to the triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
export function triangleDistance2(p: { x: number; y: number; z: number }, a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>): number {
  return pointTriangle2(p.x, p.y, p.z, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

/** triangleDistance2 on plain numbers (no arrays or closures, for the hot loops). */
function pointTriangle2(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let s = 0, t = 0;
  if (d1 <= 0 && d2 <= 0) { s = 0; t = 0; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { s = 1; t = 0; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { s = d1 / (d1 - d3); t = 0; }
    else if (d6 >= 0 && d5 <= d6) { s = 0; t = 1; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { s = 0; t = d2 / (d2 - d6); }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); s = 1 - w; t = w; }
    else { const denom = 1 / (va + vb + vc); s = vb * denom; t = vc * denom; }
  }
  const qx = ax + abx * s + acx * t - px, qy = ay + aby * s + acy * t - py, qz = az + abz * s + acz * t - pz;
  return qx * qx + qy * qy + qz * qz;
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

/**
 * A mesh's triangles on a uniform grid (each listed in every cell its plane
 * passes through), for the nearest one to a place.
 */
export class TriangleGrid {
  private P: Float32Array;
  private T: Uint32Array;
  private normals: Float32Array;
  private lo = [0, 0, 0];
  private size = 1;
  private dims = [1, 1, 1];
  private cells = new Map<number, number[]>();
  private seen: Uint32Array;
  private tick = 0;

  constructor(mesh: IndexedMesh) {
    const P = (this.P = mesh.positions), T = (this.T = mesh.triangles as Uint32Array), m = T.length / 3;
    this.normals = faceNormals(mesh);
    this.seen = new Uint32Array(m);
    if (!m) return;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < T.length; i++) for (let d = 0; d < 3; d++) { const v = P[T[i] * 3 + d]; if (v < lo[d]) lo[d] = v; if (v > hi[d]) hi[d] = v; }
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    // a surface, so about as many cells across as the square root of its triangles: a few triangles per cell where it is dense
    const cells = Math.max(1, Math.min(160, Math.round(Math.sqrt(m) / 2)));
    this.lo = lo;
    this.size = span / cells;
    const size = this.size, half = size * 0.87; // a cell the plane crosses has its middle this close to it
    this.dims = [0, 1, 2].map((d) => Math.max(1, Math.ceil((hi[d] - lo[d]) / size) + 1));
    const n = this.normals;
    for (let t = 0; t < m; t++) {
      const i0 = T[t * 3] * 3, i1 = T[t * 3 + 1] * 3, i2 = T[t * 3 + 2] * 3;
      const r0 = [0, 1, 2].map((d) => this.cell(Math.min(P[i0 + d], P[i1 + d], P[i2 + d]), d));
      const r1 = [0, 1, 2].map((d) => this.cell(Math.max(P[i0 + d], P[i1 + d], P[i2 + d]), d));
      const wide = (r1[0] - r0[0] + 1) * (r1[1] - r0[1] + 1) * (r1[2] - r0[2] + 1) > 8;
      for (let i = r0[0]; i <= r1[0]; i++) for (let j = r0[1]; j <= r1[1]; j++) for (let k = r0[2]; k <= r1[2]; k++) {
        if (wide) {
          const cx = lo[0] + (i + 0.5) * size - P[i0], cy = lo[1] + (j + 0.5) * size - P[i0 + 1], cz = lo[2] + (k + 0.5) * size - P[i0 + 2];
          if (Math.abs(cx * n[t * 3] + cy * n[t * 3 + 1] + cz * n[t * 3 + 2]) > half) continue;
        }
        const key = this.key(i, j, k);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(t);
      }
    }
  }

  private cell(v: number, d: number) { return Math.max(0, Math.min(this.dims[d] - 1, Math.floor((v - this.lo[d]) / this.size))); }
  private key(i: number, j: number, k: number) { return (i * this.dims[1] + j) * this.dims[2] + k; }

  /** How far triangle `t` faces along the unit direction (x, y, z): the cosine between them. */
  facing(t: number, x: number, y: number, z: number): number {
    const n = this.normals;
    return n[t * 3] * x + n[t * 3 + 1] * y + n[t * 3 + 2] * z;
  }

  /** Squared distance from (x, y, z) to triangle `t`. */
  distance2(t: number, x: number, y: number, z: number): number {
    const P = this.P, T = this.T, i = T[t * 3] * 3, j = T[t * 3 + 1] * 3, k = T[t * 3 + 2] * 3;
    return pointTriangle2(x, y, z, P[i], P[i + 1], P[i + 2], P[j], P[j + 1], P[j + 2], P[k], P[k + 1], P[k + 2]);
  }

  private next(): number {
    if (++this.tick === 0xffffffff) { this.seen.fill(0); this.tick = 1; }
    return this.tick;
  }

  /**
   * The nearest triangle (that `accept` takes, within `within` mm) and its
   * squared distance; [0, Infinity] when there is none. One within `enough`
   * mm will do, which saves looking further when the place lies on one.
   */
  nearest(x: number, y: number, z: number, accept?: (t: number) => boolean, within = Infinity, enough = 0): [number, number] {
    const dims = this.dims, stamp = this.next(), seen = this.seen;
    const ci = this.cell(x, 0), cj = this.cell(y, 1), ck = this.cell(z, 2);
    let best = 0, bestD = Infinity;
    const most = Math.max(...dims);
    for (let r = 0; r <= most; r++) {
      // the shell of this ring only: all of k on its two x and two y faces, the two ends of k inside them
      for (let i = Math.max(0, ci - r); i <= Math.min(dims[0] - 1, ci + r); i++) for (let j = Math.max(0, cj - r); j <= Math.min(dims[1] - 1, cj + r); j++) {
        const side = Math.abs(i - ci) === r || Math.abs(j - cj) === r;
        const step = side || r === 0 ? 1 : 2 * r;
        for (let k = ck - r; k <= ck + r; k += step) {
          if (k < 0 || k >= dims[2]) continue;
          const list = this.cells.get(this.key(i, j, k));
          if (!list) continue;
          for (const t of list) {
            if (seen[t] === stamp) continue;
            seen[t] = stamp;
            if (accept && !accept(t)) continue;
            const d = this.distance2(t, x, y, z);
            if (d < bestD) { bestD = d; best = t; }
          }
        }
      }
      // every triangle in a later ring is at least r cells away
      if (bestD < Infinity && (Math.sqrt(bestD) <= r * this.size || bestD <= enough * enough)) break;
      if (r * this.size > within) break;
    }
    return bestD <= within * within ? [best, bestD] : [0, Infinity];
  }
}

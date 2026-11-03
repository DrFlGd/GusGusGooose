// Paint inside triangles, the way Bambu Studio, OrcaSlicer and PrusaSlicer
// keep it: a painted triangle of the mesh carries a tree that splits it at
// edge midpoints (into two, three or four) as far down as the paint needs,
// with a colour on every leaf. The mesh itself never changes, so a coarse
// model takes fine paint, and the tree is exactly what the slicer stores per
// triangle as `paint_color` (Bambu, Orca) or `slic3rpe:mmu_segmentation`
// (PrusaSlicer). `bakePaint` turns the leaves into real triangles when a step
// needs them (a boolean, a split by colour, an edge-adjacency fill), closing
// every T-junction so the result is still a closed solid. Pure: shared by the
// app and the CLI.

import type { IndexedMesh } from './stl.ts';

/** A point of a mesh triangle as weights of its three corners (summing to 1). Midpoints keep them exact (dyadic). */
export type Bary = [number, number, number];

export interface PaintNode {
  /** the triangle's corners, in the order the slicer splits it */
  v: [Bary, Bary, Bary];
  /** a leaf's colour (an index into the palette); on a split node, unused */
  material: number;
  /** a split node: how many sides were split (1 to 3), the special side (0 to 2), and the children */
  sides?: number;
  special?: number;
  children?: PaintNode[];
}

export const CORNERS: [Bary, Bary, Bary] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

const mid = (a: Bary, b: Bary): Bary => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/**
 * Splits a leaf as the slicer's TriangleSelector does. The corners are taken
 * from the special one round: one side split cuts from that corner to the
 * middle of the opposite side; two sides split keep the side opposite it
 * whole; three sides split (special side 0) make four, the middle one last.
 * Every child keeps the parent's winding, and starts with the parent's colour.
 */
export function splitNode(n: PaintNode, sides = 3, special = 0): void {
  const s = sides === 3 ? 0 : special % 3;
  const a = n.v[s], b = n.v[(s + 1) % 3], c = n.v[(s + 2) % 3];
  const m = n.material;
  const leaf = (p: Bary, q: Bary, r: Bary): PaintNode => ({ v: [p, q, r], material: m });
  if (sides === 1) {
    const bc = mid(b, c);
    n.children = [leaf(a, b, bc), leaf(bc, c, a)];
  } else if (sides === 2) {
    const ab = mid(a, b), ca = mid(c, a);
    n.children = [leaf(a, ab, ca), leaf(ab, b, ca), leaf(b, c, ca)];
  } else {
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    n.children = [leaf(a, ab, ca), leaf(ab, b, bc), leaf(bc, c, ca), leaf(ab, bc, ca)];
  }
  n.sides = sides === 1 || sides === 2 ? sides : 3;
  n.special = s;
}

/**
 * Splits a leaf only across its long sides, as the slicers do: `long[k]` says
 * whether side k (corner k to corner k + 1) is too long. One long side is cut
 * from the corner opposite it; two keep the third whole; three (or none, when
 * the leaf must split anyway) make four. A thin sliver so halves only its
 * long sides instead of shrinking into ever thinner slivers.
 */
export function splitLong(n: PaintNode, long: [boolean, boolean, boolean]): void {
  const count = (long[0] ? 1 : 0) + (long[1] ? 1 : 0) + (long[2] ? 1 : 0);
  if (count === 1) splitNode(n, 1, (long.indexOf(true) + 2) % 3);
  else if (count === 2) splitNode(n, 2, (long.indexOf(false) + 2) % 3);
  else splitNode(n, 3);
}

/** Makes a node a leaf of one colour again. */
export function setLeaf(n: PaintNode, material: number): void {
  n.material = material;
  delete n.children; delete n.sides; delete n.special;
}

/** Merges children that all ended up one colour, bottom up. True when `n` is (now) a leaf. */
export function collapse(n: PaintNode): boolean {
  if (!n.children) return true;
  let leaves = true;
  for (const c of n.children) if (!collapse(c)) leaves = false;
  if (leaves && n.children.every((c) => c.material === n.children![0].material)) { setLeaf(n, n.children[0].material); return true; }
  return false;
}

export function forEachLeaf(n: PaintNode, fn: (leaf: PaintNode) => void): void {
  if (!n.children) { fn(n); return; }
  for (const c of n.children) forEachLeaf(c, fn);
}

/** A leaf's share of its mesh triangle's area. */
export function areaShare(n: PaintNode): number {
  const [a, b, c] = n.v;
  return Math.abs((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]));
}

/** The colour covering most of a tree's area. */
export function majority(n: PaintNode): number {
  const area = new Map<number, number>();
  forEachLeaf(n, (l) => area.set(l.material, (area.get(l.material) ?? 0) + areaShare(l)));
  let best = n.material, most = -1;
  for (const [m, a] of area) if (a > most) { best = m; most = a; }
  return best;
}

export function cloneTree(n: PaintNode): PaintNode {
  const c: PaintNode = { v: n.v, material: n.material }; // corners are never mutated, so they can be shared
  if (n.children) { c.sides = n.sides; c.special = n.special; c.children = n.children.map(cloneTree); }
  return c;
}

/**
 * Reads a slicer paint code into a tree. The hex digits run last nibble
 * first; each nibble's bits run least significant first. Per node: 2 bits of
 * split sides; a leaf then has a 2-bit state (3 means 4 more bits follow,
 * holding state − 3), a split node a 2-bit special side and then its
 * children, last child first. `materialOf` maps a state (0 = unpainted, else
 * the filament number) to a palette index.
 */
export function decodePaint(code: string, materialOf: (state: number) => number = (s) => s): PaintNode | null {
  if (!code) return null;
  const bits: number[] = [];
  for (let i = code.length - 1; i >= 0; i--) {
    const d = parseInt(code[i], 16);
    if (Number.isNaN(d)) return null;
    bits.push(d & 1, (d >> 1) & 1, (d >> 2) & 1, (d >> 3) & 1);
  }
  let pos = 0;
  const read = (k: number) => { let v = 0; for (let i = 0; i < k; i++) v |= (bits[pos++] ?? 0) << i; return v; };
  const walk = (n: PaintNode, depth: number): void => {
    const sides = read(2);
    if (sides === 0 || depth > 30) {
      let state = read(2);
      if (state === 3) state = 3 + read(4);
      n.material = materialOf(state);
      return;
    }
    const special = read(2);
    splitNode(n, sides, special);
    for (let i = n.children!.length - 1; i >= 0; i--) walk(n.children![i], depth + 1);
  };
  const root: PaintNode = { v: CORNERS, material: 0 };
  walk(root, 0);
  return root;
}

/** Writes a tree as a slicer paint code (see `decodePaint`). `stateOf` maps a palette index to a state. */
export function encodePaint(n: PaintNode, stateOf: (material: number) => number = (m) => m): string {
  const bits: number[] = [];
  const put = (v: number, k: number) => { for (let i = 0; i < k; i++) bits.push((v >> i) & 1); };
  const walk = (n: PaintNode) => {
    if (!n.children) {
      const state = Math.max(0, Math.min(18, stateOf(n.material)));
      put(0, 2);
      if (state < 3) put(state, 2); else { put(3, 2); put(state - 3, 4); }
      return;
    }
    put(n.sides ?? 3, 2);
    put(n.special ?? 0, 2);
    for (let i = n.children.length - 1; i >= 0; i--) walk(n.children[i]);
  };
  walk(n);
  let out = '';
  for (let i = 0; i < bits.length; i += 4) out = (bits[i] | (bits[i + 1] << 1) | (bits[i + 2] << 2) | (bits[i + 3] << 3)).toString(16).toUpperCase() + out;
  return out;
}

/** True when a paint code splits its triangle (rather than colouring all of it). */
export function codeSplits(code: string): boolean {
  if (!code) return false;
  const d = parseInt(code[code.length - 1], 16);
  return !Number.isNaN(d) && (d & 3) !== 0;
}

export interface BakedPaint {
  /** the mesh with every leaf as real triangles (more where a T-junction had to be closed) */
  mesh: IndexedMesh;
  faceMaterial: Uint8Array;
  /** the mesh triangle each baked triangle lies in */
  source: Uint32Array;
  /** which leaf of that triangle's tree it came from, counted in `forEachLeaf` order (−1 for a triangle without a tree) */
  leafIndex: Int32Array;
}

/**
 * Real triangles for the paint: each leaf of each tree becomes a triangle
 * (or a fan, where a finer neighbour put a vertex on one of its sides, so
 * there are no T-junctions and a closed mesh stays closed). Triangles
 * without a tree are copied as they are, fanned the same way when a split
 * neighbour put vertices on their sides.
 */
export function bakePaint(mesh: IndexedMesh, faceMaterial: Uint8Array, trees: Map<number, PaintNode>): BakedPaint {
  const P = mesh.positions, T = mesh.triangles;
  const pos: number[] = Array.from(P);
  const index = new Map<string, number>();
  // a point's key: a mesh vertex, a point on a mesh edge (by the edge and the weight of its higher-numbered end), or a point inside a triangle
  const keyOf = (f: number, w: Bary): string | number => {
    const zero = (w[0] === 0 ? 1 : 0) + (w[1] === 0 ? 1 : 0) + (w[2] === 0 ? 1 : 0);
    if (zero === 2) return T[f * 3 + (w[0] === 1 ? 0 : w[1] === 1 ? 1 : 2)];
    if (zero === 1) {
      const k = w[0] === 0 ? 0 : w[1] === 0 ? 1 : 2;
      const i = T[f * 3 + ((k + 1) % 3)], j = T[f * 3 + ((k + 2) % 3)];
      const wi = w[(k + 1) % 3], wj = w[(k + 2) % 3];
      return i < j ? `e${i}_${j}_${wj}` : `e${j}_${i}_${wi}`;
    }
    return `f${f}_${w[1]}_${w[2]}`;
  };
  const vertexOf = (f: number, w: Bary): number => {
    const key = keyOf(f, w);
    if (typeof key === 'number') return key;
    let v = index.get(key);
    if (v !== undefined) return v;
    v = pos.length / 3;
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
    if (key[0] === 'e') {
      // from the edge's own two ends, so both triangles that share it put the point in the same place
      const [, i, j, t] = key.match(/^e(\d+)_(\d+)_(.+)$/)!.map(Number) as number[];
      for (let d = 0; d < 3; d++) pos.push(P[i * 3 + d] * (1 - t) + P[j * 3 + d] * t);
    } else {
      for (let d = 0; d < 3; d++) pos.push(P[a + d] * w[0] + P[b + d] * w[1] + P[c + d] * w[2]);
    }
    index.set(key, v);
    return v;
  };
  const exists = (f: number, w: Bary): boolean => { const k = keyOf(f, w); return typeof k === 'number' || index.has(k); };
  // every leaf corner first, so the sides can find the vertices their neighbours put on them
  for (const [f, tree] of trees) forEachLeaf(tree, (l) => { for (const w of l.v) vertexOf(f, w); });
  const tris: number[] = [], mats: number[] = [], src: number[] = [], leaves: number[] = [];
  const inner = (f: number, p: Bary, q: Bary, out: Bary[]) => {
    const m = mid(p, q);
    if (!exists(f, m)) return;
    inner(f, p, m, out); out.push(m); inner(f, m, q, out);
  };
  const emit = (f: number, v: [Bary, Bary, Bary], material: number, leaf: number) => {
    const sides: Bary[][] = [[], [], []];
    for (let k = 0; k < 3; k++) inner(f, v[k], v[(k + 1) % 3], sides[k]);
    const busy = sides.filter((s) => s.length).length;
    const push = (a: number, b: number, c: number) => { tris.push(a, b, c); mats.push(material); src.push(f); leaves.push(leaf); };
    if (!busy) { push(vertexOf(f, v[0]), vertexOf(f, v[1]), vertexOf(f, v[2])); return; }
    if (busy === 1) {
      // fan from the corner opposite the side with the extra vertices
      const k = sides.findIndex((s) => s.length);
      const chain = [v[k], ...sides[k], v[(k + 1) % 3]].map((w) => vertexOf(f, w));
      const apex = vertexOf(f, v[(k + 2) % 3]);
      for (let i = 0; i + 1 < chain.length; i++) push(apex, chain[i], chain[i + 1]);
      return;
    }
    // a fan from the middle
    const ring: number[] = [];
    for (let k = 0; k < 3; k++) { ring.push(vertexOf(f, v[k])); for (const w of sides[k]) ring.push(vertexOf(f, w)); }
    const c = pos.length / 3;
    const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, cc = T[f * 3 + 2] * 3;
    const g: Bary = [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3, (v[0][2] + v[1][2] + v[2][2]) / 3];
    for (let d = 0; d < 3; d++) pos.push(P[a + d] * g[0] + P[b + d] * g[1] + P[cc + d] * g[2]);
    for (let i = 0; i < ring.length; i++) push(c, ring[i], ring[(i + 1) % ring.length]);
  };
  const n = T.length / 3;
  for (let f = 0; f < n; f++) {
    const tree = trees.get(f);
    if (tree) { let k = 0; forEachLeaf(tree, (l) => emit(f, l.v, l.material, k++)); }
    else emit(f, CORNERS, faceMaterial[f] ?? 0, -1);
  }
  return { mesh: { positions: Float32Array.from(pos), triangles: Uint32Array.from(tris) }, faceMaterial: Uint8Array.from(mats), source: Uint32Array.from(src), leafIndex: Int32Array.from(leaves) };
}

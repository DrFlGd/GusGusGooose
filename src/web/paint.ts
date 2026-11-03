// The paint as three.js sees it: one drawn triangle per mesh triangle, and
// for a triangle painted in more than one colour, one per leaf of its tree
// instead (the triangle's own slot is folded away). Leaves sit in blocks
// after the mesh's own triangles, so a stroke rewrites only the blocks it
// touched; the block area is packed again when too much of it is stale.
// Every drawn triangle carries its mesh triangle's index in `faceId`, which
// is what the screen face map (pick.ts) reads.

import * as THREE from 'three';
import type { IndexedMesh } from '../stl.ts';
import type { Material } from '../threemf-write.ts';
import { forEachLeaf } from '../paint-tree.ts';
import { PaintModel } from '../paint-model.ts';

export class PaintState extends PaintModel {
  readonly geometry = new THREE.BufferGeometry();
  /**
   * The faces painted in part, whole, in their main colour: drawn just
   * behind the leaves (see `backingMesh`), it fills the hairline cracks a GPU
   * leaves where a split face's leaves meet an unsplit neighbour.
   */
  readonly backing = new THREE.BufferGeometry();
  /** for each drawn triangle: the mesh triangle it lies in, and which leaf of that triangle's tree (−1: the whole triangle) */
  triFace!: Int32Array;
  triLeaf!: Int32Array;
  private capacity = 0;
  /** the first free drawn triangle after the blocks */
  private end: number;
  private stale = 0;
  private blocks = new Map<number, { start: number; size: number }>();
  private ranges: [number, number][] = [];
  private full = false;
  private rgb: THREE.Color[] = [];
  materials: Material[];

  constructor(mesh: IndexedMesh, materials: Material[]) {
    super(mesh);
    this.materials = materials;
    this.end = this.count;
    this.allocate(this.count + Math.max(1024, this.count >> 3));
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(mesh.positions, 3));
    this.geometry.boundingBox = box;
    this.geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    this.all = true;
    this.sync();
  }

  /** Repaints everything from the palette (after a colour change). */
  recolor() { this.all = true; this.sync(); }

  protected override changed() { super.changed(); this.sync(); }

  private allocate(capacity: number) {
    const keep = this.capacity;
    if (keep) this.geometry.dispose(); // frees the old buffers on the GPU; the new ones go up on the next frame
    const grow = (name: string, items: number) => {
      const old = this.geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
      const a = new Float32Array(capacity * items);
      if (old) a.set((old.array as Float32Array).subarray(0, keep * items));
      const attr = new THREE.BufferAttribute(a, 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, attr);
    };
    for (const name of ['position', 'normal', 'color', 'faceId']) grow(name, 9);
    const face = new Int32Array(capacity).fill(-1), leaf = new Int32Array(capacity).fill(-1);
    if (keep) { face.set(this.triFace.subarray(0, keep)); leaf.set(this.triLeaf.subarray(0, keep)); }
    this.triFace = face; this.triLeaf = leaf;
    this.capacity = capacity;
    this.full = true; // new buffers go up whole
  }

  private attr(name: string) { return (this.geometry.getAttribute(name) as THREE.BufferAttribute).array as Float32Array; }

  /** Writes drawn triangle `t` as the piece `w` of mesh triangle `f` in `material`. */
  private write(t: number, f: number, w: [number, number, number][] | null, material: number, leaf: number) {
    const pos = this.attr('position'), nor = this.attr('normal'), col = this.attr('color'), id = this.attr('faceId');
    const n = this.faceNormals, c = this.rgb[material] ?? this.rgb[0];
    const p = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      if (w) { this.point(f, w[k], p); pos[o] = p[0]; pos[o + 1] = p[1]; pos[o + 2] = p[2]; } else { pos[o] = pos[o + 1] = pos[o + 2] = 0; }
      nor[o] = n[f * 3]; nor[o + 1] = n[f * 3 + 1]; nor[o + 2] = n[f * 3 + 2];
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      id[o] = (f & 255) / 255; id[o + 1] = ((f >> 8) & 255) / 255; id[o + 2] = ((f >> 16) & 255) / 255;
    }
    this.triFace[t] = w ? f : -1;
    this.triLeaf[t] = leaf;
  }

  private static readonly WHOLE: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  /** The mesh triangle's own slot, and its block of leaves when it has a tree. */
  private writeFace(f: number) {
    const tree = this.trees.get(f);
    this.write(f, f, tree ? null : PaintState.WHOLE, this.faceMaterial[f], -1);
    this.mark(f, 1);
    let b = this.blocks.get(f);
    if (!tree) {
      if (b) { this.clear(b.start, b.size); this.stale += b.size; this.blocks.delete(f); }
      return;
    }
    let leaves = 0;
    forEachLeaf(tree, () => leaves++);
    if (!b || b.size < leaves) {
      if (b) { this.clear(b.start, b.size); this.stale += b.size; }
      const size = leaves + (leaves >> 2) + 1; // room to grow a little in place
      if (this.end + size > this.capacity) this.allocate(Math.max(this.capacity * 2, this.end + size));
      b = { start: this.end, size };
      this.end += size;
      this.blocks.set(f, b);
    }
    let k = 0;
    forEachLeaf(tree, (l) => { this.write(b!.start + k, f, l.v, l.material, k); k++; });
    if (k < b.size) this.clear(b.start + k, b.size - k);
    this.mark(b.start, b.size);
  }

  private clear(start: number, size: number) {
    for (let t = start; t < start + size; t++) this.write(t, 0, null, 0, -1);
    this.mark(start, size);
  }

  /** Drawn triangles to upload (not needed when everything goes up anyway). */
  private mark(start: number, size: number) {
    if (this.full) return;
    if (this.ranges.length >= 400) { this.full = true; this.ranges = []; return; }
    this.ranges.push([start, size]);
  }

  /** Catches the drawn triangles up with the paint. */
  private sync() {
    if (this.rgb.length !== this.materials.length) this.rgb = this.materials.map((m) => new THREE.Color(m.color)); // a colour was added
    if (this.all) {
      this.rgb = this.materials.map((m) => new THREE.Color(m.color));
      // everything again, with the blocks packed tight
      this.blocks.clear();
      this.end = this.count;
      this.stale = 0;
      this.full = true;
      this.ranges = [];
      for (let f = 0; f < this.count; f++) this.writeFace(f);
      this.all = false;
    } else {
      for (const f of this.dirty) this.writeFace(f);
      if (this.stale > Math.max(4096, (this.end - this.count) >> 1)) { this.all = true; this.dirty.clear(); this.sync(); return; }
    }
    this.dirty.clear();
    this.geometry.setDrawRange(0, this.end * 3);
    for (const name of ['position', 'normal', 'color', 'faceId']) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      if (!this.full) for (const [s, n] of this.ranges) a.addUpdateRange(s * 9, n * 9);
      a.needsUpdate = true;
    }
    this.ranges = [];
    this.full = false;
    this.syncBacking();
  }

  private backingCapacity = 0;
  private syncBacking() {
    const n = this.trees.size;
    if (n > this.backingCapacity) {
      // bigger buffers; dispose first so the old ones are freed on the GPU
      this.backing.dispose();
      this.backingCapacity = Math.max(64, n * 2);
      for (const name of ['position', 'normal', 'color']) {
        const a = new THREE.BufferAttribute(new Float32Array(this.backingCapacity * 9), 3);
        a.setUsage(THREE.DynamicDrawUsage);
        this.backing.setAttribute(name, a);
      }
      this.backing.boundingBox = this.geometry.boundingBox;
      this.backing.boundingSphere = this.geometry.boundingSphere;
    }
    if (!this.backingCapacity) return;
    const attr = (name: string) => this.backing.getAttribute(name) as THREE.BufferAttribute;
    const pos = attr('position').array as Float32Array, nor = attr('normal').array as Float32Array, col = attr('color').array as Float32Array;
    const fn = this.faceNormals, p = [0, 0, 0];
    let t = 0;
    for (const f of this.trees.keys()) {
      const c = this.rgb[this.faceMaterial[f]] ?? this.rgb[0];
      for (let k = 0; k < 3; k++) {
        this.point(f, PaintState.WHOLE[k], p);
        const o = t * 9 + k * 3;
        pos[o] = p[0]; pos[o + 1] = p[1]; pos[o + 2] = p[2];
        nor[o] = fn[f * 3]; nor[o + 1] = fn[f * 3 + 1]; nor[o + 2] = fn[f * 3 + 2];
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
      t++;
    }
    this.backing.setDrawRange(0, n * 3);
    for (const name of ['position', 'normal', 'color']) {
      const a = attr(name);
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n * 9));
      a.needsUpdate = true;
    }
  }

  /** The backing as a mesh to add under the painted one: pushed back in depth, and never hit by a ray. */
  backingMesh(material: THREE.Material): THREE.Mesh {
    const m = new THREE.Mesh(this.backing, material);
    m.raycast = () => {};
    return m;
  }
}

// Face painting on a mesh: a per-triangle material index, a brush that
// colours triangles near a hit point, and the three.js geometry that shows
// it with per-face colours.

import * as THREE from 'three';
import type { IndexedMesh } from '../stl.ts';
import type { Material } from '../threemf-write.ts';

export class PaintState {
  readonly faceMaterial: Uint8Array;
  readonly centroids: Float32Array;
  readonly geometry: THREE.BufferGeometry;
  private history: Uint8Array[] = [];

  constructor(readonly mesh: IndexedMesh, public materials: Material[]) {
    const n = mesh.triangles.length / 3;
    this.faceMaterial = new Uint8Array(n);
    this.centroids = new Float32Array(n * 3);
    const P = mesh.positions, T = mesh.triangles;
    for (let i = 0; i < n; i++) {
      const a = T[i * 3] * 3, b = T[i * 3 + 1] * 3, c = T[i * 3 + 2] * 3;
      this.centroids[i * 3] = (P[a] + P[b] + P[c]) / 3;
      this.centroids[i * 3 + 1] = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
      this.centroids[i * 3 + 2] = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    }
    // non-indexed so each face can carry its own colour
    const pos = new Float32Array(n * 9);
    for (let i = 0; i < T.length; i++) { const v = T[i] * 3; pos[i * 3] = P[v]; pos[i * 3 + 1] = P[v + 1]; pos[i * 3 + 2] = P[v + 2]; }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 9), 3));
    this.geometry.computeVertexNormals();
    this.recolor();
  }

  /** Repaints every face from its material index (after a palette change too). */
  recolor() {
    const col = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    const rgb = this.materials.map((m) => new THREE.Color(m.color));
    for (let i = 0; i < this.faceMaterial.length; i++) this.setFaceColor(col, i, rgb[this.faceMaterial[i]] ?? rgb[0]);
    col.needsUpdate = true;
  }

  private setFaceColor(col: THREE.BufferAttribute, face: number, c: THREE.Color) {
    for (let k = 0; k < 3; k++) col.setXYZ(face * 3 + k, c.r, c.g, c.b);
  }

  /** Colour every face whose centroid is within `radius` of `p`. Returns how many changed. */
  brush(p: THREE.Vector3, radius: number, material: number): number {
    const col = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color(this.materials[material]?.color ?? '#ffffff');
    const r2 = radius * radius;
    let changed = 0;
    for (let i = 0; i < this.faceMaterial.length; i++) {
      const dx = this.centroids[i * 3] - p.x, dy = this.centroids[i * 3 + 1] - p.y, dz = this.centroids[i * 3 + 2] - p.z;
      if (dx * dx + dy * dy + dz * dz > r2 || this.faceMaterial[i] === material) continue;
      this.faceMaterial[i] = material;
      this.setFaceColor(col, i, c);
      changed++;
    }
    if (changed) col.needsUpdate = true;
    return changed;
  }

  fillAll(material: number) {
    this.faceMaterial.fill(material);
    this.recolor();
  }

  snapshot() {
    this.history.push(Uint8Array.from(this.faceMaterial));
    if (this.history.length > 50) this.history.shift();
  }

  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.faceMaterial.set(prev);
    this.recolor();
    return true;
  }

  get painted(): boolean {
    return this.faceMaterial.some((m) => m !== 0);
  }
}

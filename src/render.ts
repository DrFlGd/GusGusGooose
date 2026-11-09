// A small software renderer for pictures of solids: orthographic, z-buffer,
// flat shading, written as PNG (zlib from Node). For the renders in
// /mnt/project-files when no browser is to hand.

import { deflateSync } from 'node:zlib';
import type { IndexedMesh } from './stl.ts';

export type V3 = [number, number, number];
export interface View {
  /** camera looks along -dir (dir points from the scene to the eye) */
  eye: V3;
  up?: V3;
  /** mm per pixel */
  scale: number;
  width: number;
  height: number;
  /** world point drawn at the image centre */
  centre: V3;
  background?: [number, number, number];
}

export function render(scene: { mesh: IndexedMesh; color: [number, number, number] }[], view: View): Uint8Array {
  return png(renderRgb(scene, view), view.width, view.height);
}

function raster(a: [number, number, number], b: [number, number, number], c: [number, number, number], col: V3, img: Uint8Array, depth: Float32Array, W: number, H: number) {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    let w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
    let w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
    let w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
    const i = y * W + x;
    if (z <= depth[i]) continue;
    depth[i] = z;
    img[i * 3] = col[0]; img[i * 3 + 1] = col[1]; img[i * 3 + 2] = col[2];
  }
}

function png(rgb: Uint8Array, W: number, H: number): Uint8Array {
  const raw = new Uint8Array((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; raw.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1); }
  const chunks: Uint8Array[] = [];
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}

let table: Uint32Array | null = null;
function crc(data: Uint8Array): number {
  if (!table) { table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Tiles rendered scenes into one image: each tile rendered at the same size, laid out in a row with a label band (plain colour, no text). */
export function renderRow(tiles: { scene: { mesh: IndexedMesh; color: [number, number, number] }[]; view: View }[]): Uint8Array {
  const W = tiles[0].view.width, H = tiles[0].view.height;
  const total = new Uint8Array(W * tiles.length * H * 3);
  tiles.forEach((t, k) => {
    const rgb = renderRgb(t.scene, t.view);
    for (let y = 0; y < H; y++) total.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), (y * W * tiles.length + k * W) * 3);
  });
  return png(total, W * tiles.length, H);
}

function renderRgb(scene: { mesh: IndexedMesh; color: [number, number, number] }[], view: View): Uint8Array {
  const { width: W, height: H } = view;
  const bg = view.background ?? [244, 241, 234];
  const img = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) img.set(bg, i * 3);
  const depth = new Float32Array(W * H).fill(-Infinity);
  const d = unit(view.eye);
  const upHint = view.up ?? (Math.abs(d[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1]) as V3;
  const right = unit(cross(upHint, d)), up = cross(d, right);
  const light = unit([0.4, -0.6, 0.7]);
  const project = (p: V3): [number, number, number] => { const q = sub(p, view.centre); return [W / 2 + dot(q, right) / view.scale, H / 2 - dot(q, up) / view.scale, dot(q, d)]; };
  for (const { mesh, color } of scene) {
    const P = mesh.positions, T = mesh.triangles;
    for (let t = 0; t < T.length; t += 3) {
      const a = vert(P, T[t]), b = vert(P, T[t + 1]), c = vert(P, T[t + 2]);
      const n = unit(cross(sub(b, a), sub(c, a)));
      if (dot(n, d) <= 0) continue;
      const shade = 0.35 + 0.55 * Math.max(0, dot(n, light)) + 0.15 * Math.max(0, dot(n, d));
      raster(project(a), project(b), project(c), color.map((v) => Math.min(255, v * shade)) as V3, img, depth, W, H);
    }
  }
  return img;
}

const vert = (P: Float32Array, i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// A fitted part and its paint as one binary file, for the library: the
// mesh exactly as fitted (so saved paint goes back face for face) and the
// paint, whole faces as one byte each and faces painted in part as their
// slicer paint codes.

import type { IndexedMesh } from './stl.ts';
import type { PaintModel } from './paint-model.ts';
import { decodePaint, encodePaint, type PaintNode } from './paint-tree.ts';

const enc = new TextEncoder(), dec = new TextDecoder();

// the fitted part and its paint, as one binary file: 'GGP1', the header's length, the header (JSON: sizes and the
// codes of the faces painted in part), then the positions, the triangles and each face's colour
const PART_MAGIC = 0x31504747; // 'GGP1'
export function encodePart(p: PaintModel): Uint8Array {
  const trees: [number, string][] = [...p.trees].map(([f, t]) => [f, encodePaint(t)]);
  const head = enc.encode(JSON.stringify({ positions: p.mesh.positions.length, triangles: p.mesh.triangles.length, trees }));
  const headLen = Math.ceil(head.length / 4) * 4;
  const out = new Uint8Array(8 + headLen + p.mesh.positions.byteLength + p.mesh.triangles.byteLength + p.faceMaterial.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, PART_MAGIC, true);
  dv.setUint32(4, headLen, true);
  out.set(head, 8);
  out.fill(0x20, 8 + head.length, 8 + headLen); // pad with spaces, still valid JSON
  let at = 8 + headLen;
  out.set(new Uint8Array(p.mesh.positions.buffer, p.mesh.positions.byteOffset, p.mesh.positions.byteLength), at); at += p.mesh.positions.byteLength;
  out.set(new Uint8Array(p.mesh.triangles.buffer, p.mesh.triangles.byteOffset, p.mesh.triangles.byteLength), at); at += p.mesh.triangles.byteLength;
  out.set(p.faceMaterial, at);
  return out;
}
export function decodePart(b: Uint8Array): { mesh: IndexedMesh; faceMaterial: Uint8Array; trees: Map<number, PaintNode> } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== PART_MAGIC) throw new Error('not a saved part');
  const headLen = dv.getUint32(4, true);
  const head = JSON.parse(dec.decode(b.subarray(8, 8 + headLen))) as { positions: number; triangles: number; trees: [number, string][] };
  let at = b.byteOffset + 8 + headLen;
  const copy = b.buffer.slice(at, at + head.positions * 4 + head.triangles * 4); // aligned copies of the arrays
  const positions = new Float32Array(copy, 0, head.positions);
  const triangles = new Uint32Array(copy, head.positions * 4, head.triangles);
  at += head.positions * 4 + head.triangles * 4;
  const faceMaterial = new Uint8Array(b.buffer.slice(at, at + head.triangles / 3));
  const trees = new Map<number, PaintNode>();
  for (const [f, code] of head.trees) { const t = decodePaint(code); if (t) trees.set(f, t); }
  return { mesh: { positions, triangles }, faceMaterial, trees };
}

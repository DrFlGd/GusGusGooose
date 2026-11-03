// Minimal Wavefront OBJ parser, pure. Reads `v` and `f` lines (polygons are
// fan-triangulated, negative indices allowed), ignores normals, textures,
// groups and materials, and welds the result like the STL reader does.

import { weld, type IndexedMesh } from './stl.ts';

export function parseObj(text: string): IndexedMesh {
  const verts: number[] = [];
  const soup: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.slice(2).trim().split(/\s+/).map(Number);
      verts.push(p[0], p[1], p[2]);
    } else if (line.startsWith('f ')) {
      const idx = line.slice(2).trim().split(/\s+/).map((tok) => {
        const i = Number(tok.split('/')[0]);
        return i < 0 ? verts.length / 3 + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const i of [idx[0], idx[k], idx[k + 1]]) soup.push(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
      }
    }
  }
  if (!soup.length) throw new Error('no faces found in the OBJ');
  return weld(Float32Array.from(soup));
}

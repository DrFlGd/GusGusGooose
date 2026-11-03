// Loads a downloaded model of any supported format into one Manifold solid.
// STL and OBJ are a single mesh; a 3MF may hold several parts, which are
// unioned (negative parts subtracted) so the whole print becomes one
// accessory. Pure, shared by the CLI and the browser app.

import type { Manifold as ManifoldT } from 'manifold-3d';
import { parseStl, type IndexedMesh } from './stl.ts';
import { parseObj } from './obj.ts';
import { parse3mf } from './threemf-parse.ts';
import { manifold, toManifold } from './fit.ts';

export const MODEL_EXTENSIONS = ['.stl', '.obj', '.3mf'];

export interface LoadedModel {
  solid: ManifoldT;
  /** how many separate parts went into it (3MF) */
  parts: number;
  triangles: number;
}

export async function loadModel(name: string, data: ArrayBuffer | Uint8Array): Promise<LoadedModel> {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  if (ext === '.3mf') {
    const parts = await parse3mf(data);
    const { Manifold } = await manifold();
    const solids: ManifoldT[] = [];
    const holes: ManifoldT[] = [];
    let triangles = 0;
    for (const p of parts) {
      if (p.kind === 'modifier') continue;
      triangles += p.mesh.triangles.length / 3;
      (p.kind === 'negative' ? holes : solids).push(await toManifold(p.mesh));
    }
    if (!solids.length) throw new Error('the 3MF has no printable parts');
    let solid = solids.length === 1 ? solids[0] : Manifold.union(solids);
    if (holes.length) solid = solid.subtract(Manifold.union(holes));
    return { solid, parts: solids.length, triangles };
  }
  let mesh: IndexedMesh;
  if (ext === '.obj') mesh = parseObj(new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data)));
  else if (ext === '.stl') mesh = parseStl(data);
  else throw new Error(`unsupported model format ${ext || name}; use STL, OBJ or 3MF`);
  return { solid: await toManifold(mesh), parts: 1, triangles: mesh.triangles.length / 3 };
}

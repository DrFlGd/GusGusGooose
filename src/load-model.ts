// Loads a downloaded model of any supported format into one Manifold solid.
// STL and OBJ are a single mesh; a 3MF may hold several parts, which are
// unioned (negative parts subtracted) so the whole print becomes one
// accessory. Pure, shared by the CLI and the browser app.

import type { Manifold as ManifoldT } from 'manifold-3d';
import { parseStl, type IndexedMesh } from './stl.ts';
import { parseObj } from './obj.ts';
import { parse3mf } from './threemf-parse.ts';
import { manifold, toManifold } from './fit.ts';
import { voxelRebuild, type RepairOptions } from './repair.ts';

export const MODEL_EXTENSIONS = ['.stl', '.obj', '.3mf'];

export interface LoadedModel {
  solid: ManifoldT;
  /** how many separate parts went into it (3MF) */
  parts: number;
  triangles: number;
  /** parts that were not valid solids and were rebuilt on a voxel grid, with the voxel size used */
  repaired?: { parts: number; voxel: number };
}

export interface LoadOptions {
  /** rebuild parts that are not valid solids on a voxel grid instead of failing (default true) */
  repair?: boolean;
  /** voxel size for that rebuild, mm; default from the part's size */
  voxel?: number;
}

/** A mesh as a solid, rebuilt on a voxel grid if it is not one and repair is allowed. */
async function solidOf(mesh: IndexedMesh, opts: LoadOptions, repaired: { parts: number; voxel: number }): Promise<ManifoldT> {
  try {
    return await toManifold(mesh);
  } catch (err) {
    if (opts.repair === false) throw err;
    const r = await voxelRebuild(mesh, { voxel: opts.voxel } as RepairOptions);
    repaired.parts++;
    repaired.voxel = r.voxel;
    return r.solid;
  }
}

export async function loadModel(name: string, data: ArrayBuffer | Uint8Array, opts: LoadOptions = {}): Promise<LoadedModel> {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  const repaired = { parts: 0, voxel: 0 };
  if (ext === '.3mf') {
    const parts = await parse3mf(data);
    const { Manifold } = await manifold();
    const solids: ManifoldT[] = [];
    const holes: ManifoldT[] = [];
    let triangles = 0;
    for (const p of parts) {
      if (p.kind === 'modifier') continue;
      triangles += p.mesh.triangles.length / 3;
      (p.kind === 'negative' ? holes : solids).push(await solidOf(p.mesh, opts, repaired));
    }
    if (!solids.length) throw new Error('the 3MF has no printable parts');
    let solid = solids.length === 1 ? solids[0] : Manifold.union(solids);
    if (holes.length) solid = solid.subtract(Manifold.union(holes));
    return { solid, parts: solids.length, triangles, repaired: repaired.parts ? repaired : undefined };
  }
  let mesh: IndexedMesh;
  if (ext === '.obj') mesh = parseObj(new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data)));
  else if (ext === '.stl') mesh = parseStl(data);
  else throw new Error(`unsupported model format ${ext || name}; use STL, OBJ or 3MF`);
  const solid = await solidOf(mesh, opts, repaired);
  return { solid, parts: 1, triangles: mesh.triangles.length / 3, repaired: repaired.parts ? repaired : undefined };
}

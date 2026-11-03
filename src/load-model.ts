// Loads a downloaded model of any supported format into one Manifold solid.
// STL and OBJ are a single mesh; a 3MF may hold several parts, which are
// unioned (negative parts subtracted) so the whole print becomes one
// accessory. A 3MF's colours (each part's filament slot, and paint-on colour
// per triangle) are kept as material runs on the solid so they survive the
// booleans that fit the model and come out again on the painted export.
// Pure, shared by the CLI and the browser app.

import type { Manifold as ManifoldT } from 'manifold-3d';
import { parseStl, type IndexedMesh } from './stl.ts';
import { parseObj } from './obj.ts';
import { parse3mfProject, type Part } from './threemf-parse.ts';
import { fromManifold, manifold, toManifold, toManifoldTagged } from './fit.ts';
import { voxelRebuild, type RepairOptions } from './repair.ts';
import type { Material } from './threemf-write.ts';

export const MODEL_EXTENSIONS = ['.stl', '.obj', '.3mf'];

/** stand-in colours for filament slots when the project file does not name any */
export const DEFAULT_SLOT_COLOURS = ['#e9dcc3', '#222222', '#f28c28', '#d03b2f', '#4f8bd6', '#6fbf73', '#f2d44b', '#9b6bd6'];

export interface LoadedModel {
  solid: ManifoldT;
  /** how many separate parts went into it (3MF) */
  parts: number;
  triangles: number;
  /** parts that were not valid solids and were rebuilt on a voxel grid, with the voxel size used */
  repaired?: { parts: number; voxel: number };
  /**
   * One material per filament slot the model uses, when the 3MF names any.
   * The solid's faces are tagged so `fromManifoldTagged(solid, firstID,
   * materials.length, fallback)` gives each face its material, before or after
   * booleans and transforms.
   */
  materials?: Material[];
  firstID?: number;
  /** the material with the most faces: what faces made by a cut should take */
  fallback?: number;
}

export interface LoadOptions {
  /** rebuild parts that are not valid solids on a voxel grid instead of failing (default true) */
  repair?: boolean;
  /** voxel size for that rebuild, mm; default from the part's size */
  voxel?: number;
}

/**
 * A mesh as a solid, rebuilt on a voxel grid if it is not one and repair is
 * allowed. With `tags`, its faces carry those materials; a rebuilt part is
 * one material throughout (the part's own).
 */
async function solidOf(mesh: IndexedMesh, opts: LoadOptions, repaired: { parts: number; voxel: number }, tags?: { faceMaterial: Uint8Array; firstID: number; whole: number }): Promise<ManifoldT> {
  try {
    return tags ? await toManifoldTagged(mesh, tags.faceMaterial, tags.firstID) : await toManifold(mesh);
  } catch (err) {
    if (opts.repair === false) throw err;
    const r = await voxelRebuild(mesh, { voxel: opts.voxel } as RepairOptions);
    repaired.parts++;
    repaired.voxel = r.voxel;
    if (!tags) return r.solid;
    const m = fromManifold(r.solid);
    return toManifoldTagged(m, new Uint8Array(m.triangles.length / 3).fill(tags.whole), tags.firstID);
  }
}

export async function loadModel(name: string, data: ArrayBuffer | Uint8Array, opts: LoadOptions = {}): Promise<LoadedModel> {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  const repaired = { parts: 0, voxel: 0 };
  if (ext === '.3mf') {
    const { parts, colours, names } = await parse3mfProject(data);
    const { Manifold } = await manifold();
    const printed = parts.filter((p) => p.kind !== 'modifier');
    const slots = usedSlots(printed);
    const materials = slots.length ? slots.map((s) => ({ name: names[s - 1] || `Filament ${s}`, color: colours[s - 1] ?? DEFAULT_SLOT_COLOURS[(s - 1) % DEFAULT_SLOT_COLOURS.length] })) : undefined;
    const firstID = materials ? Manifold.reserveIDs(materials.length) : 0;
    const faceCounts = new Array<number>(slots.length).fill(0);
    const solids: ManifoldT[] = [];
    const holes: ManifoldT[] = [];
    let triangles = 0;
    for (const p of printed) {
      const n = p.mesh.triangles.length / 3;
      triangles += n;
      if (p.kind === 'negative') { holes.push(await solidOf(p.mesh, opts, repaired)); continue; }
      let tags: Parameters<typeof solidOf>[3];
      if (materials) {
        const own = slots.indexOf(p.extruder ?? 1);
        const faceMaterial = new Uint8Array(n).fill(own);
        if (p.faceExtruder) for (let t = 0; t < n; t++) if (p.faceExtruder[t]) faceMaterial[t] = slots.indexOf(p.faceExtruder[t]);
        for (const m of faceMaterial) faceCounts[m]++;
        tags = { faceMaterial, firstID, whole: own };
      }
      solids.push(await solidOf(p.mesh, opts, repaired, tags));
    }
    if (!solids.length) throw new Error('the 3MF has no printable parts');
    let solid = solids.length === 1 ? solids[0] : Manifold.union(solids);
    if (holes.length) solid = solid.subtract(Manifold.union(holes));
    const fallback = materials ? faceCounts.indexOf(Math.max(...faceCounts)) : undefined;
    return { solid, parts: solids.length, triangles, repaired: repaired.parts ? repaired : undefined, materials, firstID: materials ? firstID : undefined, fallback };
  }
  let mesh: IndexedMesh;
  if (ext === '.obj') mesh = parseObj(new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data)));
  else if (ext === '.stl') mesh = parseStl(data);
  else throw new Error(`unsupported model format ${ext || name}; use STL, OBJ or 3MF`);
  const solid = await solidOf(mesh, opts, repaired);
  return { solid, parts: 1, triangles: mesh.triangles.length / 3, repaired: repaired.parts ? repaired : undefined };
}

/**
 * The filament slots the printed parts use, ascending: each part's own slot
 * and every slot painted on it. Empty when the file names no slot at all, in
 * which case the model has no colours worth keeping.
 */
function usedSlots(parts: Part[]): number[] {
  const slots = new Set<number>();
  let any = false;
  for (const p of parts) {
    if (p.kind === 'negative') continue;
    if (p.extruder) { slots.add(p.extruder); any = true; }
    if (p.faceExtruder) { any = true; for (const s of p.faceExtruder) if (s) slots.add(s); }
  }
  if (!any) return [];
  for (const p of parts) if (p.kind === 'normal' && !p.extruder) slots.add(1);
  return [...slots].sort((a, b) => a - b);
}

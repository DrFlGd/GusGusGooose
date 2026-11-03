"""Repair a downloaded model with Blender so Manifold accepts it.

    pip install bpy        # Blender as a Python module (about 400 MB)
    python3 scripts/repair.py in.stl out.stl [--voxel 0.3]

First pass: merge doubles, drop degenerate faces, fill holes, make normals
consistent. If edges shared by more than two faces remain (internal walls,
self-touching parts), a voxel remesh at the given size rebuilds the whole
surface as one watertight shell; details smaller than the voxel are lost.
"""
import sys
import bpy
import bmesh

src, dst = sys.argv[1], sys.argv[2]
voxel = float(sys.argv[sys.argv.index('--voxel') + 1]) if '--voxel' in sys.argv else 0.3

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.stl_import(filepath=src)
obj = bpy.context.selected_objects[0]
bpy.context.view_layer.objects.active = obj

bm = bmesh.new()
bm.from_mesh(obj.data)
before = (len(bm.verts), len(bm.faces))
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.02)
bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=0.01)
bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bmesh.ops.triangulate(bm, faces=bm.faces)
bad = sum(1 for e in bm.edges if not e.is_manifold)
bm.to_mesh(obj.data)
bm.free()
print(f'cleanup: {before} -> ({len(obj.data.vertices)}, {len(obj.data.polygons)}), {bad} non-manifold edges left')

if bad:
    mod = obj.modifiers.new('remesh', 'REMESH')
    mod.mode = 'VOXEL'
    mod.voxel_size = voxel
    mod.use_smooth_shade = False
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bad = sum(1 for e in bm.edges if not e.is_manifold)
    bm.to_mesh(obj.data)
    bm.free()
    print(f'voxel remesh at {voxel} mm: ({len(obj.data.vertices)}, {len(obj.data.polygons)}), {bad} non-manifold edges left')

bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.ops.wm.stl_export(filepath=dst, export_selected_objects=True)
print('written to', dst)

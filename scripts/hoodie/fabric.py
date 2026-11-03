"""Gives the shirt body a fabric look: the outer surface gets soft folds (a
low-frequency noise plus a few sag folds that grow toward the hem) pushed
outward only, so the inside stays clear of the goose. Works in the sheared
frame, where the body's outer surface is simply everything further from the
axis than the profile.

    python3 fabric.py profile.json body.stl body_fabric.stl
"""
import json, math, sys
import bpy
from mathutils import Vector, noise

prof = json.load(open(sys.argv[1]))
src, dst = sys.argv[2], sys.argv[3]
CX, CY = prof['cx'], prof['cy']
Z, R, N = prof['z'], prof['r'], prof['nTheta']
SH = prof['shear']
HEM, NECK = prof['hem'], prof['neck']


def radius(theta, z):
    kf = (z - Z[0]) / (Z[-1] - Z[0]) * (len(Z) - 1)
    kf = min(len(Z) - 1, max(0, kf))
    k0 = int(math.floor(kf)); k1 = min(len(Z) - 1, k0 + 1); fk = kf - k0
    af = (theta % (2 * math.pi)) / (2 * math.pi) * N
    i0 = int(math.floor(af)) % N; i1 = (i0 + 1) % N; fa = af - math.floor(af)
    row = lambda k: R[k][i0] * (1 - fa) + R[k][i1] * fa
    return row(k0) * (1 - fk) + row(k1) * fk


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.stl_import(filepath=src)
ob = bpy.context.selected_objects[0]
me = ob.data
# to the sheared frame
for v in me.vertices:
    v.co.x -= SH['sx'] * (v.co.z - SH['z0'])
    v.co.y -= SH['sy'] * (v.co.z - SH['z0'])
me.update()
me.calc_normals_split() if hasattr(me, 'calc_normals_split') else None

moved = 0
for v in me.vertices:
    x, y, z = v.co.x - CX, v.co.y - CY, v.co.z
    th = math.atan2(y, x); r = math.hypot(x, y)
    if z > NECK - 4 or z < HEM + 6.5:            # leave the collar and the ribbed hem band alone
        continue
    ref = radius(th, z) + 0.4 + 1.6              # the outer surface sits here
    if r < ref - 0.8:                            # inner surface or wall: untouched
        continue
    # soft folds: broad noise plus vertical sag folds that deepen toward the hem
    n = noise.noise(Vector((x * 0.09, y * 0.09, z * 0.07)))
    sag = math.sin(th * 7.0 + 1.3) * ((NECK - z) / (NECK - HEM)) ** 1.6
    d = 0.35 * (n + 1) + 0.45 * max(0.0, sag) * (0.6 + 0.4 * noise.noise(Vector((x * 0.2, y * 0.2, z * 0.05))))
    # fade in from the collar and out just above the hem band
    fade = min(1.0, (NECK - 4 - z) / 6.0) * min(1.0, (z - HEM - 6.5) / 4.0)
    d *= fade
    v.co.x += d * math.cos(th)
    v.co.y += d * math.sin(th)
    moved += 1
# back to the goose frame
for v in me.vertices:
    v.co.x += SH['sx'] * (v.co.z - SH['z0'])
    v.co.y += SH['sy'] * (v.co.z - SH['z0'])
me.update()
bpy.ops.object.select_all(action='DESELECT')
ob.select_set(True)
bpy.context.view_layer.objects.active = ob
bpy.ops.wm.stl_export(filepath=dst, export_selected_objects=True)
print('fabric: moved', moved, 'of', len(me.vertices), 'vertices; wrote', dst)

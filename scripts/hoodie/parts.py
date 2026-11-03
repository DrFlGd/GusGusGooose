"""Soft parts of a goose-proportioned hoodie, modelled in Blender against the
body profile: hood (down, on the back), two sleeves hugging the flanks with
a bent elbow and a cuff, a kangaroo pocket on the chest, two drawstrings
with aglets. Everything is built in the sheared frame where the body axis
is vertical, then sheared back and written as one STL per part.

    python3 parts.py profile.json outdir/
"""
import json, math, sys
import bpy, bmesh
from mathutils import Vector

prof = json.load(open(sys.argv[1]))
out = sys.argv[2].rstrip('/')
CX, CY = prof['cx'], prof['cy']
Z = prof['z']
R = prof['r']
N = prof['nTheta']
FRONT = prof['front']           # angle of the goose's front in the sheared frame
SH = prof['shear']
WALL = 0.4 + 1.6                # clearance + shirt wall: the body's outer surface sits this far out from the profile
HEM, NECK = prof['hem'], prof['neck']
BACK = FRONT + math.pi
LEFT, RIGHT = FRONT + math.pi / 2, FRONT - math.pi / 2


def radius(theta, z):
    """Outer surface radius of the shirt body at an angle and height (bilinear in the profile)."""
    kf = (z - Z[0]) / (Z[-1] - Z[0]) * (len(Z) - 1)
    kf = min(len(Z) - 1, max(0, kf))
    k0 = int(math.floor(kf)); k1 = min(len(Z) - 1, k0 + 1); fk = kf - k0
    af = (theta % (2 * math.pi)) / (2 * math.pi) * N
    i0 = int(math.floor(af)) % N; i1 = (i0 + 1) % N; fa = af - math.floor(af)
    row = lambda k: R[k][i0] * (1 - fa) + R[k][i1] * fa
    return row(k0) * (1 - fk) + row(k1) * fk + WALL


def surf(theta, z, out_by=0.0):
    r = radius(theta, z) + out_by
    return Vector((CX + r * math.cos(theta), CY + r * math.sin(theta), z))


def radial(theta):
    return Vector((math.cos(theta), math.sin(theta), 0))


def new_object(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def subdivide(ob, levels=2):
    mod = ob.modifiers.new('subd', 'SUBSURF')
    mod.levels = levels
    mod.render_levels = levels


def displace(ob, strength=0.25, size=6.0):
    tex = bpy.data.textures.new(ob.name + '_wrinkle', 'CLOUDS')
    tex.noise_scale = size
    tex.noise_depth = 2
    mod = ob.modifiers.new('wrinkle', 'DISPLACE')
    mod.texture = tex
    mod.strength = strength
    mod.mid_level = 0.5
    mod.direction = 'NORMAL'


def apply_all(ob):
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def shear_and_write(ob, path):
    apply_all(ob)
    me = ob.data
    for v in me.vertices:
        v.co.x += SH['sx'] * (v.co.z - SH['z0'])
        v.co.y += SH['sy'] * (v.co.z - SH['z0'])
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.wm.stl_export(filepath=path, export_selected_objects=True)
    print('wrote', path, len(me.vertices), 'verts', len(me.polygons), 'faces')


def pillow(name, outer, inner, nu, nv):
    """A closed cushion between two parametric sheets that share a border: (u, v) in [0,1]^2."""
    bm = bmesh.new()
    O = [[bm.verts.new(outer(i / (nu - 1), j / (nv - 1))) for j in range(nv)] for i in range(nu)]
    I = [[bm.verts.new(inner(i / (nu - 1), j / (nv - 1))) for j in range(nv)] for i in range(nu)]
    for i in range(nu - 1):
        for j in range(nv - 1):
            bm.faces.new((O[i][j], O[i + 1][j], O[i + 1][j + 1], O[i][j + 1]))
            bm.faces.new((I[i][j], I[i][j + 1], I[i + 1][j + 1], I[i + 1][j]))
    # side walls along the four borders
    for i in range(nu - 1):
        bm.faces.new((O[i][0], I[i][0], I[i + 1][0], O[i + 1][0]))
        bm.faces.new((O[i][nv - 1], O[i + 1][nv - 1], I[i + 1][nv - 1], I[i][nv - 1]))
    for j in range(nv - 1):
        bm.faces.new((O[0][j], O[0][j + 1], I[0][j + 1], I[0][j]))
        bm.faces.new((O[nu - 1][j], I[nu - 1][j], I[nu - 1][j + 1], O[nu - 1][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def tube_along(name, centres, radii, segments=16, flatten=None, cap=True):
    """A closed tube through a polyline of centres with a radius per station; `flatten(k)` gives
    (radial direction, squash) to make the section an ellipse pressed against the body."""
    bm = bmesh.new()
    rings = []
    for k, c in enumerate(centres):
        if k == 0:
            t = (centres[1] - centres[0]).normalized()
        elif k == len(centres) - 1:
            t = (centres[-1] - centres[-2]).normalized()
        else:
            t = (centres[k + 1] - centres[k - 1]).normalized()
        if flatten:
            n, squash = flatten(k)
            u = n - t * n.dot(t); u.normalize()
            w = t.cross(u).normalized()
            su, sw = squash, 1.0 / math.sqrt(squash)
        else:
            a = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
            u = t.cross(a).normalized(); w = t.cross(u).normalized()
            su = sw = 1.0
        ring = [bm.verts.new(c + radii[k] * (su * math.cos(2 * math.pi * s / segments) * u + sw * math.sin(2 * math.pi * s / segments) * w)) for s in range(segments)]
        rings.append(ring)
    for k in range(len(rings) - 1):
        for s in range(segments):
            bm.faces.new((rings[k][s], rings[k][(s + 1) % segments], rings[k + 1][(s + 1) % segments], rings[k + 1][s]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------- hood, down on the back: a rounded flap hanging from the collar, widest at the shoulders, its opening edge rolled ----------
HOOD_TOP, HOOD_BOTTOM = NECK - 3, NECK - 30


def hood_outer(u, v):
    z = HOOD_TOP + (HOOD_BOTTOM - HOOD_TOP) * v
    half = hood_half(v)
    ang = BACK + (u - 0.5) * 2 * half / radius(BACK, z)
    # a soft cushion: fullest a third of the way down, thinning to a 2 mm edge all round, with a centre-seam dip
    across = math.sin(math.pi * u) ** 0.7
    down = math.sin(math.pi * min(1.0, 0.12 + 0.88 * v)) ** 0.7
    bulge = 2.0 + 13.0 * across * down - 2.0 * math.exp(-((u - 0.5) * 6) ** 2) * down
    return surf(ang, z, out_by=bulge)


def hood_half(v):
    # full width down to 55% of the way, then a rounded bottom
    if v < 0.55:
        return 25.0
    f = (v - 0.55) / 0.45
    return 25.0 * math.sqrt(max(0.02, 1 - 0.9 * f * f))


def hood_inner(u, v):
    z = HOOD_TOP + (HOOD_BOTTOM - HOOD_TOP) * v
    half = hood_half(v)
    ang = BACK + (u - 0.5) * 2 * half / radius(BACK, z)
    return surf(ang, z, out_by=-1.2)


hood = new_object('hood', pillow('hood', hood_outer, hood_inner, 17, 13))
subdivide(hood, 2)
displace(hood, 0.35, 8.0)
shear_and_write(hood, f'{out}/hood.stl')

# the rolled opening edge: a tube along the top of the flap, then down both sides a little
rim = [hood_outer(0.0, 0.25 - 0.25 * i / 4) for i in range(4)] + [hood_outer(i / 24, 0.0) + Vector((0, 0, 0.6)) for i in range(25)] + [hood_outer(1.0, 0.25 * i / 4) for i in range(1, 5)]
rimob = new_object('rim', tube_along('rim', rim, [2.8] * len(rim), 12))
subdivide(rimob, 1)
shear_and_write(rimob, f'{out}/rim.stl')

# ---------- sleeves: from the shoulder down the flank, curving round to the front, hands tucked into the pocket ----------
P_TOP, P_BOTTOM = HEM + 31, HEM + 9


def smooth_path(points, n):
    """Catmull-Rom through the control points, n samples."""
    out = []
    pts = [points[0]] + list(points) + [points[-1]]
    segs = len(points) - 1
    for k in range(n):
        f = k / (n - 1) * segs
        i = min(segs - 1, int(math.floor(f))); t = f - i
        p0, p1, p2, p3 = pts[i], pts[i + 1], pts[i + 2], pts[i + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t))
    return out


for name, side, sgn in (('sleeve_l', LEFT, 1), ('sleeve_r', RIGHT, -1)):
    # control points as (angle, z); the hand ends just inside the pocket's slanted side opening
    ctrl = [(side, NECK - 11), (side, NECK - 24), (side + (FRONT - side) * 0.35, HEM + 36), (side + (FRONT - side) * 0.68, P_TOP - 1), (FRONT + sgn * 17.0 / radius(FRONT, P_TOP - 7), P_TOP - 7)]
    n = 22
    path = smooth_path([Vector((a, z, 0)) for a, z in ctrl], n)
    centres, radii, dirs = [], [], []
    for k, p in enumerate(path):
        t = k / (n - 1)
        ang, z = p.x, p.y
        rad = 7.4 - 2.2 * t + (1.0 if 0.84 < t < 0.94 else 0)   # tapers to the wrist, cuff band before the pocket
        rad *= 1 + 0.07 * math.sin(t * 2 * math.pi * 3.5 + 0.6) * math.sin(math.pi * t)  # fabric gathers along the arm
        out_by = rad * 0.45 + 0.5                                 # pressed against the body
        if t < 0.12: out_by -= 4.0 * (1 - t / 0.12)              # the shoulder emerges from the body
        if t > 0.94: out_by = 1.0                                 # the hand is under the pocket
        centres.append(surf(ang, z, out_by=out_by)); radii.append(rad); dirs.append(ang)
    flat = lambda k, dirs=dirs: (radial(dirs[k]), 0.7)
    ob = new_object(name, tube_along(name, centres, radii, 20, flatten=flat))
    subdivide(ob, 2)
    displace(ob, 0.45, 4.5)
    shear_and_write(ob, f'{out}/{name}.stl')

# ---------- kangaroo pocket on the chest: a curved patch standing off the body with slanted hand openings ----------


def pocket_outer(u, v):
    z = P_TOP + (P_BOTTOM - P_TOP) * v
    half = 21.0 - 6.0 * v                       # the sides slant in toward the bottom (hand openings)
    ang = FRONT + (u - 0.5) * 2 * half / radius(FRONT, z)
    puff = 2.2 + 1.3 * math.sin(math.pi * u) * math.sin(math.pi * (0.1 + 0.8 * v))
    return surf(ang, z, out_by=puff)


def pocket_inner(u, v):
    z = P_TOP + (P_BOTTOM - P_TOP) * v
    half = 21.0 - 6.0 * v
    ang = FRONT + (u - 0.5) * 2 * half / radius(FRONT, z)
    return surf(ang, z, out_by=-1.0)


pocket = new_object('pocket', pillow('pocket', pocket_outer, pocket_inner, 13, 7))
subdivide(pocket, 2)
displace(pocket, 0.2, 6.0)
shear_and_write(pocket, f'{out}/pocket.stl')

# the pocket's top edge is a rolled hem
lip = [pocket_outer(i / 12, 0.0) - Vector((0, 0, 0.6)) for i in range(13)]
lipob = new_object('pocket_lip', tube_along('pocket_lip', lip, [1.7] * 13, 10))
subdivide(lipob, 1)
shear_and_write(lipob, f'{out}/pocket_lip.stl')

# ---------- drawstrings: two cords from the collar front, hanging with a little swing, with aglets ----------
for name, sgn in (('cord_l', 1), ('cord_r', -1)):
    centres, radii = [], []
    n = 12
    for k in range(n):
        t = k / (n - 1)
        z = (NECK - 3) - 27 * t
        ang = FRONT + sgn * (6.0 + 3.0 * math.sin(math.pi * t * 0.85)) / radius(FRONT, z)
        centres.append(surf(ang, z, out_by=1.1 + 0.5 * math.sin(math.pi * t))); radii.append(1.5)
    for k in range(3):
        z = (NECK - 3) - 27 - 1.6 * (k + 1)
        ang = FRONT + sgn * 8.5 / radius(FRONT, z)
        centres.append(surf(ang, z, out_by=1.4)); radii.append(1.9)
    ob = new_object(name, tube_along(name, centres, radii, 10))
    subdivide(ob, 1)
    shear_and_write(ob, f'{out}/{name}.stl')

print('done')

"""
Horizon Drive — procedural car model generator for Blender (4.2+).

Builds the eight cars of the game as glTF binaries (assets/cars/<id>.glb).
Every body is a lofted mesh: cross-sections are generated from per-style
profile curves (width, sill, beltline, roof line, cabin), then subdivided,
wheel arches are cut with booleans, and detail parts (grille, mirrors, wing,
exhausts, diffuser, plates, interior) are added. Materials are named so the
game can re-bind them at runtime:

    Paint, Glass, Trim, Chrome, Headlight, Taillight, Grille, Interior,
    Tire, Rim, Brake, Caliper, Plate, Carbon, Reverse

Coordinates: Blender Z-up, car facing -Y, left side +X, ground at z = 0.
The exporter converts to glTF Y-up, which becomes three.js +Z forward.
Wheel centres must match the physics layout in src/Vehicle.js.

Usage (Blender as a Python module or blender --background --python):
    python build_cars.py -- <out_dir> [--thumbs] [--preview <png_dir>] [--only id,id]
    --thumbs also renders a studio thumbnail <out_dir>/<id>.png for the garage.
"""

import math
import os
import sys

import bpy  # noqa: I001  (bpy must be imported before bmesh when used as a module)
import bmesh
from mathutils import Matrix, Vector

# --------------------------------------------------------------------------
# Physics-matched layout (Blender coords: y = -three.z)
# --------------------------------------------------------------------------
WHEEL_R = 0.36
WHEEL_W = 0.27
FRONT_AXLE_Y = -1.36
REAR_AXLE_Y = 1.32
TRACK_F = 0.83
TRACK_R = 0.84

# --------------------------------------------------------------------------
# Styles. Profile keys are lists of (s, value), s = 0 nose … 1 tail.
# --------------------------------------------------------------------------
STYLES = {
    # Front-engine GT coupe with a long hood and fastback roof.
    'sakura-gt': dict(
        front=2.30, rear=2.26,
        w=[(0, .66), (.03, .80), (.08, .90), (.2, .935), (.42, .92), (.62, .935), (.78, .96), (.9, .93), (.97, .85), (1, .70)],
        zb=[(0, .30), (.05, .17), (.2, .14), (.82, .14), (.95, .20), (1, .34)],
        zbelt=[(0, .50), (.05, .62), (.15, .72), (.35, .80), (.6, .84), (.85, .88), (.96, .86), (1, .78)],
        ztop=[(0, .53), (.04, .66), (.12, .78), (.30, .88), (.36, .92), (.50, 1.27), (.60, 1.30), (.70, 1.22), (.86, .99), (.95, .93), (1, .80)],
        cabin=[(.32, 0), (.48, 1), (.66, 1), (.87, 0)],
        wg=.90, wr=.64, b_pillar=.62,
        windshield=(.35, .49), rear_window=(.67, .86),
        head=(.012, .07), tail=(.93, .995),
        wing='ducktail', exhaust='quad', mirror_s=.47, interior=(.44, .72),
    ),
    # Mid-engine supercar: cab-forward, very low and wide.
    'volta-r': dict(
        front=2.28, rear=2.30,
        w=[(0, .70), (.03, .84), (.1, .94), (.25, .95), (.45, .93), (.6, .98), (.78, 1.0), (.9, .97), (.97, .90), (1, .78)],
        zb=[(0, .24), (.05, .14), (.2, .12), (.85, .12), (.95, .18), (1, .30)],
        zbelt=[(0, .42), (.05, .54), (.18, .62), (.35, .72), (.55, .80), (.8, .84), (.95, .84), (1, .78)],
        ztop=[(0, .46), (.05, .58), (.18, .68), (.26, .74), (.40, 1.12), (.50, 1.15), (.58, 1.10), (.75, .96), (.90, .92), (1, .82)],
        cabin=[(.24, 0), (.38, 1), (.56, 1), (.72, 0)],
        wg=.86, wr=.58, b_pillar=.99,
        windshield=(.27, .40), rear_window=(.58, .72),
        head=(.012, .075), tail=(.935, .995),
        wing='lip', exhaust='center', mirror_s=.37, interior=(.36, .58),
    ),
    # 90s JDM drift coupe: boxier notchback with a taller greenhouse.
    'kaze-drift': dict(
        front=2.20, rear=2.24,
        w=[(0, .78), (.03, .86), (.1, .88), (.3, .89), (.6, .89), (.85, .89), (.96, .86), (1, .80)],
        zb=[(0, .26), (.04, .17), (.2, .15), (.85, .15), (.96, .20), (1, .30)],
        zbelt=[(0, .56), (.04, .64), (.2, .70), (.4, .74), (.7, .78), (.9, .80), (1, .76)],
        ztop=[(0, .58), (.04, .68), (.25, .76), (.32, .80), (.46, 1.28), (.66, 1.30), (.78, 1.08), (.82, .92), (.97, .90), (1, .78)],
        cabin=[(.30, 0), (.45, 1), (.69, 1), (.81, 0)],
        wg=.90, wr=.72, b_pillar=.58,
        windshield=(.32, .45), rear_window=(.69, .80),
        head=(.01, .06), tail=(.94, .995),
        wing='gt', exhaust='single', mirror_s=.44, interior=(.44, .72),
    ),
    # Rally hatchback: tall, short hatch, roof spoiler.
    'yama-rally': dict(
        front=2.12, rear=2.00,
        w=[(0, .76), (.03, .86), (.1, .92), (.3, .92), (.6, .93), (.8, .94), (.95, .90), (1, .82)],
        zb=[(0, .30), (.05, .20), (.2, .18), (.85, .18), (.95, .24), (1, .36)],
        zbelt=[(0, .60), (.05, .70), (.2, .78), (.35, .82), (.7, .88), (.95, .90), (1, .86)],
        ztop=[(0, .62), (.05, .74), (.22, .86), (.30, .90), (.45, 1.42), (.80, 1.44), (.88, 1.36), (.93, 1.10), (.97, .98), (1, .86)],
        cabin=[(.28, 0), (.44, 1), (.86, 1), (.94, .2), (.98, 0)],
        wg=.88, wr=.74, b_pillar=.62,
        windshield=(.30, .44), rear_window=(.88, .95),
        head=(.01, .07), tail=(.955, .998),
        wing='roof', exhaust='single_big', mirror_s=.42, interior=(.44, .82),
    ),
    # Hypercar: teardrop canopy, sculpted fenders, huge wing.
    'tenshi-x': dict(
        front=2.36, rear=2.36,
        w=[(0, .62), (.03, .82), (.1, .96), (.22, .99), (.4, .90), (.55, .92), (.72, 1.02), (.86, 1.0), (.96, .92), (1, .74)],
        zb=[(0, .20), (.05, .11), (.2, .10), (.85, .10), (.95, .16), (1, .26)],
        zbelt=[(0, .38), (.05, .50), (.15, .58), (.35, .66), (.6, .74), (.85, .80), (1, .74)],
        ztop=[(0, .42), (.05, .52), (.2, .62), (.28, .68), (.42, 1.08), (.52, 1.10), (.62, 1.02), (.78, .86), (.92, .84), (1, .76)],
        cabin=[(.26, 0), (.40, 1), (.54, 1), (.70, 0)],
        wg=.80, wr=.50, b_pillar=.99,
        windshield=(.28, .41), rear_window=(.56, .66),
        head=(.012, .07), tail=(.94, .995),
        wing='big', exhaust='twin_high', mirror_s=.39, interior=(.39, .56),
    ),
    # Rear-engine sports car in the 911 mould: short nose, round headlamps on
    # raised front wings, roof sloping all the way down to wide rear hips.
    'stuttgart-gt3': dict(
        front=2.02, rear=2.30,
        w=[(0, .60), (.04, .76), (.12, .85), (.25, .86), (.45, .84), (.62, .90), (.78, .99), (.9, .96), (.97, .87), (1, .72)],
        zb=[(0, .27), (.05, .15), (.2, .13), (.85, .13), (.95, .19), (1, .32)],
        zbelt=[(0, .46), (.05, .60), (.14, .68), (.35, .76), (.6, .80), (.82, .86), (.95, .84), (1, .76)],
        ztop=[(0, .50), (.04, .62), (.12, .70), (.26, .74), (.33, .82), (.46, 1.27), (.56, 1.28), (.70, 1.12), (.85, .97), (.95, .90), (1, .80)],
        cabin=[(.30, 0), (.44, 1), (.62, 1), (.85, 0)],
        wg=.88, wr=.62, b_pillar=.60,
        windshield=(.33, .46), rear_window=(.63, .83),
        head=(.015, .08), tail=(.94, .997),
        wing='gt', exhaust='center', mirror_s=.45, interior=(.42, .66),
    ),
    # Bavarian performance coupe in the M4 mould: long bonnet, tall twin
    # kidney grille, upright cabin, short flat boot with a lip spoiler.
    'bavaria-m4': dict(
        front=2.34, rear=2.22,
        w=[(0, .80), (.03, .88), (.1, .93), (.3, .94), (.6, .94), (.85, .95), (.96, .91), (1, .83)],
        zb=[(0, .30), (.04, .18), (.2, .16), (.85, .16), (.96, .22), (1, .33)],
        zbelt=[(0, .62), (.04, .70), (.2, .76), (.4, .80), (.7, .84), (.9, .86), (1, .82)],
        ztop=[(0, .64), (.04, .74), (.2, .80), (.32, .86), (.47, 1.34), (.64, 1.36), (.76, 1.12), (.81, .99), (.97, .97), (1, .86)],
        cabin=[(.32, 0), (.47, 1), (.68, 1), (.80, 0)],
        wg=.90, wr=.70, b_pillar=.60,
        windshield=(.33, .47), rear_window=(.68, .79),
        head=(.01, .065), tail=(.94, .995),
        wing='lip', exhaust='quad', grille='kidney', mirror_s=.46, interior=(.45, .72),
    ),
    # Italian V12 hypercar in the Huayra mould: rounded teardrop body, bubble
    # canopy, swollen front wings, quad centre exhaust, flap spoiler.
    'modena-hy': dict(
        front=2.34, rear=2.40,
        w=[(0, .64), (.03, .82), (.1, .97), (.2, 1.0), (.38, .91), (.55, .92), (.72, 1.02), (.86, 1.0), (.96, .91), (1, .76)],
        zb=[(0, .21), (.05, .12), (.2, .11), (.85, .11), (.95, .17), (1, .27)],
        zbelt=[(0, .40), (.05, .54), (.15, .64), (.35, .68), (.6, .76), (.85, .80), (1, .74)],
        ztop=[(0, .44), (.05, .56), (.18, .66), (.27, .70), (.41, 1.12), (.52, 1.14), (.62, 1.06), (.78, .90), (.92, .84), (1, .76)],
        cabin=[(.25, 0), (.39, 1), (.55, 1), (.71, 0)],
        wg=.82, wr=.52, b_pillar=.99,
        windshield=(.27, .40), rear_window=(.57, .68),
        head=(.012, .07), tail=(.94, .995),
        wing='lip', exhaust='center_quad', mirror_s=.38, interior=(.38, .57),
    ),
}

LOOP_POINTS = 9  # P1..P8 on each side + P0 bottom + P9 top
THUMBS = False


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def lerp(a, b, t):
    return a + (b - a) * t


def curve(keys, s):
    """Piecewise-linear profile sampling (subdivision smooths it later)."""
    if s <= keys[0][0]:
        return keys[0][1]
    for (s0, v0), (s1, v1) in zip(keys, keys[1:]):
        if s <= s1:
            t = (s - s0) / (s1 - s0) if s1 > s0 else 0
            return lerp(v0, v1, t)
    return keys[-1][1]


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


MATS = {}


def mat(name, color, metallic=0.0, roughness=0.5, emission=None, strength=0.0, alpha=1.0, coat=0.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1)
        bsdf.inputs['Emission Strength'].default_value = strength
    if alpha < 1:
        bsdf.inputs['Alpha'].default_value = alpha
        m.blend_method = 'BLEND'
    if coat:
        bsdf.inputs['Coat Weight'].default_value = coat
        bsdf.inputs['Coat Roughness'].default_value = 0.03
    MATS[name] = m
    return m


def make_materials():
    MATS.clear()
    return dict(
        Paint=mat('Paint', (0.6, 0.6, 0.62), 0.6, 0.3, coat=1.0),
        Glass=mat('Glass', (0.02, 0.025, 0.03), 0.0, 0.03, alpha=0.55),
        Trim=mat('Trim', (0.02, 0.02, 0.022), 0.1, 0.55),
        Chrome=mat('Chrome', (0.9, 0.9, 0.9), 1.0, 0.08),
        Headlight=mat('Headlight', (0.9, 0.92, 0.95), 0.2, 0.05, emission=(1, 0.97, 0.9), strength=2.0),
        Taillight=mat('Taillight', (0.35, 0.0, 0.01), 0.1, 0.15, emission=(1, 0.02, 0.05), strength=1.0),
        Reverse=mat('Reverse', (0.8, 0.8, 0.8), 0.1, 0.1),
        Grille=mat('Grille', (0.012, 0.012, 0.014), 0.3, 0.45),
        Interior=mat('Interior', (0.03, 0.03, 0.035), 0.0, 0.8),
        Tire=mat('Tire', (0.025, 0.025, 0.027), 0.0, 0.88),
        Rim=mat('Rim', (0.55, 0.56, 0.58), 1.0, 0.22),
        Brake=mat('Brake', (0.3, 0.3, 0.31), 1.0, 0.4),
        Caliper=mat('Caliper', (0.9, 0.08, 0.05), 0.2, 0.35),
        Plate=mat('Plate', (0.92, 0.92, 0.9), 0.0, 0.4),
        Carbon=mat('Carbon', (0.03, 0.03, 0.035), 0.4, 0.3, coat=1.0),
    )


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def new_obj(name, bm, materials):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in materials:
        me.materials.append(m)
    return link(bpy.data.objects.new(name, me))


def set_active(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifiers(obj):
    set_active(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def smooth(obj, angle=40):
    set_active(obj)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle))


def primitive(kind, name, material, **kw):
    getattr(bpy.ops.mesh, f'primitive_{kind}_add')(**kw)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.clear()
    o.data.materials.append(material)
    return o


# --------------------------------------------------------------------------
# Body loft
# --------------------------------------------------------------------------
def section_points(st, s):
    w = curve(st['w'], s)
    zb = curve(st['zb'], s)
    zbelt = curve(st['zbelt'], s)
    ztop = curve(st['ztop'], s)
    c = curve(st['cabin'], s) if st['cabin'][0][0] <= s <= st['cabin'][-1][0] else 0.0
    c = c * c * (3 - 2 * c)
    wb = w * 0.965
    top = max(ztop, zbelt + 0.02)

    def crown(f):
        return zbelt + (top - zbelt) * (1 - f * f)

    hood = [(wb * 0.75, crown(0.75)), (wb * 0.5, crown(0.5)), (wb * 0.25, crown(0.25))]
    cab = [(wb * st['wg'], zbelt + 0.035), (wb * st['wr'], top - 0.06), (wb * st['wr'] * 0.5, top - 0.008)]
    green = [(lerp(h[0], k[0], c), lerp(h[1], k[1], c)) for h, k in zip(hood, cab)]

    right = [
        (w * 0.86, zb),
        (w * 0.975, zb + 0.07),
        (w, zb + (zbelt - zb) * 0.42),
        (w * 0.985, zbelt - 0.05),
        (wb, zbelt),
        *green,
    ]
    loop = [(0.0, zb)] + right + [(0.0, top)] + [(-x, z) for (x, z) in reversed(right)]
    return loop, c


def pidx(i):
    """Loop index → profile point index (0..9) mirrored."""
    return i if i <= 9 else 18 - i


def body_mesh(st, M):
    n_sec = 64
    # denser sampling near the ends (rounded nose/tail)
    ss = [0.5 - 0.5 * math.cos(math.pi * k / (n_sec - 1)) for k in range(n_sec)]
    y0, y1 = -st['front'], st['rear']
    bm = bmesh.new()
    loops = []
    cabs = []
    for s in ss:
        pts, c = section_points(st, s)
        y = lerp(y0, y1, s)
        loops.append([bm.verts.new((x, y, z)) for (x, z) in pts])
        cabs.append(c)
    order = ['Paint', 'Glass', 'Trim', 'Headlight', 'Taillight', 'Grille', 'Interior', 'Chrome', 'Reverse']
    mi = {n: i for i, n in enumerate(order)}
    L = len(loops[0])
    for k in range(n_sec - 1):
        s_mid = (ss[k] + ss[k + 1]) / 2
        c_mid = (cabs[k] + cabs[k + 1]) / 2
        for i in range(L):
            j = (i + 1) % L
            f = bm.faces.new((loops[k][i], loops[k][j], loops[k + 1][j], loops[k + 1][i]))
            band = min(pidx(i), pidx(j))
            m = 'Paint'
            if band == 0:
                m = 'Trim'
            elif band == 1 and 0.08 < s_mid < 0.92:
                m = 'Trim'  # rocker / side skirt
            elif band in (1, 2) and s_mid < 0.035:
                m = 'Grille'
            elif band in (4, 5) and st['head'][0] < s_mid < st['head'][1]:
                m = 'Headlight'
            elif band == 4 and st['tail'][0] < s_mid < st['tail'][1]:
                m = 'Taillight'
            elif band == 6 and c_mid > 0.85 and abs(s_mid - st['b_pillar']) > 0.018:
                m = 'Glass'
            elif band in (7, 8) and (st['windshield'][0] < s_mid < st['windshield'][1] or
                                     st['rear_window'][0] < s_mid < st['rear_window'][1]):
                m = 'Glass'
            elif band == 7 and c_mid > 0.85 and st['wing'] != 'roof':
                m = 'Paint'
            f.material_index = mi[m]
    # End caps
    for lp, flip in ((loops[0], True), (loops[-1], False)):
        f = bm.faces.new(list(reversed(lp)) if flip else lp)
        f.material_index = mi['Paint']
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = new_obj('Body', bm, [M[n] for n in order])
    sub = obj.modifiers.new('sub', 'SUBSURF')
    sub.levels = 2
    sub.render_levels = 2
    apply_modifiers(obj)
    return obj


def cut_arches(body, M):
    cutters = []
    for (y, tx) in ((FRONT_AXLE_Y, TRACK_F), (REAR_AXLE_Y, TRACK_R)):
        for sx in (-1, 1):
            c = primitive('cylinder', 'arch', M['Trim'], vertices=48, radius=WHEEL_R + 0.055,
                          depth=0.8, location=(sx * (tx + 0.25), y, WHEEL_R + 0.02),
                          rotation=(0, math.radians(90), 0))
            cutters.append(c)
    set_active(cutters[0])
    for c in cutters[1:]:
        c.select_set(True)
    bpy.context.view_layer.objects.active = cutters[0]
    bpy.ops.object.join()
    cutter = bpy.context.active_object
    mod = body.modifiers.new('arches', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = 'EXACT'
    mod.object = cutter
    mod.material_mode = 'TRANSFER'
    apply_modifiers(body)
    bpy.data.objects.remove(cutter, do_unlink=True)


# --------------------------------------------------------------------------
# Detail parts
# --------------------------------------------------------------------------
def body_height_at(st, s, band='top'):
    return curve(st['ztop'] if band == 'top' else st['zbelt'], s)


def s_of_y(st, y):
    return (y + st['front']) / (st['front'] + st['rear'])


def y_of_s(st, s):
    return lerp(-st['front'], st['rear'], s)


def add_details(st, M, parts):
    nose_y = -st['front']
    tail_y = st['rear']

    # Front intake / grille insert
    zb0 = curve(st['zb'], 0.03)
    if st.get('grille') == 'kidney':
        # two tall kidney grilles framed in chrome, plus a wide lower intake
        for sx in (-1, 1):
            k = primitive('cube', 'Grille', M['Grille'], size=1, location=(sx * 0.17, nose_y - 0.02, zb0 + 0.27))
            k.scale = (0.3, 0.12, 0.36)
            bev = k.modifiers.new('b', 'BEVEL'); bev.width = 0.06; bev.segments = 3
            parts.append(k)
            f = primitive('cube', 'KidneyFrame', M['Chrome'], size=1, location=(sx * 0.17, nose_y - 0.015, zb0 + 0.27))
            f.scale = (0.33, 0.11, 0.39)
            bev = f.modifiers.new('b', 'BEVEL'); bev.width = 0.07; bev.segments = 3
            parts.append(f)
        g = primitive('cube', 'Grille', M['Grille'], size=1, location=(0, nose_y + 0.14, zb0 + 0.05))
        g.scale = (curve(st['w'], 0.03) * 1.1, 0.1, 0.08)
        parts.append(g)
    else:
        g = primitive('cube', 'Grille', M['Grille'], size=1, location=(0, nose_y + 0.10, zb0 + 0.12))
        g.scale = (curve(st['w'], 0.03) * 1.25, 0.12, 0.13)
        bev = g.modifiers.new('b', 'BEVEL')
        bev.width = 0.03
        bev.segments = 2
        parts.append(g)

    # Splitter
    sp = primitive('cube', 'Splitter', M['Carbon'], size=1, location=(0, nose_y + 0.16, zb0 - 0.02))
    sp.scale = (curve(st['w'], 0.05) * 1.9, 0.26, 0.025)
    parts.append(sp)

    # Rear diffuser with fins
    zr = curve(st['zb'], 0.97)
    d = primitive('cube', 'Diffuser', M['Carbon'], size=1, location=(0, tail_y - 0.12, zr + 0.03))
    d.scale = (curve(st['w'], 0.97) * 1.5, 0.28, 0.1)
    parts.append(d)
    for fx in (-0.3, -0.1, 0.1, 0.3):
        f = primitive('cube', 'Fin', M['Carbon'], size=1, location=(fx, tail_y - 0.12, zr - 0.02))
        f.scale = (0.015, 0.26, 0.1)
        parts.append(f)

    # License plates
    for (y, s, rot) in ((nose_y - 0.005, 0.02, 0), (tail_y + 0.005, 0.985, math.pi)):
        z = lerp(curve(st['zb'], s), curve(st['zbelt'], s), 0.45)
        p = primitive('plane', 'Plate', M['Plate'], size=1, location=(0, y, z),
                      rotation=(math.radians(90), 0, rot))
        p.scale = (0.52, 0.12, 1)
        parts.append(p)

    # Mirrors on stalks near the A-pillar base
    ms = st['mirror_s']
    my = y_of_s(st, ms)
    mz = curve(st['zbelt'], ms) + 0.1
    mw = curve(st['w'], ms)
    for sx in (-1, 1):
        stalk = primitive('cube', 'MirrorStalk', M['Trim'], size=1, location=(sx * (mw * 0.98), my, mz - 0.03))
        stalk.scale = (0.12, 0.05, 0.03)
        parts.append(stalk)
        head = primitive('uv_sphere', 'Mirror', M['Paint'], segments=16, ring_count=8, radius=1,
                         location=(sx * (mw + 0.1), my + 0.02, mz))
        head.scale = (0.11, 0.07, 0.06)
        parts.append(head)

    # Exhausts
    ex = st['exhaust']
    z_ex = curve(st['zb'], 0.98) + 0.12
    tips = {
        'quad': [(-0.42, z_ex), (-0.3, z_ex), (0.3, z_ex), (0.42, z_ex)],
        'center': [(-0.07, z_ex + 0.08), (0.07, z_ex + 0.08)],
        'single': [(0.45, z_ex)],
        'single_big': [(-0.45, z_ex)],
        'center_quad': [(-0.11, z_ex + 0.1), (0.11, z_ex + 0.1), (-0.11, z_ex - 0.02), (0.11, z_ex - 0.02)],
        'twin_high': [(-0.12, curve(st['zbelt'], 0.98) - 0.05), (0.12, curve(st['zbelt'], 0.98) - 0.05)],
    }[ex]
    r = 0.075 if ex == 'single_big' else 0.05
    for (x, z) in tips:
        t = primitive('cylinder', 'Exhaust', M['Chrome'], vertices=20, radius=r, depth=0.22,
                      location=(x, tail_y - 0.02, z), rotation=(math.radians(90), 0, 0))
        parts.append(t)
        inner = primitive('cylinder', 'ExhaustIn', M['Trim'], vertices=20, radius=r * 0.8, depth=0.225,
                          location=(x, tail_y - 0.019, z), rotation=(math.radians(90), 0, 0))
        parts.append(inner)

    # Reverse lights
    for sx in (-1, 1):
        rl = primitive('cube', 'ReverseLight', M['Reverse'], size=1,
                       location=(sx * 0.5, tail_y - 0.02, curve(st['zb'], 0.98) + 0.22))
        rl.scale = (0.12, 0.05, 0.035)
        parts.append(rl)

    # Wing / spoiler
    wing = st['wing']
    wy = y_of_s(st, 0.95)
    deck = curve(st['ztop'], 0.95)
    if wing == 'ducktail':
        dt = primitive('cube', 'Ducktail', M['Paint'], size=1, location=(0, tail_y - 0.18, curve(st['ztop'], 0.96) + 0.02))
        dt.scale = (curve(st['w'], 0.96) * 1.6, 0.22, 0.05)
        dt.rotation_euler = (math.radians(12), 0, 0)
        b = dt.modifiers.new('b', 'BEVEL'); b.width = 0.02; b.segments = 3
        parts.append(dt)
    elif wing == 'lip':
        lp = primitive('cube', 'Lip', M['Carbon'], size=1, location=(0, tail_y - 0.1, deck + 0.03))
        lp.scale = (1.6, 0.14, 0.03)
        lp.rotation_euler = (math.radians(15), 0, 0)
        parts.append(lp)
    elif wing in ('gt', 'big'):
        h = 0.32 if wing == 'gt' else 0.42
        span = 1.62 if wing == 'gt' else 1.9
        chord = 0.3 if wing == 'gt' else 0.42
        blade = primitive('cube', 'Wing', M['Carbon'], size=1, location=(0, wy, deck + h))
        blade.scale = (span, chord, 0.035)
        blade.rotation_euler = (math.radians(-8), 0, 0)
        b = blade.modifiers.new('b', 'BEVEL'); b.width = 0.015; b.segments = 3
        parts.append(blade)
        for sx in (-1, 1):
            ep = primitive('cube', 'Endplate', M['Carbon'], size=1, location=(sx * span / 2, wy, deck + h))
            ep.scale = (0.02, chord * 1.2, 0.16)
            parts.append(ep)
            strut = primitive('cube', 'Strut', M['Trim'], size=1, location=(sx * span * 0.3, wy + 0.04, deck + h / 2))
            strut.scale = (0.03, 0.12, h)
            parts.append(strut)
    elif wing == 'roof':
        rs = primitive('cube', 'RoofSpoiler', M['Paint'], size=1, location=(0, y_of_s(st, 0.875), curve(st['ztop'], 0.86) + 0.01))
        rs.scale = (curve(st['w'], 0.86) * 1.45, 0.24, 0.04)
        rs.rotation_euler = (math.radians(-10), 0, 0)
        b = rs.modifiers.new('b', 'BEVEL'); b.width = 0.015; b.segments = 3
        parts.append(rs)
        # rally mud flaps
        for sx in (-1, 1):
            mf = primitive('cube', 'MudFlap', M['Trim'], size=1, location=(sx * TRACK_R, REAR_AXLE_Y + 0.5, 0.2))
            mf.scale = (0.26, 0.02, 0.26)
            parts.append(mf)

    # Interior: dash, seats, steering wheel (visible through tinted glass)
    i0, i1 = st['interior']
    y_a, y_b = y_of_s(st, i0), y_of_s(st, i1)
    zbelt_mid = curve(st['zbelt'], (i0 + i1) / 2)
    tub = primitive('cube', 'Tub', M['Interior'], size=1, location=(0, (y_a + y_b) / 2, zbelt_mid - 0.12))
    tub.scale = (curve(st['w'], (i0 + i1) / 2) * 1.7, abs(y_b - y_a), 0.3)
    parts.append(tub)
    for sx in (-1, 1):
        seat = primitive('cube', 'Seat', M['Interior'], size=1, location=(sx * 0.36, lerp(y_a, y_b, 0.62), zbelt_mid + 0.1))
        seat.scale = (0.46, 0.12, 0.62)
        seat.rotation_euler = (math.radians(-14), 0, 0)
        b = seat.modifiers.new('b', 'BEVEL'); b.width = 0.05; b.segments = 3
        parts.append(seat)
    sw = primitive('torus', 'SteeringWheel', M['Interior'], major_radius=0.17, minor_radius=0.02,
                   location=(0.36, lerp(y_a, y_b, 0.22), zbelt_mid + 0.12), rotation=(math.radians(70), 0, 0))
    parts.append(sw)


# --------------------------------------------------------------------------
# Wheel (built once per car so rim styles can differ)
# --------------------------------------------------------------------------
def build_wheel(M, spokes=5, style='split'):
    parts = []
    # Tyre: lathed profile (rounded sidewalls, open centre so the rim shows)
    R, hw = WHEEL_R, WHEEL_W / 2
    profile = [(0.69 * R, -hw + 0.012), (0.8 * R, -hw - 0.004), (0.9 * R, -hw), (0.97 * R, -hw + 0.02),
               (R, -hw + 0.05), (R, hw - 0.05), (0.97 * R, hw - 0.02), (0.9 * R, hw), (0.8 * R, hw + 0.004),
               (0.69 * R, hw - 0.012)]
    seg = 56
    bm = bmesh.new()
    rings = []
    for (r, x) in profile:
        rings.append([bm.verts.new((x, r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg)))
                      for k in range(seg)])
    for a0, a1 in zip(rings, rings[1:]):
        for k in range(seg):
            bm.faces.new((a0[k], a0[(k + 1) % seg], a1[(k + 1) % seg], a1[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    tire = new_obj('Tire', bm, [M['Tire']])
    parts.append(tire)
    lip_x = WHEEL_W / 2 - 0.01
    lip = primitive('torus', 'RimLip', M['Rim'], major_radius=WHEEL_R * 0.7, minor_radius=0.014,
                    major_segments=48, minor_segments=8, location=(lip_x, 0, 0), rotation=(0, math.radians(90), 0))
    parts.append(lip)
    barrel = primitive('cylinder', 'Barrel', M['Rim'], vertices=40, radius=WHEEL_R * 0.69, depth=WHEEL_W * 0.9,
                       rotation=(0, math.radians(90), 0))
    parts.append(barrel)
    face = primitive('cylinder', 'RimFace', M['Trim'], vertices=40, radius=WHEEL_R * 0.66, depth=0.01,
                     location=(lip_x - 0.05, 0, 0), rotation=(0, math.radians(90), 0))
    parts.append(face)
    rr = WHEEL_R * 0.66
    for k in range(spokes):
        a = 2 * math.pi * k / spokes
        for off in ((-0.06, 0.06) if style == 'split' else (0,)):
            sp = primitive('cube', 'Spoke', M['Rim'], size=1)
            sp.scale = (0.035, 0.045 if style == 'split' else 0.07, rr * 0.92)
            sp.location = (lip_x - 0.02, 0, 0)
            sp.rotation_euler = (a + off, 0, 0)
            # move outward along the spoke direction
            d = Vector((0, -math.sin(a + off), math.cos(a + off))) * (rr * 0.5)
            sp.location = Vector((lip_x - 0.02, 0, 0)) + d
            b = sp.modifiers.new('b', 'BEVEL'); b.width = 0.008; b.segments = 2
            parts.append(sp)
    hub = primitive('cylinder', 'Hub', M['Chrome'], vertices=20, radius=0.055, depth=0.05,
                    location=(lip_x - 0.01, 0, 0), rotation=(0, math.radians(90), 0))
    parts.append(hub)
    disc = primitive('cylinder', 'Disc', M['Brake'], vertices=40, radius=WHEEL_R * 0.55, depth=0.03,
                     location=(lip_x - 0.1, 0, 0), rotation=(0, math.radians(90), 0))
    parts.append(disc)
    for p in parts:
        apply_modifiers(p)
    set_active(parts[0])
    for p in parts[1:]:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    wheel = bpy.context.active_object
    wheel.name = 'Wheel'
    smooth(wheel, 35)

    cal = primitive('cube', 'Caliper', M['Caliper'], size=1, location=(lip_x - 0.1, 0.1, 0.12))
    cal.scale = (0.07, 0.2, 0.1)
    cal.rotation_euler = (math.radians(-40), 0, 0)
    b = cal.modifiers.new('b', 'BEVEL'); b.width = 0.02; b.segments = 2
    apply_modifiers(cal)
    smooth(cal)
    return wheel, cal


# --------------------------------------------------------------------------
# Build + export
# --------------------------------------------------------------------------
RIMS = {
    'sakura-gt': (5, 'split'), 'volta-r': (10, 'single'), 'kaze-drift': (6, 'single'),
    'yama-rally': (5, 'single'), 'tenshi-x': (7, 'split'),
    'stuttgart-gt3': (5, 'single'), 'bavaria-m4': (10, 'split'), 'modena-hy': (16, 'single'),
}


def build_car(car_id, out_dir, preview_dir=None):
    clear_scene()
    st = STYLES[car_id]
    M = make_materials()
    body = body_mesh(st, M)
    cut_arches(body, M)
    smooth(body, 42)

    parts = []
    add_details(st, M, parts)
    for p in parts:
        apply_modifiers(p)
        smooth(p, 40)
    set_active(parts[0])
    for p in parts[1:]:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    details = bpy.context.active_object
    details.name = 'Details'

    wheel, caliper = build_wheel(M, *RIMS[car_id])

    root = bpy.data.objects.new(car_id, None)
    link(root)
    for o in (body, details, wheel, caliper):
        o.parent = root

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f'{car_id}.glb')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_yup=True, export_apply=True, export_texcoords=False,
                              export_normals=True, export_materials='EXPORT', export_cameras=False)
    tris = sum(len(o.data.polygons) for o in (body, details, wheel, caliper))
    print(f'[build_cars] {car_id}: {tris} polys → {path} ({os.path.getsize(path) // 1024} KB)')

    if preview_dir:
        render_preview(car_id, root, wheel, caliper, preview_dir)
    elif THUMBS:
        render_thumbnail(car_id, wheel, caliper, out_dir)


def render_preview(car_id, root, wheel, caliper, preview_dir):
    # Place 4 wheels for the preview
    for (y, tx) in ((FRONT_AXLE_Y, TRACK_F), (REAR_AXLE_Y, TRACK_R)):
        for sx in (-1, 1):
            w = wheel.copy()
            link(w)
            w.location = (sx * tx, y, WHEEL_R)
            w.scale = (sx, 1, 1)
    wheel.hide_render = True
    caliper.hide_render = True
    MATS['Paint'].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.55, 0.02, 0.05, 1)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.render.resolution_x = 640
    scene.render.resolution_y = 360
    world = bpy.data.worlds.new('W')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.6, 0.7, 0.85, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
    scene.world = world
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    link(sun)
    bpy.ops.mesh.primitive_plane_add(size=40)
    floor = bpy.context.active_object
    floor.data.materials.append(mat('Floor', (0.25, 0.25, 0.26), 0, 0.8))
    for i, (loc, name) in enumerate((((-5.2, -5.6, 1.9), 'front'), ((5.5, 4.8, 2.1), 'rear'), ((-7, 0.0, 1.0), 'side'))):
        cam = bpy.data.objects.new(f'Cam{i}', bpy.data.cameras.new(f'Cam{i}'))
        link(cam)
        cam.location = loc
        direction = Vector((0, 0, 0.55)) - Vector(loc)
        cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = 40
        scene.camera = cam
        scene.render.filepath = os.path.join(preview_dir, f'{car_id}-{name}.png')
        bpy.ops.render.render(write_still=True)


FACTORY_PAINT = {
    'sakura-gt': (0.58, 0.6, 0.64), 'volta-r': (0.55, 0.12, 0.02), 'kaze-drift': (1.0, 0.03, 0.27),
    'yama-rally': (0.01, 0.16, 0.83), 'tenshi-x': (0.9, 0.9, 0.9),
    'stuttgart-gt3': (0.02, 0.22, 0.08), 'bavaria-m4': (0.3, 0.45, 0.02), 'modena-hy': (0.04, 0.05, 0.07),
}


def render_thumbnail(car_id, wheel, caliper, out_dir):
    """Studio 3/4 render with transparent background for the garage UI."""
    for (y, tx) in ((FRONT_AXLE_Y, TRACK_F), (REAR_AXLE_Y, TRACK_R)):
        for sx in (-1, 1):
            w = wheel.copy()
            link(w)
            w.location = (sx * tx, y, WHEEL_R)
            w.rotation_euler = (0, 0, 0 if sx > 0 else math.pi)
    wheel.hide_render = True
    caliper.hide_render = True
    MATS['Paint'].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*FACTORY_PAINT[car_id], 1)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 48
    scene.cycles.use_denoising = False
    scene.render.resolution_x = 640
    scene.render.resolution_y = 300
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('Studio')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.75, 0.8, 0.9, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.1
    scene.world = world
    key = bpy.data.objects.new('Key', bpy.data.lights.new('Key', 'AREA'))
    key.data.energy = 900
    key.data.size = 6
    key.location = (-4, -5, 6)
    key.rotation_euler = (math.radians(45), 0, math.radians(-40))
    link(key)
    rim = bpy.data.objects.new('Rim', bpy.data.lights.new('Rim', 'AREA'))
    rim.data.energy = 500
    rim.data.size = 5
    rim.location = (5, 5, 4)
    rim.rotation_euler = (math.radians(-50), 0, math.radians(140))
    link(rim)
    cam = bpy.data.objects.new('ThumbCam', bpy.data.cameras.new('ThumbCam'))
    link(cam)
    cam.location = (-5.6, -6.2, 2.1)
    cam.rotation_euler = (Vector((0, 0.1, 0.6)) - Vector(cam.location)).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 50
    scene.camera = cam
    scene.render.filepath = os.path.join(out_dir, f'{car_id}.png')
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'cars')
    preview = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else list(STYLES)
    THUMBS = '--thumbs' in argv
    for cid in only:
        build_car(cid, out, preview)

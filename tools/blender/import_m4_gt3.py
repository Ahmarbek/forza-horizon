"""
Convert the BMW M4 GT3 EVO (G82) glTF into a Horizon Drive car model.

    python import_m4_gt3.py -- <source.glb> <out.glb>

- applies all transforms, drops the stray helper icosphere
- scales the body so its wheelbase matches the physics layout in
  src/Vehicle.js (front axle y = -1.36, rear y = +1.32, Blender coords)
- keeps one front-left tyre + hub + disc as `Wheel` (centred on the
  origin, scaled to the physics wheel radius) and its brake as `Caliper`;
  the game clones them onto all four corners
- everything else is joined into `Body`; the original materials and
  textures (livery, lights, glass) are kept
"""
import sys
import bpy
from mathutils import Matrix, Vector

FRONT_AXLE_Y, REAR_AXLE_Y, WHEEL_R = -1.36, 1.32, 0.36

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
bpy.context.view_layer.update()

for o in list(bpy.data.objects):
    if o.name.startswith('Icosphere'):
        bpy.data.objects.remove(o, do_unlink=True)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in meshes:
    mw = o.matrix_world.copy()
    if o.data.users > 1:
        o.data = o.data.copy()
    o.parent = None
    o.data.transform(mw)
    o.matrix_world = Matrix.Identity(4)
for o in list(bpy.data.objects):
    if o.type != 'MESH':
        bpy.data.objects.remove(o, do_unlink=True)


def bbox(o):
    ws = [v.co for v in o.data.vertices]
    return (Vector([min(w[i] for w in ws) for i in range(3)]), Vector([max(w[i] for w in ws) for i in range(3)]))


def centre(o):
    a, b = bbox(o)
    return (a + b) / 2


tires = [o for o in bpy.data.objects if 'Wheel1A' in o.name or o.name.startswith('polySurface')]
fl = max((t for t in tires if centre(t).y < 0), key=lambda t: centre(t).x)
rl = max((t for t in tires if centre(t).y > 0), key=lambda t: centre(t).x)
a, b = bbox(fl)
wc = centre(fl)
rc = (b.z - a.z) / 2
yF, yR = wc.y, centre(rl).y
s = (REAR_AXLE_Y - FRONT_AXLE_Y) / (yR - yF)
s_wheel = WHEEL_R / rc
print(f'[m4] axles {yF:.4f}/{yR:.4f} radius {rc:.4f} → body scale {s:.2f}, wheel scale {s_wheel:.2f}')


def near_fl(o, r):
    c = centre(o)
    return (c - wc).length < r


# wheel parts at the front-left corner, and the corner parts we drop (the game clones the wheel)
wheel_parts, caliper, drop = [], None, []
for o in bpy.data.objects:
    n = o.name
    corner = ('Hub' in n or 'Disk' in n or o in tires)
    if 'Brake_' in n:
        if near_fl(o, rc * 1.5):
            caliper = o
        else:
            drop.append(o)
    elif corner:
        (wheel_parts if near_fl(o, rc * 1.5) else drop).append(o)
for o in drop:
    bpy.data.objects.remove(o, do_unlink=True)


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    j = bpy.context.view_layer.objects.active
    j.name = name
    return j


wheel = join(wheel_parts, 'Wheel')
wheel.data.transform(Matrix.Translation(-wc))
wheel.data.transform(Matrix.Scale(s_wheel, 4))
if caliper:
    caliper.name = 'Caliper'
    caliper.data.transform(Matrix.Translation(-wc))
    caliper.data.transform(Matrix.Scale(s_wheel, 4))

body = join([o for o in bpy.data.objects if o.type == 'MESH' and o.name not in ('Wheel', 'Caliper')], 'Body')
# axle line to the physics layout; lift so the arches sit round the (larger) physics wheel
body.data.transform(Matrix.Translation(Vector((0, -yF, -wc.z))))
body.data.transform(Matrix.Scale(s, 4))
body.data.transform(Matrix.Translation(Vector((0, FRONT_AXLE_Y, WHEEL_R))))
root = bpy.data.objects.new('bavaria-m4', None)
bpy.context.scene.collection.objects.link(root)
for o in (body, wheel, caliper):
    if o:
        o.parent = root
a, b = bbox(body)
print(f'[m4] body extents x {a.x:.2f}..{b.x:.2f} y {a.y:.2f}..{b.y:.2f} z {a.z:.2f}..{b.z:.2f}, polys {len(body.data.polygons)}')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_yup=True,
                          export_apply=True, export_materials='EXPORT', export_cameras=False, export_image_format='AUTO')
print('[m4] wrote', out)

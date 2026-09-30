# Horizon Drive — Sakura Festival

A Forza Horizon–inspired open-world racing game that runs in the browser. It's
built with **Three.js** and **Rapier** physics, with a vanilla HTML/CSS
glassmorphic HUD. There is no build step. The world, textures, sound and music
are all generated in code, and the cars are 3D models built with a Blender
script that's included in the repo.

## Run

ES modules must be served over HTTP; opening `index.html` from `file://` won't work:

```bash
npm start                  # npx http-server on http://localhost:8080
# or
python3 -m http.server 8080
```

The first load builds the whole world (terrain, roads, trees, impostor atlas),
which takes a few seconds on a desktop GPU.

## What's in the game

### An 8 km × 8 km open world

| Region | What's there |
| --- | --- |
| **Festival Site** | The Sakura festival hub: stages, Ferris wheel, lanterns and the Festival Loop circuit |
| **Neon City** | A 1 km² downtown grid of glass towers, neon signs, billboards and traffic lights |
| **Sea of Sakura coast** | Cliff roads, Sunset Beach with umbrellas, and an ocean with foam and depth colour |
| **Minato Bay** | A harbour town with warehouses, a breakwater, a lighthouse (its beam sweeps at night) and moored boats |
| **Sakura Village farmland** | Paddy and crop fields, dirt lanes and traditional minka farmhouses |
| **Lake Sakura** | A lake loop with a vermilion bridge, a five-storey pagoda and a torii standing in the water |
| **Wind farm downs** | Rolling hills with turning wind turbines and blinking beacons |
| **Fuji Pass & the Summit** | A mountain pass and a 12 % hill-climb to a snowy observatory |
| **Kiso Forest** | Gravel rally stages through dense pine forest |
| **Airfield** | A 1.4 km runway with hangars, a control tower, runway lights and a launch ramp |

Roads are generated from spline centre-lines. The world includes:

- automatic bridges and viaducts wherever a road crosses water or a valley
- road profiles held to a grade limit and smoothed with vertical curves, so
  crests don't launch you
- banked cuttings and embankments that blend into the terrain
- junctions and at-grade crossings resolved so every road meets its neighbours at the same height

A snowy Fuji-style peak and distant ranges sit beyond the playable area.

### Physics

- A **raycast vehicle** with per-wheel spin simulated in 4 sub-steps.
- A **combined-slip tyre model** (a "magic formula" curve). Braking and
  cornering share the same grip, so trail-braking, power oversteer and
  handbrake turns behave as they should.
- A **simulated drivetrain:**
  - torque curves and real gear ratios
  - a clutch for launches
  - a limited-slip differential
  - engine braking
  - automatic or manual gears (`Q` / `E`), with backfire on hard upshifts
- **Aerodynamics:** drag that sets each car's top speed, and per-axle downforce.
- **Surfaces:** asphalt, concrete, gravel, dirt, grass, sand, snow and rock.
  Each has its own grip, rolling resistance and roughness. Off-road-biased
  cars (like the Yama Rally) lose less grip on loose ground.
- **Driver aids you can switch off:** ABS, traction control, stability
  control and steering assist.
- The body leans visibly with weight transfer and shakes on rough ground.
- **Five cars with distinct handling**, from the planted Volta R and Tenshi X
  hypercars to the tail-happy Kaze Drift.

### Events and activities

- **14 events**, each started from a light-column beacon in the world
  (drive in and press `Enter`) or from the Festival tab:
  - **Road races:** Sakura Circuit, Festival Sprint, Horizon Highway,
    Coastal Circuit, Lakeside Loop
  - **Street races:** Neon City, Minato Harbour GP
  - **Mountain race:** Fuji Pass
  - **Sprint:** Summit Hill Climb
  - **Dirt race:** Kiso Forest Rally
  - **Drag race:** Airfield Drag
  - **Time trials:** Hanami, Neon Time Attack, Sakura Bridge
- Races have up to 5 AI rivals that use the same physics. They include:
  - a live leaderboard with gaps
  - checkpoints and a wrong-way warning
  - results and payouts
  - three difficulty levels
- **19 PR stunts around the map:** 8 speed traps, 4 speed zones, 4 drift
  zones and 3 ramp jumps, each rated 1–3 stars.
- **Skill chains:** drift, speed, air, cone smashes and clean driving build a
  multiplier. A crash breaks the chain.
- **Progression:** credits, XP and levels. You can buy 5 cars and upgrade the
  engine, tyres and brakes. Everything is saved automatically.
- **Traffic** drives the highway, the towns, the coast and the lake.

### Rendering

- **Trees** are procedurally modelled in several species: broadleaf, pine,
  sakura and maple, 10 variants in all. Each has:
  - branching bark trunks and leaf-cluster crowns
  - baked ambient occlusion, back-lit translucency and wind sway
- **Distant trees** use an octahedral impostor atlas, rendered from the real
  models at load time. As you drive, the atlas is swapped for full models
  within 230 m.
- **Terrain** blends grass, forest floor, farmland, sand, rock and snow from
  mask textures, with detail normals and tree-shade darkening. It uses a
  level-of-detail tile mesh with skirts.
- **Water:** the ocean and the lake have fractal normals, depth-based colour,
  shoreline foam and sky reflections.
- **Height fog** with sun in-scattering, over a physical sky with clouds, a
  day/night cycle, stars and a moon.
- **Tyre effects:** persistent skid marks; smoke, dust and gravel spray tinted
  to the surface; sparks when scraping; exhaust flames.
- **Dynamic reflections** in the car paint.
- Bloom, colour grading, speed blur and soft shadows.
- **Quality presets** (Ultra / High / Medium / Low) plus per-setting control.

### UI

- **HUD:**
  - a tachometer with gear, redline and TCS/ABS indicator lights
  - a rotating minimap with GPS route line and event flags
  - region name pop-ups
  - an in-world event prompt
  - a race leaderboard
- **Festival tab:** an event browser with filters (races, sprints & drag,
  time trials) and thumbnails rendered from each route.
- **Interactive world map:**
  - zoom, pan and follow
  - hover tooltips
  - click an event to start it or set a GPS route to it
  - click anywhere to set a waypoint
  - fast travel to 10 locations
- **GPS:** shortest-path routing over the road network (Dijkstra), shown on
  the minimap with the distance remaining.
- **Settings** are grouped into Driving (assists, transmission, AI difficulty,
  traffic), Graphics (presets, shadows, grass, resolution, reflections, bloom,
  blur, time of day) and Audio.

## Controls

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Throttle / Brake / Reverse | `W` `S` or `↑` `↓` | RT / LT | GAS / BRAKE |
| Steer | `A` `D` or `←` `→` | Left stick | ◀ ▶ |
| Handbrake (drift) | `Space` | A | HB |
| Shift up / down (manual) | `E` / `Q` | B / X | — |
| Start nearby event | `Enter` or `F` | D-pad ↑ | — |
| World map | `Tab` | — | ☰ → Map |
| Menu | `Esc` | Start | ☰ |
| Menu tabs / navigate / select | `Q` `E` / mouse | LB RB / D-pad / A | tap |
| Camera (chase / far / bumper) | `C` | View | — |
| Reset to road | `R` | Y | — |
| Radio on/off | `M` | — | Settings |

## Project layout

```
├── index.html               Loader, HUD, results, menu markup, import map
├── styles/ui.css            Glassmorphic HUD, race board, festival/map/settings layouts, touch
├── assets/cars/             Blender-built car models (.glb) + garage thumbnails (.png)
├── tools/blender/           build_cars.py — generates the car models with Blender (bpy)
└── src/
    ├── main.js              Boot, frame loop, game states, quality presets, GPS, reflections
    ├── Environment.js       Assembles the world; festival site, ramps, stunts, backdrop, map image
    ├── world/
    │   ├── Terrain.js       8 km height field: coast, lake, massif, farmland; road profiles,
    │   │                    bridges, cuttings; LOD tiles; splat-mask ground shader
    │   ├── Roads.js         Routes, connectors, junctions, road meshes, rails, lights, bridges
    │   ├── City.js          Towns (downtown / harbour): streets, instanced buildings, signs
    │   ├── Landmarks.js     Wind farm, pagoda, lighthouse, boats, village, observatory, airfield
    │   ├── Water.js         Ocean + lake shader (normals, depth colour, foam)
    │   ├── Vegetation.js    Procedural tree models, impostor atlas, rocks, GPU grass
    │   ├── Surfaces.js      Surface map (asphalt, gravel, sand, snow…) for tyre grip
    │   ├── Atmosphere.js    Physical sky, clouds/stars, sun/moon, environment map
    │   ├── Fog.js           Height fog with sun in-scattering (patched shader chunks)
    │   ├── Instancing.js    Spatially chunked InstancedMesh for culling
    │   └── Noise.js         Deterministic noise helpers
    ├── PhysicsWorld.js      Rapier, 60 Hz fixed step, heightfield, trimesh bridges; lite fallback
    ├── Vehicle.js           Raycast vehicle, tyre model, drivetrain, aids, car roster, glTF cars
    ├── AIDriver.js          Pure-pursuit AI with corner speed planning, avoidance, recovery
    ├── Events.js            Races / sprints / trials, AI grids, stunts, traffic, event beacons
    ├── Navigation.js        Road graph + Dijkstra for the GPS
    ├── Effects.js           Skid marks, smoke/dust/spark particles, exhaust flames
    ├── Progression.js       Save file: credits, XP/levels, garage, records, settings
    ├── Audio.js             Procedural Web Audio engine/sfx + generative radio
    ├── CameraController.js  Locked chase cam, far/bumper modes, showroom orbit
    ├── UI.js                HUD, minimap/world map, menus, garage shop, results, touch
    └── Shaders.js           Taillight glow, petals, speed blur + grading, bloom pipeline
```

## Technical notes

- **Physics.**
  - Rapier WASM steps on a fixed 60 Hz accumulator with render interpolation.
  - The ground is a 1024×1024 heightfield that matches the rendered terrain,
    bridges are trimesh colliders, and all static props share one fixed body.
  - Tyre forces come from slip ratio and slip angle, normalised by their peak
    values and combined through the friction ellipse.
  - Wheel spin is integrated implicitly, so it stays stable at 60 Hz.
  - If Rapier can't load, a built-in lite solver keeps the game playable.
- **Road profiles.** Each route's elevation goes through three steps:
  1. It's fitted to the terrain and to flat zones (towns, junctions).
  2. It's limited to a maximum grade.
  3. It's smoothed with vertical curves.

  Junctions are claimed by the highest-priority road so that connectors meet
  it level. A stretch becomes a bridge wherever the road is over water or more
  than 9 m above the ground.
- **AI cars** use the same vehicle physics as the player. They plan cornering
  speeds from the upcoming curvature (`v = √(μg/k)`), with a braking envelope
  and an allowance for surface grip.
- **Car models.** Run `tools/blender/build_cars.py` (see `assets/README.md`)
  to regenerate the cars after editing their style profiles. If a model can't
  load, a built-in procedural car body is used instead.
- **Performance.**
  - Terrain is drawn as LOD tiles.
  - Trees are near models plus a single impostor draw.
  - Rocks, rails and props are spatially chunked instances, so they're culled
    by the camera and the shadow frustum.
  - Grass is placed on the GPU around the camera.
  - Quality presets scale shadows, grass, resolution, reflections and bloom.

`window.__horizon` exposes the running app in the browser console for debugging.

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

## What's in the game

- **A 4 km × 4 km open world:**
  - rolling hills and forests
  - a mountain range around the map edge with a snowy Fuji-style peak beyond it
  - roads that cut into the hillsides and sit on embankments
  - over 7,000 trees (broadleaf, pine and sakura) and dense grass that sways in the wind
- **Neon City:** a 1 km² downtown grid with about 240 buildings. Their glass
  and window facades reflect the sky, and the windows light up at night. The
  city also has neon signs, rooftop billboards, crosswalks, street lights and
  traffic lights.
- **Roads:** the Festival Loop circuit, the 10 km **Horizon Highway** around
  the map, the **Fuji Pass** mountain road, and connector roads between them,
  with guard rails, street lights and lane markings. Fast travel to each area
  from the Map tab.
- **Seven events.** Five are races against 5 AI rivals:
  - Sakura Circuit
  - Neon City Street Race
  - Fuji Pass
  - Horizon Highway
  - Festival Sprint

  The other two are time trials: Hanami and Neon Time Attack. Races have
  checkpoint gates, live positions, a wrong-way warning, results and payouts.
- **Challenges around the map:** 4 speed traps, 2 speed zones, 2 drift zones and
  2 ramp jumps, each rated 1–3 stars with saved records.
- **Cars modelled in Blender:** five distinct bodies (GT coupe, mid-engine
  supercar, JDM drift coupe, rally hatchback, hypercar). Each has wheel arches,
  glass with an interior behind it, live headlights, brake lights and reverse
  lights, a grille, mirrors, wings and detailed wheels. The garage shows studio
  renders of each car.
- **Realistic rendering:**
  - a physically based sky with drifting clouds, stars at night and a full day/night cycle
  - reflections that match the sky, and soft sun shadows that follow you
  - sky-coloured fog, bloom, colour grading and speed blur
  - headlights that light the road at night, and a soft contact shadow under each car
- **Camera:** a tight chase camera that stays at a fixed distance behind the
  car when you accelerate. It follows the car on slopes, pulls in when a wall
  or building is behind you, and has far-chase and bumper modes (`C`).
- **Traffic:** AI cars cruise the highway, city, festival loop and mountain
  pass. You can set traffic to off, light, normal or busy.
- **Skill chains:** drift, speed, air, clean driving and cone smashes build a
  chain with a multiplier. A crash breaks it.
- **Progression:** credits, XP and levels; buy 5 cars and upgrade engine,
  tyres and brakes (3 tiers each, which change the car's class); 8 paint
  colours. Everything, including settings, is saved automatically.
- **Audio, all synthesised live:** engine sound that follows RPM, tyre squeal,
  wind, crashes, UI sounds, and a generative synthwave radio (`M` toggles it).
- **Controls:** keyboard, gamepad (including menu navigation) and on-screen
  touch buttons.

## Controls

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Throttle / Brake / Reverse | `W` `S` or `↑` `↓` | RT / LT | GAS / BRAKE |
| Steer | `A` `D` or `←` `→` | Left stick | ◀ ▶ |
| Handbrake (drift) | `Space` | A | HB |
| Menu | `Esc` | Start | ☰ |
| Menu tabs / navigate / select | `Q` `E` / mouse | LB RB / D-pad / A | tap |
| Camera (chase / far / bumper) | `C` | View | — |
| Reset to track | `R` | Y | — |
| Radio on/off | `M` | — | Settings |

## Project layout

```
├── index.html               Title, HUD, results, menu markup, import map
├── styles/ui.css            Glassmorphic HUD, race panel, stunt banners, tile menu, touch
├── assets/cars/             Blender-built car models (.glb) + garage thumbnails (.png)
├── tools/blender/           build_cars.py — generates the car models with Blender (bpy)
└── src/
    ├── main.js              Boot, frame loop, TITLE/GAMEPLAY/MENU/RESULTS states, skill chains
    ├── Environment.js       Assembles the world; festival site, ramps, gates, stunts, backdrop
    ├── world/
    │   ├── Terrain.js       Height-field terrain, road cuttings, ground shader, physics heightfield
    │   ├── Roads.js         Routes (spline centre-lines + elevation), road meshes, rails, lights
    │   ├── City.js          Neon City: streets, sidewalks, instanced buildings, signs, lights
    │   ├── Vegetation.js    Chunked instanced trees (leaf cards) + GPU grass
    │   ├── Atmosphere.js    Physical sky, clouds/stars, sun/moon, fog, environment map
    │   └── Noise.js         Deterministic noise helpers
    ├── PhysicsWorld.js      Rapier, 60 Hz fixed step, heightfield, collision groups; lite fallback
    ├── Vehicle.js           Raycast vehicle, gearbox, tyres, input, car roster, glTF cars
    ├── AIDriver.js          Pure-pursuit AI with corner speed planning, avoidance, recovery
    ├── Events.js            Races / time trials on any route, PR stunts, free-roam traffic
    ├── Progression.js       Save file: credits, XP/levels, garage, records, settings
    ├── Audio.js             Procedural Web Audio engine/sfx + generative radio
    ├── CameraController.js  Locked chase cam, far/bumper modes, showroom orbit
    ├── UI.js                HUD, minimap/world map, menus, garage shop, results, touch
    └── Shaders.js           Taillight glow, petals, speed blur + grading, bloom pipeline
```

## Technical notes

- **Physics.** Rapier WASM steps on a fixed 60 Hz accumulator with render
  interpolation, on a 512×512 heightfield that matches the rendered terrain
  exactly. The collision groups are `STATIC_GEOMETRY`, `VEHICLE_BODY`
  (cars collide with each other), `WHEELS` (suspension rays) and `PROPS` (cones).
  If Rapier can't load, a built-in lite solver keeps the game playable. It
  supports terrain and ramps but not car-to-car contact.
- **AI cars** use the same vehicle physics as the player. Their inputs come from
  a driver model that plans cornering speeds from the upcoming curvature
  (`v = √(μg/k)`) with a braking envelope, and applies mild catch-up so races
  stay close.
- **Car models.** Run `tools/blender/build_cars.py` (see `assets/README.md`)
  to regenerate the cars after editing their style profiles. If a model can't
  load, a built-in procedural car body is used instead.
- **Performance.** Trees are split into 512 m chunks so off-screen ones aren't
  drawn, buildings and props are instanced, and grass is placed on the GPU.
  Grass, shadows, traffic and resolution scale can be lowered in Settings for
  slower GPUs.

`window.__horizon` exposes the running app in the browser console for debugging.

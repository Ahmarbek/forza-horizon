# Horizon Drive — Sakura Festival

A Forza Horizon–inspired arcade driving prototype built with **Three.js** and
**Rapier** (`@dimforge/rapier3d-compat`), plus a vanilla HTML/CSS glassmorphic HUD
and tile-grid menu. There is no build step: ES modules load from a CDN through an
import map.

## Run

ES modules need to be served over HTTP (opening `file://` directly won't work):

```bash
npm start                  # npx http-server on http://localhost:8080
# or
python3 -m http.server 8080
```

The car can be driven as soon as the loader fades out.

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Throttle / Brake / Reverse | `W` `S` or `↑` `↓` | RT / LT |
| Steer | `A` `D` or `←` `→` | Left stick |
| Handbrake (drift) | `Space` | A |
| Menu | `Esc` | Start |
| Switch menu tab | `Q` / `E` | LB / RB (D-pad + A to pick cards) |
| Camera | `C` | Back / View |
| Reset to track | `R` | Y |

## Project layout

```
├── index.html            HUD + menu markup, import map
├── styles/ui.css         Glassmorphic HUD, tachometer, skill popups, tile menu
├── assets/               Optional car.glb (procedural fallback otherwise)
└── src/
    ├── main.js           Bootstrap, frame loop, GAMEPLAY ⇄ MENU state, skill chain
    ├── PhysicsWorld.js   Rapier init, 60 Hz fixed-step accumulator, collision groups,
    │                     ray casts; built-in "lite" solver fallback
    ├── Vehicle.js        Raycast vehicle, gearbox, tyres, input, procedural car, GLTF swap
    ├── CameraController.js  Spring-damped chase, speed FOV, look-ahead, showroom orbit
    ├── Environment.js    Track spline, procedural asphalt maps, instanced scenery, lighting
    ├── UI.js             HUD updates, minimap/world map canvases, menu tabs & navigation
    └── Shaders.js        Sky, ground, taillight glow, petals, speed blur, post pipeline
```

## Highlights

- **Physics.** Rapier WASM steps on a fixed 60 Hz accumulator with render
  interpolation. The collision groups are `STATIC_GEOMETRY`, `VEHICLE_BODY`,
  `WHEELS` (suspension rays) and `PROPS` (knock-over cones). If Rapier can't load,
  a small built-in rigid-body solver takes over, so the game is always drivable.
- **Vehicle.**
  - Four suspension rays with spring stiffness, separate bump and rebound
    damping, rest length, a bump stop and anti-roll bars.
  - The engine uses a torque curve with top-speed falloff, a 6-speed automatic
    gearbox with shift cuts, and reverse.
  - Steering angle scales down as speed rises. Tyres use a friction circle.
  - The handbrake collapses rear lateral grip, and a drift assist holds the
    slide at a controllable angle.
- **Camera.** A critically-damped spring follows the car. Yaw blends the car's
  heading with its velocity, so drifts are framed from the outside. FOV goes
  from 60° to 85° with speed, and the camera adds steering look-ahead, pitch and
  roll from acceleration, a high-speed rumble and shake on impacts.
- **World.**
  - A 1.9 km closed spline circuit with procedurally generated asphalt colour,
    roughness and normal maps, plus curbs and a start plaza.
  - More than 1,200 instanced objects: pines, sakura trees, street lights and
    barriers on the outside of corners, all with static colliders.
  - Low-poly mountains, including a Fuji-style peak.
  - Soft shadow maps from a sun light that follows the car, ACES filmic tone
    mapping, and an environment map rebuilt from the dynamic sky.
- **Effects.**
  - A gradient sky shader with sun disk and clouds, and a noise-based ground shader.
  - GPU-animated falling petals.
  - Taillight lenses and additive glow that brighten with brake input, plus
    reverse lights.
  - Post-processing: `UnrealBloomPass` and a speed-dependent radial blur with vignette.
- **HUD and menu.**
  - SVG tachometer with a conic-gradient glow, digital speed readout, gear
    indicator and a rotating minimap.
  - Skill-chain popups: DRIFT, SPEED SKILL, CLEAN DRIVING, AIR and CONE SMASH,
    with a multiplier and banking.
  - The `Esc` menu has FESTIVAL, GARAGE (3 cars, 8 paints), MAP and SETTINGS
    (units, bloom, blur, shadows, time of day, resolution) tabs.

`window.__horizon` exposes the running app in the console for debugging.

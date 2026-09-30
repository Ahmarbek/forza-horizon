# Horizon Drive — Sakura Festival

A Forza Horizon–inspired open-world racing game that runs in the browser. It's
built with **Three.js** and **Rapier** physics, with a vanilla HTML/CSS
glassmorphic HUD. There is no build step and there are no asset downloads: the
car, world, textures, sound and music are all generated in code.

## Run

ES modules must be served over HTTP; opening `index.html` from `file://` won't work:

```bash
npm start                  # npx http-server on http://localhost:8080
# or
python3 -m http.server 8080
```

## What's in the game

- **Festival Loop open world.** A 1.9 km circuit through sakura groves under a
  Fuji-style mountain, with a start gantry, plaza, ramps and more than 1,200
  roadside objects. Four AI "Drivatar" cars cruise the loop in free roam.
- **Races.** *Sakura Circuit* (3 laps) and *Festival Sprint* (1 lap), each
  against 5 AI rivals. Races have a grid start, countdown, checkpoint gates,
  live positions, lap timing, a wrong-way warning, a results table and rewards.
  AI difficulty ranges from Easy to Unbeatable.
- **Time trial.** *Hanami Time Trial*: your best lap is measured against
  bronze, silver and gold target times.
- **Challenges around the map, each rated 1–3 stars:**
  - 2 speed traps
  - a speed zone (scored on average speed)
  - a drift zone
  - 2 danger-sign jumps
  Every new star pays credits and XP, and your records are saved.
- **Skill chains.** Drift, speed, air, clean driving and cone smashes build a
  chain with a multiplier. A crash breaks the chain; banking it pays out
  credits and XP.
- **Progression.** You earn credits and XP, level up for bonus credits, and can
  buy 5 cars (classes A to X). Each car has engine, tyre and brake upgrades
  (3 tiers each, which change its performance class) and 8 paint colours.
  Everything, including settings, is saved automatically in your browser.
- **Audio, all synthesised live:**
  - engine sound that follows the RPM, tyre squeal, wind, crashes and landings
  - UI sounds
  - *Horizon Pulse*, a generative synthwave radio station (`M` toggles it)
- **Controls:** keyboard, gamepad (including menu navigation) and on-screen
  touch buttons for phones and tablets.

## Controls

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Throttle / Brake / Reverse | `W` `S` or `↑` `↓` | RT / LT | GAS / BRAKE |
| Steer | `A` `D` or `←` `→` | Left stick | ◀ ▶ |
| Handbrake (drift) | `Space` | A | HB |
| Menu | `Esc` | Start | ☰ |
| Menu tabs / navigate / select | `Q` `E` / mouse | LB RB / D-pad / A | tap |
| Camera | `C` | View | — |
| Reset to track | `R` | Y | — |
| Radio on/off | `M` | — | Settings |

## Project layout

```
├── index.html               Title, HUD, results, menu markup, import map
├── styles/ui.css            Glassmorphic HUD, race panel, stunt banners, tile menu, touch
├── assets/                  Optional car.glb (procedural car otherwise)
└── src/
    ├── main.js              Boot, frame loop, TITLE/GAMEPLAY/MENU/RESULTS states, skill chains
    ├── PhysicsWorld.js      Rapier, 60 Hz fixed step, collision groups, ramps; lite fallback solver
    ├── Vehicle.js           Raycast vehicle, gearbox, tyres, input, car roster, upgrades, PI classes
    ├── AIDriver.js          Pure-pursuit AI: corner speed planning, avoidance, stuck recovery
    ├── Events.js            Races / time trial, PR stunts, free-roam traffic
    ├── Progression.js       Save file: credits, XP/levels, garage, records, settings
    ├── Audio.js             Procedural Web Audio engine/sfx + generative radio
    ├── CameraController.js  Spring chase cam, speed FOV, look-ahead, showroom orbit
    ├── Environment.js       Track spline, asphalt maps, instanced scenery, gates, stunts, lighting
    ├── UI.js                HUD, minimap/world map, menus, garage shop, results, touch
    └── Shaders.js           Sky, ground, taillight glow, petals, speed blur, bloom pipeline
```

## Technical notes

- **Physics.** Rapier WASM steps on a fixed 60 Hz accumulator with render
  interpolation. The collision groups are `STATIC_GEOMETRY`, `VEHICLE_BODY`
  (cars collide with each other), `WHEELS` (suspension rays) and `PROPS` (cones).
  If Rapier can't load, a built-in lite solver keeps the game playable. It
  supports ramps but not car-to-car contact.
- **AI cars** use the same vehicle physics as the player. Their inputs come from
  a driver model that plans cornering speeds from the upcoming curvature
  (`v = √(μg/k)`) with a braking envelope, and applies mild catch-up so races
  stay close.
- **Optional car model.** Drop a glTF at `assets/car.glb` to replace the
  player's procedural car body.

`window.__horizon` exposes the running app in the browser console for debugging.

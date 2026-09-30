# Optional car model

Drop a glTF binary at `assets/car.glb` to replace the procedural car body.

- The model is auto-scaled to ~4.5 m long, centred, and placed on the suspension.
- Meshes whose names contain `wheel`, `tire`, `tyre` or `rim` are hidden; the
  procedural wheels keep animating with steering, spin and suspension travel.
- If the file is missing, fails to parse, or takes longer than 6 s, the
  procedural low-poly car (built instantly at startup) is kept.

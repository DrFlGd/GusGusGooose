# Gus Gus Goose

Tools for fitting magnet-mounted accessories to the Gus Gus desk goose. The
goose has four magnet points (beak, top of head, left wing, right wing); an
accessory is any STL that gets carved to sit on the goose at one of them,
with a matching magnet pocket cut in.

The plan, with options, stack, risks and phases, is in [docs/PLAN.md](docs/PLAN.md).

## Status

Phase 1 (headless fit script) passes against a synthetic goose. The real
goose is in `goose/goose.3mf` (Bambu Studio project, v1.2.3 blank, full
colour assembly) and `goose/goose-voids.3mf` (the bare white body and nose
with the magnet voids as Bambu negative parts). `goose/goose.stl` is built
from both: body, beak, feet, base disc, minus the leg pin holes and the
magnet voids mapped across from the second file (63,586 triangles,
100 x 131 x 183 mm). `goose/profile.json` holds the four magnet points read
straight from those negative parts: head 10.2 dia x 4.2 disc, wings
10.2 x 10.2 x 4.2 blocks, beak 8 dia x 4.2 disc with its insertion slot.
All four are embedded (inserted at print pauses), so accessories align to
the centre of each void's outer face projected to the surface. The eyes are
printed separately and are not in the model.

## Use

Requires Node 22.18 or newer (it runs the TypeScript directly).

```sh
npm install

# 0. rebuild goose/goose.stl and goose/profile.json from the project 3MFs (only when the goose changes)
node src/build-goose.ts goose/goose.3mf goose/goose.stl --voids goose/goose-voids.3mf

# 1. find cylindrical magnet voids in a model, write goose/profile.json
#    (GOOSE_DEBUG=1 prints why each candidate patch was rejected)
npm run detect -- goose/goose.stl

# 2. fit an accessory at a point (accessory frame: base centred on the origin, +Z up)
npm run fit -- --accessory hat.stl --point head --sink 2 --spin 0 --out hat.fitted.stl

# 1b. or place a magnet hole yourself: click point (snapped to the surface), magnet size,
#     open press-fit or embedded under a skin (prints the Z to pause at); adds the point to the profile
node src/cli.ts hole --model goose/goose.stl --at 125.6,100.4,183 --name head --magnet-dia 6 --magnet-thick 3 --out goose/goose.holed.stl
node src/cli.ts hole --model goose/goose.holed.stl --at 140,78,170 --name beak --magnet-dia 6 --magnet-thick 3 --embedded --skin 1 --out goose/goose.holed.stl

# magnet size and pocket are adjustable per accessory (defaults mirror the goose void)
npm run fit -- --accessory hat.stl --point head --magnet-dia 8 --magnet-thick 3 --pocket-radial 0.1 --pocket-axial 0.2
npm run fit -- --accessory hat.stl --point head --no-pocket

npm test
```

`goose/profile.json` holds the clearance numbers and the four magnet points.
Names are guessed from each void's axis direction; fix them by hand if the
guess is wrong, and add `"polarityOut": "N"` or `"S"` per point once known.

## Layout

- `src/threemf.ts` reads a 3MF project (parts, transforms, negative parts)
- `src/build-goose.ts` unions the 3MF parts into the one goose solid, cutting the mapped voids
- `src/map-voids.ts` carries negative parts from one 3MF onto another and turns them into magnet points
- `src/stl.ts` STL read/write, welds the triangle soup into a shared-vertex mesh
- `src/voids.ts` finds the cylindrical magnet voids in the goose
- `src/hole.ts` magnet-hole tool: snap to surface, cut open or embedded pocket
- `src/fit.ts` the fitting pipeline on [Manifold](https://github.com/elalish/manifold)
- `src/cli.ts` `detect` and `fit` commands
- `test/` end-to-end test on a synthetic goose (sphere with four voids)
- `goose/` the bundled goose model and its fit profile

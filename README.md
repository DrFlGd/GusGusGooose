# Gus Gus Goose

Tools for fitting magnet-mounted accessories to the Gus Gus desk goose. The
goose has four magnet points (beak, top of head, left wing, right wing); an
accessory is any STL that gets carved to sit on the goose at one of them,
with a matching magnet pocket cut in.

The plan, with options, stack, risks and phases, is in [docs/PLAN.md](docs/PLAN.md).

## Status

Phase 1 (headless fit script) passes against a synthetic goose. The real
goose is in `goose/goose.3mf` (Bambu Studio project, v1.2.3 blank) and
`goose/goose.stl` is built from it (body, beak, feet, base disc, minus the
two leg pin holes; 57,756 triangles, 100 x 131 x 183 mm). This blank has no
magnet voids yet, only the 3.5 mm eye pin holes, so the four magnet points
will be placed with the magnet-hole tool rather than detected. The eyes are
printed separately and are not in the model.

## Use

Requires Node 22.18 or newer (it runs the TypeScript directly).

```sh
npm install

# 0. rebuild goose/goose.stl from the project 3MF (only when the goose changes)
node src/build-goose.ts goose/goose.3mf goose/goose.stl

# 1. find cylindrical magnet voids in a model, write goose/profile.json
#    (GOOSE_DEBUG=1 prints why each candidate patch was rejected)
npm run detect -- goose/goose.stl

# 2. fit an accessory at a point (accessory frame: base centred on the origin, +Z up)
npm run fit -- --accessory hat.stl --point head --sink 2 --spin 0 --out hat.fitted.stl

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
- `src/build-goose.ts` unions the 3MF parts into the one goose solid
- `src/stl.ts` STL read/write, welds the triangle soup into a shared-vertex mesh
- `src/voids.ts` finds the cylindrical magnet voids in the goose
- `src/fit.ts` the fitting pipeline on [Manifold](https://github.com/elalish/manifold)
- `src/cli.ts` `detect` and `fit` commands
- `test/` end-to-end test on a synthetic goose (sphere with four voids)
- `goose/` the bundled goose model and its fit profile

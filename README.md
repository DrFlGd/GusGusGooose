# Gus Gus Goose

Tools for fitting magnet-mounted accessories to the Gus Gus desk goose. The
goose has four magnet points (beak, top of head, left wing, right wing); an
accessory is any STL that gets carved to sit on the goose at one of them,
with a matching magnet pocket cut in.

The plan, with options, stack, risks and phases, is in [docs/PLAN.md](docs/PLAN.md).

## App

`npm run dev` opens the browser app (Vite). It shows the goose in its
filament colours with its magnet points. Load a downloaded model (STL, OBJ
or 3MF, or drop the file on the view), prepare it (which side meets the
goose, a width to scale it to, a plug of solid material for hollow models),
place it on a point with sink, spin and slide controls, Fit with one click
and export. The Clothing tab makes a shirt, sweater or coat that follows the
body between a hem and a neck height and slips on over the head (no
magnets), with a V, scoop or crew neckline, a collar, ribbed or quilted
fabric, buttons, a placket, a hem band and stripes; or it wraps a
downloaded garment (pen-pot shirts and jackets work well) over the body,
keeping its collar in proportion, and hollows it. The garment's axis leans
so the collar is centred on the neck. For a wrap, the loaded model is shown
where it will land and can be turned, shifted, cropped (a height band and
the four sides) and lined up before wrapping. Either kind can be split into
two halves with small disc-magnet pockets along the seams, and a form-fit
option lets the halves hug the chest and the tail. The
Magnet hole tab cuts a new hole where you click, open or embedded with the
pause height reported, and exports the holed goose. The Paint tab (after
a fit or a garment) brushes faces with a palette of your filament colours,
with Refine to split the mesh for finer edges, Fill all and Undo, and
exports a 3MF whose colour regions the slicer maps to filaments (STL stays
for single-colour parts). A 3MF that comes in with colours keeps them: each
part's filament slot, paint applied in Bambu Studio or PrusaSlicer (a
triangle painted in more than one colour takes the colour covering most of
it), and standard 3MF material groups, including the app's own exports.
They become the palette, ride through fit and wrap as material tags on the
solid, and come out on the export. A tick box hides the goose and frames
the part so you can paint all round it, and Split by colour exports one
body per colour in a single 3MF (each colour a skin of the chosen depth
under its faces, the rest with the base colour) for slicers that want
parts rather than paint. Everything runs in the page; nothing is uploaded.
Models that are not valid solids (edges shared by three faces, overlapping
shells, holes) are rebuilt on a voxel grid on import, at a pitch chosen
from their size or one you set (down to 0.3 mm for more detail, at the
cost of a longer wait); the Clear buttons on the Accessory and Clothing
tabs drop the loaded model and anything fitted, to start over.
`npm run smoke` builds it and drives it headlessly (fit a puck, import a
3MF, make a shirt, wrap it, clear, cut a hole; screenshots in
`smoke-out/`); it needs Playwright with Chromium available.

Accessories are downloaded models, never built from primitives; see
[accessories/README.md](accessories/README.md) for the library layout.

The GitHub Pages workflow deploys the app from `main` once Pages is
enabled for the repo (Settings → Pages → Source: GitHub Actions).

## Status

Phase 1 (headless fit) and a first Phase 2 UI are in. The real
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
printed separately and are not in the model. `goose/goose-colors.json`
carries each triangle's filament (orange beak, feet and nose; white body;
the base disc) from the project file, for the viewer only.

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

# 3. clothing: a shell that follows the body from hem to neck (tilt-on collar, or --collar drop)
node src/cli.ts shirt --hem 46 --neck 108 --thickness 1.6 --clearance 0.4 --out shirt.stl
# or stretch a downloaded garment (hem at its bottom) over the body and hollow it
node src/cli.ts wrap --garment sweater.stl --hem 46 --neck 108 --out sweater.fitted.stl
# line it up first: turn it, shift its axis, keep a height band, crop its sides (left,right,front,back)
node src/cli.ts wrap --garment jacket.3mf --turn 10 --shift 0,-2 --band 5,60 --crop 0,0,0,8 --keep-top 25
# a thin or noisy model: put a 1.2 mm smooth liner between it and the body, and open the collar 4 mm out from the neck
node src/cli.ts wrap --garment polo.3mf --liner 1.2 --neck-spread 4 --neck-spread-height 15
# a model that is not a valid solid is rebuilt on a voxel grid first (--voxel sets the pitch, --no-repair refuses it instead);
# --smooth-model relaxes a rough mesh a few passes before wrapping
node src/cli.ts wrap --garment puffer.3mf --voxel 0.3 --keep-top 22
# a hoodie designed for the goose (hood down, hands in the pocket): shirt body plus parts modelled in Blender (pip install bpy)
sh scripts/hoodie/build.sh hoodie.stl
# two halves that clip on with 3 x 1 mm magnets, hugging the chest and tail (writes .a.stl and .b.stl as well)
node src/cli.ts shirt --split sides --form-fit --split-magnets 3 --split-magnet-dia 3 --split-magnet-thick 1 --out shirt.stl

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
- `src/load-model.ts`, `src/obj.ts`, `src/zip-read.ts` read STL, OBJ and 3MF (pure, shared with the app); a 3MF's colours become material tags on the solid
- `src/threemf-parse.ts` 3MF parts, transforms, filament slots and slicer paint codes; `src/threemf-write.ts` painted 3MF, one mesh or one part per colour
- `src/split-colours.ts` splits a painted solid into one body per colour
- `src/prepare.ts` turns a downloaded model into an accessory: orient, scale, centre, plug
- `src/clothing.ts` body profile, contour shirt and garment wrap
- `src/goose-colors.ts` the goose's per-face filament colours
- `src/fit.ts` the fitting pipeline on [Manifold](https://github.com/elalish/manifold)
- `src/cli.ts` `detect`, `fit`, `hole`, `shirt` and `wrap` commands
- `src/web/` the browser app (three.js viewer, panel, same pipeline in Manifold WASM)
- `scripts/smoke.mjs` headless Playwright run of the built app
- `test/` end-to-end test on a synthetic goose (sphere with four voids)
- `goose/` the bundled goose model and its fit profile

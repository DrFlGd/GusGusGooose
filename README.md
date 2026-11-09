# Gus Gus Goose

Tools for fitting magnet-mounted accessories to the Gus Gus desk goose. The
goose has four magnet points (beak, top of head, left wing, right wing); an
accessory is any STL that gets carved to sit on the goose at one of them,
with a matching magnet pocket cut in.

The plan, with options, stack, risks and phases, is in [docs/PLAN.md](docs/PLAN.md).

## Desktop app and library

The app also runs as a portable desktop app (Tauri), from the same web
build: no installer, just a folder (Windows) or an AppImage (Linux)
that runs where it is put. Releases are on the repository's Releases page.
The **Desktop app** workflow publishes one when main is pushed with an app
version (`src-tauri/tauri.conf.json`) that has no release yet, tagged
`v<version>`, or when a `v*` tag is pushed; it can also be run by hand from
the Actions tab (zips as artifacts, no release). Bump the version to release
again. The builds are
not signed; `docs/PORTABLE.txt` (README.txt in each zip) says how to get past
SmartScreen. To run it from source you need Rust and the
Tauri prerequisites for your system: `npm run desktop` (development, live
reload) or `npm run desktop:build`.

The **Library** tab keeps saved builds. *Save to library* (right column of
the editor, or Ctrl+S) keeps the model or picture it was made from, every
setting (each position's placement and mount, the trace settings, the
palette), the fitted part with its paint, a 3MF of it and a thumbnail of the
view. Builds are filed under a collection, grouped as holidays (Christmas,
Halloween…) or categories (Hats, Clothing…), and carry tags and a
description; the Library searches all of them and filters by tag. *Open in
editor* loads the file again, puts the settings back, fits again and lays the
paint back on, so the build can be changed and saved over or saved as new.
Collections can be added, renamed and removed; builds can be duplicated,
deleted, given another picture or exported as 3MF without opening them.

On the desktop each build is a folder of plain files in
`Gus Gus Goose Library` next to the app (with `Gus Gus Goose settings.json`
beside it), so the app and its builds move or copy together; when the
app's folder cannot be written (Program Files, a read-only disk) both go to the system's
app data folder instead. Settings (the gear in the top bar) moves the
library to any folder, taking the builds along or not (to use a library
already there), puts it back next to the app, or shows it in the file
manager. Exports go through a Save dialog. In the browser the
library lives in the browser's own storage (IndexedDB), per browser. A build
assumes the bundled goose: holes cut on the Hole tab are not part of it.
`npm run smoke:library` drives the library headlessly.

## App

`npm run dev` opens the browser app (Vite). Its layout is Print Factory's:
the settings on the left, the view in the middle with buttons for iso,
front, side and top views, Fit and Hide goose, and Export on the right
(3MF with colours, STL, split by colour). Each side scrolls on its own and
the view never scrolls; a button in the top bar switches between light and
dark. It shows the goose in its filament colours with its magnet points; the Character picker in the top bar switches to the sea otter (head and chest magnets), and everything below works on whichever is shown, except clothing and the neck band, which are the goose's. The Goose (or Otter) tab builds the slide-in-magnet print (channels from each magnet seat to a covered mouth, flat or swept, with the tolerances as controls) and exports it as a 3MF or STLs. Load a downloaded model (STL, OBJ
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
a fit or a garment; with an accessory loaded but not fitted, opening it
fits the accessory where it is, and after a move the paint comes along to
where the accessory now sits) paints with a palette of your filament colours:
a brush, a bucket that fills a region until it meets another colour or a
crease (the angle is yours to set), a corners tool that fills whatever you
can see inside the corners you click, a text stamp and an image stamp
placed as seen from the camera (type the text or choose a picture, which
goes through the same Prepare image dialog as picture accessories; set the
size and angle, click to stamp; the picture's colours join the palette),
Fill all and Undo. Every tool paints inside faces the way Bambu Studio
does: a face a colour edge crosses is split at its edge midpoints, again
and again down to about a pixel for stamps (a fraction of the radius for
the brush), so a coarse part takes sharp letters and pictures without
Refine (still there for a smoother shape). It exports a 3MF whose colour
regions the slicer maps to filaments, palette colour n as filament n; paint
inside faces is written as the slicers' own paint (`paint_color` for
Bambu Studio and OrcaSlicer, `slic3rpe:mmu_segmentation` for PrusaSlicer),
or, with that option unticked, cut into faces of its own (STL stays for
single-colour parts). The panel walks each tab
in numbered steps and every slider has a number box beside it. Number
boxes have arrows that nudge by 0.1 and take typed values to 0.01 (counts
such as ribs and buttons stay whole); a slider holds a typed value as well,
and dragging it moves in its own steps. Only slides, spins, tilts and
angles go below zero: sizes, scales, depths and clearances stop at their
floor (a typed or pasted negative is raised to it, and the minus key does
nothing there). The pocket
takes a magnet from a list of common discs (or a typed size, or the
goose's own void), a fit preset (press, snug, loose, or crush ribs) that
sets the clearances, and crush ribs: round ridges down the pocket wall,
tapered at the mouth, whose tips sit a set distance inside the magnet so
a loose pocket still grips. A 3MF that comes in with colours keeps them: each
part's filament slot, paint applied in Bambu Studio or PrusaSlicer (paint
inside a face, too: its split becomes faces of their own, so none of the
detail is lost), and standard 3MF material groups, including the app's own
exports.
They become the palette, ride through fit and wrap as material tags on the
solid, and come out on the export. Hide goose over the view frames the part on
its own so you can paint all round it, and Split by colour exports one
body per colour in a single 3MF (each colour a skin of the chosen depth
under its faces, the rest with the base colour) for slicers that want
parts rather than paint. Everything runs in the page; nothing is uploaded.
Models that are not valid solids (edges shared by three faces, overlapping
shells, holes) are rebuilt on a voxel grid on import, at a pitch chosen
from their size or one you set (down to 0.3 mm for more detail, at the
cost of a longer wait); the Clear buttons on the Accessory and Clothing
tabs drop the loaded model and anything fitted, to start over.
`npm run smoke` builds it and drives it headlessly (check the view and the
page do not scroll, fit a puck, import a 3MF, make a shirt, wrap it, clear,
build an SVG picture on the head and a wing and move its mount, check each
position keeps its own placement, switch the mount layouts, prepare a PNG
in the Prepare image dialog, puck a sword under and behind, fit a bow on
the neck band, cut a hole; screenshots in `smoke-out/`); it needs
Playwright with Chromium available.

On the Accessory tab, a hollow model (a hat open underneath) can be filled
before the fit: the fill finds the cavity the walls enclose above the magnet
point, fills it from its floor up by the depth you set, following the walls
and never through the top, and makes that floor the base, so a cowboy hat
whose brim dips below the crown opening still gets its magnet in the crown.
The model's angle is set by clicking it in the view, which shows three
rotation rings (two tilts and the spin about the magnet axis) to drag, with
sliders in the panel for fine adjustment; the fit uses the same angles.

A picture makes an accessory too: drop a PNG, JPG or SVG on the view (or
choose it under "Or a picture"). A PNG, JPG or WebP opens Print Factory's
Prepare image dialog, with the original and the result side by side:
remove the background (and its tolerance), the number of colours, a chip
per colour to keep or drop it, one colour only for a silhouette, smoothing,
speck removal, exposure, contrast and saturation; Ctrl + scroll zooms.
"Use this image" traces exactly what the result shows, and Adjust opens it
again with the same settings. An SVG keeps its own fills. The traced
picture shows in the panel; its outline becomes a plate of the thickness
you set, and each colour an inlay let into the face (or both faces), so a
candy cane prints red with white stripes. The palette is learned from flat
areas only, so the blend along a smooth edge never takes a colour of its
own. The magnet goes in a puck, or in the plate itself, sized to the
point's magnet, and each position chooses how: the puck parallel to the
picture (the picture lies on the goose, puck under its back) or
perpendicular (the picture stands up), and for a standing picture whether
the puck joins its back (the puck rests on the goose and the picture stands
just in front of it) or its bottom edge (the picture stands on the puck).
The head starts standing with the puck behind, facing the beak; a wing or
the beak starts lying flat with the puck under the deepest point of the
outline. A margin grows the outline and joins loose pieces; holes can be
filled. The tracing and SVG code is vendored from the Print Factory
project (MIT, `src/vendor/`).

The neck is a fourth place to wear things, with no magnet: choosing it
builds a press-fit band (a C that clips round the neck from the front,
with an opening at the back you can widen or narrow, at a height you set)
and shows it on the goose. The accessory, a bow tie, a scarf knot, a
picture, sits on the band's front and is carved against the goose and
the band together; two tabs on the band go into slots cut in its back
(or leave it flat for glue). The slots are blind: each stops 0.8 mm short
of the accessory's front, and when the accessory is too thin for the tabs
asked for, the tabs are shortened to suit (or left off, with a note to glue
it). The fitted band, with its tabs at the length used, is shown on the
neck and stays its own part: Export STL gives both files, and the 3MF
carries the band as a second part.

Each position keeps its own placement and mount (sink, spin, tilts,
slides, the puck's layout and size, a moved magnet), so moving to another
position starts it from that position's defaults and coming back restores
what was set there; loading a new model starts every position afresh.
Stands chooses how the model stands on its magnet: straight up from the
magnet, or leaning with the surface round it (the head leans about 16°
from its magnet, the wings 6 to 8°, the beak 3°; the magnet pocket stays
square to the magnet either way).
Hide goose frames the model, fitted or not, to look it over, and "Move the
magnet" puts the magnet where you click: a puck moves under the spot, a
picture's mount moves to it, and a plain model slides so the spot sits over
the magnet. Small models that cannot hold the magnet themselves (a sword, a
2 mm blade) get a puck in Prepare, sized to the magnet point (its height
leaves a floor under the pocket, which starts a sink above the base). The
puck joins the model's underside (the model sits on it, the puck let in at
the deepest point of its outline, the guard) or its back (the model stands
just in front of the puck, which rests on the goose, and on the head it
turns to face the beak). It is on when the model has no room for the
pocket, and can be forced on or off.

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
magnet voids mapped across from the second file, plus the eyes (65,300
triangles, 100 x 131 x 183 mm). `goose/profile.json` holds the four magnet points read
straight from those negative parts: head 10.2 dia x 4.2 disc, wings
10.2 x 10.2 x 4.2 blocks, beak 8 dia x 4.2 disc with its insertion slot.
All four are embedded (inserted at print pauses), so accessories align to
the centre of each void's outer face projected to the surface. The eyes are
printed separately (`black.stl` in the voids project, loose on the plate)
and sit flush in a 3.5 mm pin channel through the head: the build finds
that channel (a round hole open at both ends) and plugs it in the eye
colour, capped to the head's own surface at each mouth: the channel meets
the slanted head 2 to 3 mm higher on one side of its rim than the other,
so the build measures the rim all round with rays and shapes each cap to
it. Every boolean sees a closed head with two black eyes flush with its
sides, and a hat over the eyes is carved to the head instead of leaving
plugs into the holes. `goose/goose-colors.json`
carries each triangle's filament (orange beak, feet and nose; white body;
the base disc; black eyes) from the project file, for the viewer only.

## Use

Requires Node 22.18 or newer (it runs the TypeScript directly).

```sh
npm install

# 0. rebuild goose/goose.stl and goose/profile.json from the project 3MFs (only when the goose changes)
node src/build-goose.ts goose/goose.3mf goose/goose.stl --voids goose/goose-voids.3mf

# 0b. the slide-in-magnet print: body with channels, keys, loose beak and eyes (docs/PLAN.md, "Slide-in magnets");
#     --style swept|flat, --key side|upright, --clear/--key-clear/--gap/--proud for the tolerances (the app's Goose tab has the same)
node src/build-slots.ts --out goose/goose-slots.3mf

# 0c. the sea otter: paint, flat base, magnet seats; writes goose/otter.stl, otter-colors.json, otter-profile.json
#     (--painted out.3mf for the painted figure, --print out.3mf [--style/--key/--clear/--key-clear/--gap] for the slide-in print)
npm run build-otter

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
- `src/slots.ts`, `src/slots-build.ts`, `src/build-slots.ts` slide-in magnet channels from each seat to a covered mouth (swept or flat bore), their keys, the beak's registration pocket, and the print 3MF (the app's Goose tab uses the same); `src/render.ts` draws solids to PNG
- `src/otter.ts`, `src/build-otter.ts` the sea otter: paint from the sculpt, flat base, magnet seats, slide-in channels from the base and the print 3MF; `src/characters.ts` the characters the app offers
- `src/map-voids.ts` carries negative parts from one 3MF onto another and turns them into magnet points
- `src/stl.ts` STL read/write, welds the triangle soup into a shared-vertex mesh
- `src/voids.ts` finds the cylindrical magnet voids in the goose
- `src/hole.ts` magnet-hole tool: snap to surface, cut open or embedded pocket
- `src/load-model.ts`, `src/obj.ts`, `src/zip-read.ts` read STL, OBJ and 3MF (pure, shared with the app); a 3MF's colours become material tags on the solid
- `src/threemf-parse.ts` 3MF parts, transforms, filament slots and slicer paint codes; `src/threemf-write.ts` painted 3MF, one mesh or one part per colour
- `src/split-colours.ts` splits a painted solid into one body per colour
- `src/paint-tree.ts` paint inside faces as the slicers store it (a split tree per face, its codes, and the bake into real faces); `src/paint-model.ts` the paint tools on it (brush, screen stamps, bucket, undo)
- `src/prepare.ts` turns a downloaded model into an accessory: orient, scale, centre, fill the hollow underside, add a plug or a puck for the magnet
- `src/flat.ts` a flat accessory from a traced picture: plate, colour inlays, puck or in-plate mount, flat or standing
- `src/neck.ts` the press-fit neck band and the fit of an accessory on it
- `src/vendor/` image tracing (k-means colours, marching squares) and SVG parsing from Print Factory (MIT)
- `src/clothing.ts` body profile, contour shirt and garment wrap
- `src/goose-colors.ts` the goose's per-face filament colours
- `src/fit.ts` the fitting pipeline on [Manifold](https://github.com/elalish/manifold)
- `src/cli.ts` `detect`, `fit`, `hole`, `shirt` and `wrap` commands
- `src/web/` the browser app (three.js viewer, panel, same pipeline in Manifold WASM); `library-store.ts` and `library-view.ts` the library, `src/part-file.ts` a saved part with its paint
- `src-tauri/` the desktop shell: the library's file commands and the Save dialog for exports
- `scripts/smoke.mjs` headless Playwright run of the built app; `scripts/library-smoke.mjs` the same for the library
- `test/` end-to-end test on a synthetic goose (sphere with four voids)
- `goose/` the bundled goose model and its fit profile, and the otter's (`otter.stl`, `otter-colors.json`, `otter-profile.json`)
- `characters/otter/otter-source.stl` Jerred's otter model, the source of `npm run build-otter`

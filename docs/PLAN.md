# Goose accessory plan: direct design vs. fitting app

As of 2026-11-02. Living copy: https://claude.ai/artifact/3WQUf99taiT81J6bEGb799

## Summary and recommendation

Build Option B as a small tool, and use Option A inside it: once the app can fit any accessory to the goose, Claude can design new accessories as plain STLs and let the app do the mating and magnet pockets. The two options are not rivals; B is the fitting step that A needs anyway.

The core of B is a few hundred lines on top of the Manifold library, which does robust mesh booleans and solves the hardest problem (non-manifold STLs breaking the subtraction) for free. The first useful version is a command-line script; the point-and-click placement UI comes after, once the fitting pipeline prints well.

The risks that matter are tolerance and magnet fit, not the booleans. Both are settled by a calibration print in the first week.

Decisions so far (2026-11-02):

- Go with Option B, Option A rolls in later.
- The goose base model is bundled in the app, not loaded each time.
- The goose STL already has the magnet voids cut; the app derives the mating magnet locations from those voids.
- Accessories can be painted before export, which means 3MF export for multi-colour slicing.

## Option A: Claude designs accessories directly

This works, but only as parametric code, not by sculpting. Claude cannot model a sculpted shape like the goose itself, but can write CadQuery or OpenSCAD scripts for hats, glasses, scarves, bow ties, capes, crowns, and similar accessories, render them, look at the render, and iterate. The mating surface comes from the same boolean against the goose STL that Option B needs, so that fitting code gets written regardless.

**Workflow**

1. Jerred sends the goose STL plus the magnet size.
2. Claude reads the magnet points from the goose voids and records them once as a fit profile.
3. For each new accessory Claude writes a parametric script, subtracts the goose, cuts the pocket, and sends back an STL plus a render.
4. Jerred prints, says what is off, and the numbers get adjusted.

**Where it is strong**

- Geometric and stylised shapes come out clean and are easy to resize or restyle.
- Every accessory is a script, so a tolerance change regenerates all of them.
- No app to maintain.

**Where it is weak**

- Organic or character shapes (a tiny goose-sized teddy bear, a fish in the beak) are not something Claude can author convincingly; those still come from Jerred or from downloaded models.
- Each round trip goes through a print, so iteration is slow without the fitting tool to preview the mate.
- The magnet-point profile would live in scripts, which is the same data Option B stores in a config file. Doing B first means A reuses it.

## Option B: the fitting app

A browser app, no install: drop in an accessory STL (the goose is built in), drag the accessory onto one of the four magnet points, press Fit, download a print-ready STL. The whole pipeline runs locally in the page, so nothing is uploaded anywhere.

**Suggested stack**

| Layer | Choice | Why |
| --- | --- | --- |
| Booleans | [Manifold](https://github.com/elalish/manifold) (manifold-3d, WASM) | Guaranteed-manifold output, fast, official JS and Python bindings; the same engine OpenSCAD now uses |
| 3D view and placement | [three.js](https://threejs.org/) + TransformControls | Free orbit camera, drag/rotate gizmos, STL loader and exporter |
| Surface snapping, offsets | [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | Fast closest-point and raycast queries on the goose, used for snap-to-surface and the clearance offset |
| Mesh repair fallback | Python: trimesh + pymeshfix | Only for STLs Manifold refuses; run once offline, not in the app |
| Language and build | TypeScript, Vite, single static page | Deploys as one folder; testable headlessly with Playwright |

The alternative is a Blender add-on. It gets the viewport and gizmos for free, but Blender's exact boolean is slower and less robust than Manifold on messy STLs, and every user needs Blender installed. Only worth it if Jerred already lives in Blender.

**Workflow in the app**

1. The goose ships inside the app with its magnet voids already cut. On first run the app finds the four cylindrical voids (beak, head, left wing, right wing) and reads off each one's centre, axis, diameter and depth; Jerred only adds polarity. Saved as a small JSON fit profile, rebuilt only when the goose model changes.
2. Load an accessory STL. Pick a magnet point; the accessory snaps there with its local down axis aligned to the goose normal, sunk 1 to 3 mm into the goose surface.
3. Nudge with the gizmos (slide along the surface, spin about the normal, adjust sink depth). The app shows the overlap in red so you can see what will be carved.
4. Press Fit. The app offsets the goose outward by the clearance, subtracts it from the accessory, then subtracts a magnet pocket cylinder centred on the magnet point along the normal.
5. Check the result (overlap preview goes away, pocket visible), export the STL. Optionally export the goose-side pocket too for a new goose print.

**What Fit does, step by step**

1. Convert both STLs to Manifold objects. If the accessory is not manifold, try Manifold's merge and, failing that, flag it for the offline repair step.
2. Build the clearance offset of the goose: a signed-distance field from three-mesh-bvh, then Manifold `levelSet` at distance = clearance. Only the region near the accessory needs to be sampled, which keeps it under a second. (The Phase 1 script approximates this with a union of 14 shifted copies; the SDF version replaces it with the BVH.)
3. `accessory.subtract(gooseOffset)`.
4. Pocket: a cylinder mirroring the goose void (same axis and diameter, plus the radial and axial clearance from the profile), open to the mating face so the two magnets sit face to face. Subtract it. Optionally add a 0.3 mm chamfer on the pocket mouth so the magnet starts straight.
5. Sanity checks: result is one connected body, pocket floor thickness is above 0.8 mm, bounding box did not collapse. Export binary STL.

## Option B: key technical risks

The booleans are the least risky part. Fit and tolerance are what will decide whether the first print snaps on or rattles.

| Risk | What goes wrong | Plan |
| --- | --- | --- |
| Non-manifold STLs | Sculpted or downloaded models have holes, self-intersections or flipped normals; a boolean on them produces garbage or fails | Manifold refuses bad input instead of guessing, so failures are visible. Repair path: Manifold merge first, then an offline pass with pymeshfix. The goose export from the slicer-ready STL is likely already clean |
| Clearance offset | Subtracting the raw goose gives a zero-clearance fit that will not seat after printing; naive vertex-normal offsets tear at sharp creases (beak edge, wing tips) | SDF level-set offset, which handles creases correctly. Clearance is one number in the fit profile, calibrated by print, starting at 0.2 mm |
| Clearance vs. grip | Too much clearance and the accessory wobbles on the magnet; too little and it rocks on a high spot | Calibration print: one small test puck per magnet point at 0.1, 0.2, 0.3 mm. Pick per point, since the beak and head curvatures differ |
| Magnet pocket sizing | Pockets print undersize (first-layer squish, elephant foot) or oversize (glue needed, magnet proud) | Mirror the goose void, which already fits the magnet, plus 0.1 mm axial clearance as the starting guess, tuned by the same calibration print. Pocket opens on the mating face so the magnet is captured by the goose surface once seated |
| Polarity | A new accessory repels instead of attracts | Fit profile stores each goose magnet's outward pole; the app labels the pocket face with an embossed N or S so you orient the magnet before gluing |
| Thin walls after the cut | A small accessory loses most of its base to the subtraction, leaving a shell too thin to hold the pocket | Sanity check after Fit: minimum thickness around the pocket, warn under 0.8 mm. Fix is to sink the accessory less, or add a base plinth before fitting |
| Printability of the cut face | The carved surface is concave and cannot be the build-plate face without supports | Export with the mating face down anyway for most pieces; the concavity is shallow. For deep cuts the app can also add a flat skirt around the pocket for the first layers |
| Mesh resolution | Goose STL at slicer resolution is 100k+ triangles; an SDF over the whole thing is slow in a browser | Sample the SDF only in the accessory's bounding box plus margin, and crop the goose to that region with a box intersection before the boolean |
| Paint resolution | Fine paint regions need enough triangles to follow; a flat face painted half red and half blue is only two triangles | The brush splits faces as it goes, or the model is refined before painting, otherwise the colour boundary snaps to the nearest existing edge |

## Option B: phased milestones

Each phase ends with a print, not a demo: the gate on each phase is what has to seat on the real goose before the next phase starts. Phase 1 is the first thing you can use; phases 1 and 2 are the same code, the UI just drives it.

| Phase | When | Work | Gate |
| --- | --- | --- | --- |
| 0. Calibrate | Week 1 | Test pucks per point; pick clearance and polarity | A puck seats at all 4 points |
| 1. Headless fit | Weeks 1 to 2 | Script: goose + accessory STL + point in, fitted STL out | A refitted accessory prints and seats |
| 2. Placement UI | Weeks 3 to 4 | Browser viewer, snap to point, gizmos, Fit, export, first paint brush and 3MF export | A new accessory fitted with no code changes |
| 3. Polish | Week 5 on | Import and prepare downloaded models, clothing, coloured goose, polarity marks, batch fitting, thickness check, repair path | Jerred's call per feature |

- **Phase 0, calibrate.** Generate a set of small test pucks (one per magnet point, three clearances each, pocket sizes stepped by 0.1 mm). Jerred prints them and says which seats and grips best. The four points, axes and pocket dimensions come from the goose voids automatically; the print only settles clearances and polarity. Output: the fit profile JSON.
- **Phase 1, headless fit.** A script that takes the goose, an accessory STL, a magnet point name and a transform, and writes the fitted STL. Tested first by re-fitting an existing accessory and checking it matches the original within the clearance. Output: a fitted print that seats.
- **Phase 2, placement UI.** The browser app around that script: load, snap to a point, nudge with gizmos, overlap preview, Fit, export. Output: a brand-new accessory fitted without touching code.
- **Phase 3, polish.** Whatever the first real uses ask for: embossed polarity marks, batch fitting of several accessories, minimum-thickness warnings, goose-side pocket export, the offline repair path for messy downloads.

**Painting before export.** After Fit, a brush tool colours faces of the accessory in the viewer, with a palette of filament colours and a bucket fill bounded by sharp edges. STL cannot carry colour, so painted models export as 3MF, which Bambu Studio, PrusaSlicer and OrcaSlicer read as paint-on colour regions for multi-material printing (plain STL export stays for single-colour parts). Painting happens after Fit so the cut and pocket faces exist to be painted, and the brush uses the same BVH as snapping. Landing: a first brush and 3MF export in Phase 2, fill and edge-aware tools in Phase 3.

## Accessory models: downloaded, not generated

Accessories built from primitives (cones, spheres, tori) look crude next to
the goose, so the library is made of downloaded models: hats, scarves,
glasses, holiday items from Printables, Thingiverse, MakerWorld, Thangs or
Cults3D, kept with their licence in `accessories/<name>/`. The app's job is
to make any such model fit fast:

1. **Import** STL, OBJ or 3MF (several parts are joined), by file picker or drag and drop.
2. **Prepare**: choose the side that meets the goose, scale to a width (or a factor, for models in inches), centre on the whole model or its bottom face, and add a plug of solid material under hollow models so there is something to carve and to hold the magnet.
3. **Place and fit** at a magnet point as before, then paint and export.

**Clothing.** Shirts, sweaters and coats follow the body instead of a
magnet point and need no magnets. The goose is sampled as a radial profile
around a vertical axis through the body; sweeping that profile downward
(each section grows to contain everything above it) gives the smallest
shape a rigid garment can slide down over, with no undercuts near the hem.
The garment is that shape offset by a clearance (inside) and by clearance
plus wall thickness (outside), lofted into one shell between a hem and a
neck height. The collar has two modes: *tilt* (default) follows the body
below the neck and opens at the front where the head and beak pass, so the
garment goes on tilted, beak first; *drop* makes every section clear the
head and beak so it drops straight on, at the cost of a front wall that
stands about 25 mm off the chest. A downloaded garment is handled the same
way: its vertices keep their height fraction, angle and distance from the
garment's own inner surface and are re-seated on the goose's profile, then
the drop-on solid is subtracted so it is hollow and slides over the head.
Ribs, buttons and collars survive the stretch; sleeves come along as bumps.
Closed bottoms (pen-pot garments) are cut off, and the top of the model can
keep its proportions while the rest stretches to the hem.

The generated shirt is the base design with options layered on it, as
Jerred suggested on 2026-11-03: neckline (V, scoop or crew, depth and
width, at the front, which is found automatically from where the head is),
a collar tube, fabric (ribbed knit or quilted puffer rows), buttons and a
placket, a ribbed hem band, and painted stripes. Each is a small bump on
the garment's radial profile or a cut, so they are cheap and never break
the drop-on shape.

**A leaning axis.** The goose's neck sits well forward of the body's
centre, so a garment built around a vertical axis through the body has its
collar behind the neck. The garment is now built in a sheared frame in
which the line from the body's centre at the hem to the neck's centre at
the collar is vertical, and sheared back afterwards: the collar is centred
on the neck and the garment slides on along that lean (the `axisToNeck`
option, 0 to 1). Horizontal sections are unchanged by the shear, so the
profile, clearance and collar all work as before.

**Lining up a wrap.** The loaded model is shown as a ghost where the wrap
will put it (turned to face the front, scaled to the body's mean radius,
leaned), and can be turned about its axis, shifted, limited to a band of
its height and cropped on each side before wrapping; the rest is cut away.
A *liner* puts a smooth shell of the body's drop-on shape under the model,
moving it out by the same amount, so a thin or noisy mesh (the polo's fine
knit) has solid material behind it instead of slivers where the carve
grazes it. The front is oriented by the lean itself, not by where the head
sits in the sheared frame, where it can end up behind the axis. The
model's reference radii (its own inner and outer surface per angle and
height band) are read with bilinear interpolation, so the seat does not
step from band to band, which showed as horizontal stripes. A *neck
spread* opens the collar out from the neck and chest by a set amount,
blended in over the top of the garment, for shirts and wraps alike.

**Split halves (Jerred, 2026-11-03).** Any garment can be cut in two along
a plane through the leaned axis, left/right or front/back, with disc-magnet
pockets (3 x 1 mm by default, 0.3 mm of play) facing each other across each
seam. Where the wall is thinner than the magnet needs, a small round pad is
added on the outside of the seam first. Because the halves clip on, the
drop-on constraint can be dropped: the *form fit* option follows the body
as it is, into the chest and under the tail, with only the clearance
around it.

## Still needed from Jerred

- [ ] The goose base STL with the magnet voids in it, the exact file sliced from. It gets bundled into the app at `goose/goose.stl`.
- [ ] Optional: one or two existing accessory STLs, as the Phase 1 regression test.
- [ ] Magnet dimensions: diameter and thickness (for example 6 x 3 mm disc), and whether they are glued, press-fit, or embedded mid-print.
- [ ] Which pole faces outward at each goose point, if known. If not, Phase 0 pucks will find out.
- [ ] Printer, nozzle and layer height, so the clearance guesses start in the right place.
- [ ] Browser app (recommended) or Blender add-on.

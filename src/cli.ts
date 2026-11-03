#!/usr/bin/env node
// Headless fitting tool (Phase 1).
//
//   node src/cli.ts detect goose/goose.stl [--out goose/profile.json]
//   node src/cli.ts fit --accessory hat.stl --point head [--sink 2] [--spin 0] [--out fitted.stl]
//   node src/cli.ts hole --model goose/goose.stl --at x,y,z --name head --magnet-dia 6 --magnet-thick 3 [--embedded --skin 1] [--out goose/goose.holed.stl]
//   node src/cli.ts shirt [--hem 46] [--neck 108] [--thickness 1.6] [--clearance 0.4] [--collar tilt|drop] [--collar-gap 1]
//                         [--neckline v|scoop|crew --neckline-depth 14 --neckline-width 45] [--collar-height 0] [--fabric plain|ribbed|puffer --fabric-depth 0.4 --fabric-pitch 48]
//                         [--buttons 0 --button-dia 3 --placket] [--hem-band 0] [--stripes 0] [--out shirt.stl]
//   node src/cli.ts wrap --garment sweater.3mf [--mode auto|shell|solid] [--keep-top 30] [--floor auto|0] [--turn 15] [--shift 2,-1] [--band 10,60] [--crop left,right,front,back] [--liner 1.2] [--axis-to-neck 1] [--split sides|front-back --form-fit --split-magnets 3 --split-magnet-dia 3 --split-magnet-thick 1] [--hem 46 --neck 108 ...] [--out sweater.fitted.stl]
//
// `detect` finds the magnet voids in the goose and writes the fit profile.
// `fit` uses that profile to carve and pocket an accessory.
// `hole` cuts a magnet pocket at a picked spot (open or embedded) and adds
// the point to the profile.
// `shirt` builds a garment shell that follows the body between hem and neck.
// `wrap` stretches a downloaded garment over the body and hollows it.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readStl, writeStl } from './stl-node.ts';
import { findVoids, suggestNames } from './voids.ts';
import { addMagnetHole } from './hole.ts';
import { fromManifold } from './fit.ts';
import { DEFAULT_PROFILE, fitAccessory, toManifold, type FitProfile } from './fit.ts';
import { contourGarment, wrapGarment, DEFAULT_GARMENT, type GarmentOptions } from './clothing.ts';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { loadModel } from './load-model.ts';
import { prepareAccessory, type Side } from './prepare.ts';

const GOOSE = 'goose/goose.stl';
const PROFILE = 'goose/profile.json';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function detect() {
  const path = process.argv[3] ?? GOOSE;
  const out = arg('out', PROFILE)!;
  const mesh = readStl(path);
  const voids = findVoids(mesh);
  const names = suggestNames(voids);
  console.log(`${mesh.triangles.length / 3} triangles, ${voids.length} magnet voids found`);
  const points: FitProfile['points'] = {};
  const byIndex = new Map(Object.entries(names).map(([n, i]) => [i, n]));
  voids.forEach((v, i) => {
    const name = byIndex.get(i) ?? `void_${i + 1}`;
    points[name] = v;
    const f = (n: number) => n.toFixed(2);
    console.log(`  ${name.padEnd(10)} centre (${v.center.map(f).join(', ')})  axis (${v.axis.map(f).join(', ')})  dia ${f(v.diameter)}  depth ${f(v.depth)}`);
  });
  const existing: Partial<FitProfile> = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  const profile: FitProfile = { ...DEFAULT_PROFILE, ...existing, points };
  writeFileSync(out, JSON.stringify(profile, null, 2));
  console.log(`profile written to ${out} (names are guesses; edit them there)`);
}

async function fit() {
  const accessoryPath = arg('accessory');
  const point = arg('point');
  if (!accessoryPath || !point) throw new Error('usage: fit --accessory file.stl --point head [--sink 2] [--spin 0] [--dx 0] [--dy 0] [--magnet-dia 6] [--magnet-thick 3] [--pocket-radial 0] [--pocket-axial 0.1] [--no-pocket] [--out fitted.stl]');
  const num = (name: string) => (arg(name) === undefined ? undefined : Number(arg(name)));
  const profile: FitProfile = JSON.parse(readFileSync(arg('profile', PROFILE)!, 'utf8'));
  const goose = await toManifold(readStl(arg('goose', GOOSE)!));
  const accessory = await toManifold(readStl(accessoryPath));
  const result = await fitAccessory(goose, accessory, profile, {
    point,
    sink: Number(arg('sink', '2')),
    spin: Number(arg('spin', '0')),
    offset: [Number(arg('dx', '0')), Number(arg('dy', '0'))],
    pocket: {
      diameter: num('magnet-dia'),
      thickness: num('magnet-thick'),
      radialClearance: num('pocket-radial'),
      axialClearance: num('pocket-axial'),
      none: process.argv.includes('--no-pocket'),
    },
  });
  const out = arg('out', accessoryPath.replace(/\.stl$/i, '') + `.${point}.fitted.stl`)!;
  writeStl(out, result.mesh);
  console.log(`fitted ${accessoryPath} at ${point}: volume ${result.volumeBefore.toFixed(0)} → ${result.volumeAfter.toFixed(0)} mm³, ${result.bodies} body`);
  for (const w of result.warnings) console.log(`  warning: ${w}`);
  console.log(`written to ${out}`);
}

async function hole() {
  const modelPath = arg('model', GOOSE)!;
  const at = arg('at')?.split(',').map(Number);
  const name = arg('name');
  const dia = arg('magnet-dia'), thick = arg('magnet-thick');
  if (!at || at.length !== 3 || !name || !dia || !thick) {
    throw new Error('usage: hole --model goose/goose.stl --at x,y,z --name head --magnet-dia 6 --magnet-thick 3 [--embedded] [--skin 1] [--pocket-radial 0] [--pocket-axial 0.1] [--axis x,y,z] [--profile goose/profile.json] [--out model.holed.stl]');
  }
  const profilePath = arg('profile', PROFILE)!;
  const mesh = readStl(modelPath);
  const model = await toManifold(mesh);
  const embedded = process.argv.includes('--embedded');
  const result = await addMagnetHole(model, mesh, {
    point: at as [number, number, number],
    axis: arg('axis')?.split(',').map(Number) as [number, number, number] | undefined,
    diameter: Number(dia),
    thickness: Number(thick),
    radialClearance: arg('pocket-radial') ? Number(arg('pocket-radial')) : undefined,
    axialClearance: arg('pocket-axial') ? Number(arg('pocket-axial')) : undefined,
    mode: embedded ? 'embedded' : 'open',
    skin: arg('skin') ? Number(arg('skin')) : undefined,
  });
  const out = arg('out', modelPath.replace(/\.stl$/i, '') + '.holed.stl')!;
  writeStl(out, fromManifold(result.model));
  const existing: Partial<FitProfile> = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : {};
  const profile: FitProfile = { ...DEFAULT_PROFILE, ...existing, points: { ...(existing.points ?? {}), [name]: result.point } };
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  const f = (n: number) => n.toFixed(2);
  console.log(`${result.point.mode} hole "${name}" at (${result.point.center.map(f).join(', ')}) axis (${result.point.axis.map(f).join(', ')}), ${f(result.point.diameter)} dia x ${f(result.point.depth)} deep`);
  if (result.pauseZ !== undefined) console.log(`  pause the print at Z = ${f(result.pauseZ)} mm to insert the magnet`);
  console.log(`model written to ${out}, point added to ${profilePath}`);
}

function garmentArgs(): Partial<GarmentOptions> {
  const num = (name: string) => (arg(name) !== undefined ? Number(arg(name)) : undefined);
  const flag = (name: string) => process.argv.includes(`--${name}`) ? true : undefined;
  const o: Partial<GarmentOptions> = {
    hem: num('hem'), neck: num('neck'), thickness: num('thickness'), clearance: num('clearance'),
    collar: arg('collar') as GarmentOptions['collar'], collarGap: num('collar-gap'), smooth: num('smooth'), dz: num('dz'),
    neckline: arg('neckline') as GarmentOptions['neckline'], necklineDepth: num('neckline-depth'), necklineWidth: num('neckline-width'),
    collarHeight: num('collar-height'), front: num('front'), frontOffset: num('front-offset'), axisToNeck: num('axis-to-neck'),
    fabric: arg('fabric') as GarmentOptions['fabric'], fabricDepth: num('fabric-depth'), fabricPitch: num('fabric-pitch'),
    buttons: num('buttons'), buttonDiameter: num('button-dia'), placket: flag('placket'), hemBand: num('hem-band'), stripes: num('stripes'),
    formFit: flag('form-fit'), split: arg('split') as GarmentOptions['split'], splitMagnets: num('split-magnets'),
    splitMagnetDiameter: num('split-magnet-dia'), splitMagnetThickness: num('split-magnet-thick'),
  };
  for (const k of Object.keys(o) as (keyof GarmentOptions)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** The halves of a split garment next to the whole, as <out>.a.stl and <out>.b.stl. */
function writeParts(out: string, parts?: ManifoldT[]) {
  if (!parts || parts.length < 2) return;
  parts.forEach((p, i) => {
    const path = out.replace(/\.stl$/i, '') + `.${'ab'[i] ?? i}.stl`;
    writeStl(path, fromManifold(p));
    console.log(`half ${i + 1} written to ${path}`);
  });
}

async function shirt() {
  const goose = await toManifold(readStl(arg('goose', GOOSE)!));
  const o = { ...DEFAULT_GARMENT, ...garmentArgs() };
  const t0 = performance.now();
  const g = await contourGarment(goose, o);
  const out = arg('out', `shirt.${o.hem}-${o.neck}.stl`)!;
  writeStl(out, g.mesh);
  writeParts(out, g.parts);
  const bb = g.solid.boundingBox();
  console.log(`shirt from z=${o.hem} to ${o.neck}, ${o.thickness} mm walls, ${o.clearance} mm clearance, collar ${o.collar}: ${g.solid.volume().toFixed(0)} mm³, ${bb.max.map((v, i) => (v - bb.min[i]).toFixed(1)).join(' x ')} mm in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  for (const w of g.warnings) console.log(`  ${w}`);
  console.log(`written to ${out}`);
}

async function wrap() {
  const garmentPath = arg('garment');
  if (!garmentPath) throw new Error('--garment <file> is required');
  const goose = await toManifold(readStl(arg('goose', GOOSE)!));
  const { solid: raw } = await loadModel(garmentPath, readFileSync(garmentPath));
  const prepared = await prepareAccessory(raw, { down: (arg('down', '-z') as Side), scale: Number(arg('scale', '1')), centre: 'bbox' });
  const pair = (name: string) => { const v = arg(name); return v === undefined ? undefined : v.split(',').map(Number) as [number, number]; };
  const o = {
    ...DEFAULT_GARMENT, ...garmentArgs(), mode: (arg('mode', 'auto') as 'auto' | 'shell' | 'solid'), keepTop: Number(arg('keep-top', '0')),
    floor: arg('floor') === undefined ? 'auto' as const : Number(arg('floor')),
    garmentTurn: Number(arg('turn', '0')), garmentShift: pair('shift'), garmentBand: pair('band'), liner: Number(arg('liner', '0')),
    garmentCrop: arg('crop') === undefined ? undefined : arg('crop')!.split(',').map(Number) as [number, number, number, number],
  };
  const t0 = performance.now();
  const g = await wrapGarment(prepared.solid, goose, o);
  const out = arg('out', garmentPath.replace(/\.(stl|obj|3mf)$/i, '') + '.fitted.stl')!;
  writeStl(out, g.mesh);
  writeParts(out, g.parts);
  console.log(`wrapped ${garmentPath} (${g.mode}) onto the goose from z=${o.hem} to ${o.neck}: ${raw.volume().toFixed(0)} → ${g.solid.volume().toFixed(0)} mm³ in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  for (const w of g.warnings) console.log(`  ${w}`);
  console.log(`written to ${out}`);
}

const cmd = process.argv[2];
const run = cmd === 'detect' ? detect : cmd === 'fit' ? fit : cmd === 'hole' ? hole : cmd === 'shirt' ? shirt : cmd === 'wrap' ? wrap : null;
if (!run) {
  console.error('commands: detect, fit, hole, shirt, wrap');
  process.exit(2);
}
run().catch((e) => { console.error(e.message ?? e); process.exit(1); });

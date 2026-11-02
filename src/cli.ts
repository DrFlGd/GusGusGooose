#!/usr/bin/env node
// Headless fitting tool (Phase 1).
//
//   node src/cli.ts detect goose/goose.stl [--out goose/profile.json]
//   node src/cli.ts fit --accessory hat.stl --point head [--sink 2] [--spin 0] [--out fitted.stl]
//   node src/cli.ts hole --model goose/goose.stl --at x,y,z --name head --magnet-dia 6 --magnet-thick 3 [--embedded --skin 1] [--out goose/goose.holed.stl]
//
// `detect` finds the magnet voids in the goose and writes the fit profile.
// `fit` uses that profile to carve and pocket an accessory.
// `hole` cuts a magnet pocket at a picked spot (open or embedded) and adds
// the point to the profile.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readStl, writeStl } from './stl.ts';
import { findVoids, suggestNames } from './voids.ts';
import { addMagnetHole } from './hole.ts';
import { fromManifold } from './fit.ts';
import { DEFAULT_PROFILE, fitAccessory, toManifold, type FitProfile } from './fit.ts';

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

const cmd = process.argv[2];
const run = cmd === 'detect' ? detect : cmd === 'fit' ? fit : cmd === 'hole' ? hole : null;
if (!run) {
  console.error('commands: detect, fit, hole');
  process.exit(2);
}
run().catch((e) => { console.error(e.message ?? e); process.exit(1); });

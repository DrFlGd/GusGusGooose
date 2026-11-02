#!/usr/bin/env node
// Headless fitting tool (Phase 1).
//
//   node src/cli.ts detect goose/goose.stl [--out goose/profile.json]
//   node src/cli.ts fit --accessory hat.stl --point head [--sink 2] [--spin 0] [--out fitted.stl]
//
// `detect` finds the magnet voids in the goose and writes the fit profile.
// `fit` uses that profile to carve and pocket an accessory.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readStl, writeStl } from './stl.ts';
import { findVoids, suggestNames } from './voids.ts';
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
  if (!accessoryPath || !point) throw new Error('usage: fit --accessory file.stl --point head [--sink 2] [--spin 0] [--dx 0] [--dy 0] [--out fitted.stl]');
  const profile: FitProfile = JSON.parse(readFileSync(arg('profile', PROFILE)!, 'utf8'));
  const goose = await toManifold(readStl(arg('goose', GOOSE)!));
  const accessory = await toManifold(readStl(accessoryPath));
  const result = await fitAccessory(goose, accessory, profile, {
    point,
    sink: Number(arg('sink', '2')),
    spin: Number(arg('spin', '0')),
    offset: [Number(arg('dx', '0')), Number(arg('dy', '0'))],
  });
  const out = arg('out', accessoryPath.replace(/\.stl$/i, '') + `.${point}.fitted.stl`)!;
  writeStl(out, result.mesh);
  console.log(`fitted ${accessoryPath} at ${point}: volume ${result.volumeBefore.toFixed(0)} → ${result.volumeAfter.toFixed(0)} mm³, ${result.bodies} body`);
  for (const w of result.warnings) console.log(`  warning: ${w}`);
  console.log(`written to ${out}`);
}

const cmd = process.argv[2];
const run = cmd === 'detect' ? detect : cmd === 'fit' ? fit : null;
if (!run) {
  console.error('commands: detect, fit');
  process.exit(2);
}
run().catch((e) => { console.error(e.message ?? e); process.exit(1); });

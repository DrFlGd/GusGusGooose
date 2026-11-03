// A Santa hat for the head point, built from primitives with Manifold.
// Accessory frame: base centred on the origin, +Z up. Run:
//
//   node accessories/santa-hat.ts [out.stl]
//
// Then fit it: npm run fit -- --accessory accessories/out/santa-hat.stl --point head --sink 3

import { mkdirSync } from 'node:fs';
import { writeStl } from '../src/stl-node.ts';
import { fromManifold, manifold } from '../src/fit.ts';

export async function santaHat(opts = { brimRadius: 15, brimTube: 3.5, coneHeight: 34, lean: 10, pom: 4.5 }) {
  const { Manifold, CrossSection } = await manifold();
  const { brimRadius, brimTube, coneHeight, lean, pom } = opts;
  const r0 = brimRadius - brimTube * 0.4; // cone base tucks into the brim
  // the cone leans over: a stack of shrinking discs, each shifted along +x
  const slices = 12;
  const discs = [];
  for (let i = 0; i <= slices; i++) {
    const t = i / slices;
    const r = r0 * (1 - t) + 1.2 * t;
    const z = coneHeight * t;
    const x = lean * t * t;
    discs.push(Manifold.cylinder(0.01, r, r, 64, false).translate(x, 0, z));
  }
  let cone = Manifold.hull(discs);
  // the tip flops down: hull of the last disc and a pom-sized sphere below and beside it
  const tipX = lean + 6, tipZ = coneHeight - 4;
  const flop = Manifold.hull([discs[slices], Manifold.sphere(1.5, 24).translate(tipX, 0, tipZ)]);
  cone = cone.add(flop);
  const pomSphere = Manifold.sphere(pom, 48).translate(tipX + 1, 0, tipZ - 1);
  // brim: a torus, sitting on the base plane
  const ring = CrossSection.circle(brimTube, 32).translate(brimRadius, 0);
  const brim = Manifold.revolve(ring, 96).translate(0, 0, brimTube);
  // a solid floor under the brim so the hat has a flat base to carve
  const floor = Manifold.cylinder(brimTube, brimRadius, brimRadius, 96, false);
  const hat = Manifold.union([cone.translate(0, 0, brimTube), brim, floor, pomSphere]);
  return hat;
}

if (process.argv[1]?.endsWith('santa-hat.ts')) {
  const out = process.argv[2] ?? 'accessories/out/santa-hat.stl';
  mkdirSync('accessories/out', { recursive: true });
  const hat = await santaHat();
  const bb = hat.boundingBox();
  writeStl(out, fromManifold(hat));
  console.log(`santa hat: ${hat.volume().toFixed(0)} mm³, ${bb.max.map((v, i) => (v - bb.min[i]).toFixed(1)).join(' x ')} mm, written to ${out}`);
}

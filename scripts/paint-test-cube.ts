// A 30 mm cube with discs painted across its big triangles, as a 3MF of slicer paint
// codes, to check that Bambu Studio / PrusaSlicer read paint inside faces as the app
// writes it. Draw how it should look with scripts/paint-test-view.mjs.
//
//   node scripts/paint-test-cube.ts out.3mf && node scripts/paint-test-view.mjs out.3mf out.png
import { writeFileSync } from 'node:fs';
import { manifold, fromManifold } from '../src/fit.ts';
import { PaintModel } from '../src/paint-model.ts';
import { write3mf } from '../src/threemf-write.ts';

const { Manifold } = await manifold();
// a 30 mm cube: two triangles per side, so every circle below lies across big triangles
const mesh = fromManifold(Manifold.cube([30, 30, 30], true).translate([0, 0, 15]));
const model = new PaintModel(mesh);
model.brush({ x: 0, y: 0, z: 30 }, 9, 1);        // a red disc in the middle of the top, across its diagonal
model.brush({ x: 0, y: 0, z: 30 }, 4, 2);        // a blue dot in the middle of the red disc
model.brush({ x: 15, y: 7, z: 20 }, 4, 2);       // a blue dot near the top right of the +x side
model.brush({ x: 15, y: -8, z: 8 }, 2.5, 1);     // a small red dot low on the left of the +x side
model.brush({ x: 0, y: -15, z: 15 }, 6, 3);      // a yellow disc in the middle of the -y side
const palette = [{ name: 'White', color: '#ffffff' }, { name: 'Red', color: '#d03b2f' }, { name: 'Blue', color: '#4f8bd6' }, { name: 'Yellow', color: '#f2d44b' }];
const codes = model.paintCodes((m) => (m ? m + 1 : 0));
writeFileSync(process.argv[2] ?? 'paint-inside-faces-cube.3mf', write3mf(mesh, palette, model.faceMaterial, 'paint test cube', codes));
console.log(mesh.triangles.length / 3, 'triangles,', model.trees.size, 'painted in part; code lengths', codes.map((c) => c.length).join(' '));

// writes the goose's drop-on shape between hem and neck (what a garment must clear), in the goose's frame, plus the body section stats
import { toManifold, fromManifold } from '../../src/fit.ts';
import { readStl, writeStl } from '../../src/stl-node.ts';
import { cavityProfile, loftSolid, shearManifold, clipProfile, DEFAULT_GARMENT } from '../../src/clothing.ts';
const goose = await toManifold(readStl('goose/goose.stl'));
const o = { ...DEFAULT_GARMENT, hem: 46, neck: 108 };
const cav = cavityProfile(goose, o);
const core = clipProfile(cav.inner, o.hem, o.neck);
let solid = await toManifold(loftSolid(core));
solid = shearManifold(solid, cav.shear, 1);
writeStl(process.argv[2], fromManifold(solid));
const bb = solid.boundingBox();
console.log('cavity bbox', bb.min.map(v => v.toFixed(1)).join(','), '->', bb.max.map(v => v.toFixed(1)).join(','), 'centre', cav.inner.cx.toFixed(1), cav.inner.cy.toFixed(1), 'front', (cav.front * 180 / Math.PI).toFixed(1), 'shear', cav.shear);
for (const z of [40, 50, 60, 72, 85, 100, 112]) { const cs = solid.slice(z); const bb2 = cs.bounds(); console.log('z', z, 'area', cs.area().toFixed(0), 'w', (bb2.max[0]-bb2.min[0]).toFixed(1), 'd', (bb2.max[1]-bb2.min[1]).toFixed(1)); }
const gb = goose.boundingBox(); console.log('goose bbox', gb.min.map(v => v.toFixed(1)).join(','), '->', gb.max.map(v => v.toFixed(1)).join(','));
for (const z of [120, 140, 160, 175]) { const cs = goose.slice(z); const b = cs.bounds(); console.log('goose z', z, 'w', (b.max[0]-b.min[0]).toFixed(1), 'd', (b.max[1]-b.min[1]).toFixed(1), 'x', b.min[0].toFixed(1), b.max[0].toFixed(1), 'y', b.min[1].toFixed(1), b.max[1].toFixed(1)); }
// the inner profile in the sheared frame, for modelling the soft parts against the body in Blender
const { writeFileSync } = await import('node:fs');
writeFileSync(process.argv[3], JSON.stringify({ cx: cav.inner.cx, cy: cav.inner.cy, z: Array.from(cav.inner.z), r: cav.inner.r.map((row) => Array.from(row)), nTheta: cav.inner.nTheta, front: cav.front, shear: { sx: cav.shear.sx, sy: cav.shear.sy, z0: cav.shear.z0 }, hem: o.hem, neck: o.neck }));
console.log('profile written', cav.inner.z.length, 'rings x', cav.inner.nTheta);

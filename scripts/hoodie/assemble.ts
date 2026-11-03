// Unions the shirt body with the Blender-made parts, keeps the body clear of the goose's drop-on shape, and writes one STL.
//   node assemble.ts <dir> <out.stl>
import { readdirSync } from 'node:fs';
import { manifold, toManifold, fromManifold } from '../../src/fit.ts';
import { readStl, writeStl } from '../../src/stl-node.ts';
const [dir, outPath] = process.argv.slice(2);
const { Manifold } = await manifold();
const body = await toManifold(readStl(`${dir}/${process.env.BODY ?? 'body.stl'}`));
const cavity = await toManifold(readStl(`${dir}/cavity.stl`));
const parts = [body];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.stl') && !['body.stl', 'body_fabric.stl', 'cavity.stl', 'hoodie.stl'].includes(f))) {
  try {
    const m = await toManifold(readStl(`${dir}/${f}`));
    parts.push(m);
    console.log(f, m.numTri(), 'tris', m.volume().toFixed(0), 'mm3', 'status', m.status());
  } catch (e) {
    console.log(f, 'skipped:', (e as Error).message);
  }
}
let all = Manifold.union(parts);
// nothing may reach inside the drop-on shape (clearance already included in the body)
all = all.subtract(cavity.scale([1, 1, 1]));
const bodies = all.decompose().filter((b) => b.volume() > 1);
console.log('pieces', bodies.map((b) => b.volume().toFixed(0)).join(', '));
const result = bodies.length > 1 ? Manifold.union(bodies) : bodies[0];
writeStl(outPath, fromManifold(result));
console.log('written', outPath, result.numTri(), 'tris', result.volume().toFixed(0), 'mm3');

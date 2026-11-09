// CLI for the slide-in-magnet print (the geometry is in slots-build.ts):
//
//   node src/build-slots.ts [goose/goose.3mf] [--voids goose/goose-voids.3mf] [--out goose/goose-slots.3mf] [--parts dir]
//                           [--style swept|flat] [--key side|upright] [--clear 0.15] [--key-clear 0.2] [--gap 1] [--proud 1.5] [--no-tongue]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { read3mf } from './threemf.ts';
import { buildSlots, layoutBuild } from './slots-build.ts';
import { DEFAULT_SLOTS, type SlotOptions } from './slots.ts';
import { write3mfBuild } from './threemf-write.ts';
import { serializeStl } from './stl.ts';

export { buildSlots, layoutBuild, layFlat, MOUTHS, type SlotsBuild } from './slots-build.ts';

if (process.argv[1]?.endsWith('build-slots.ts')) {
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  const opt = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const flag = (name: string) => process.argv.includes(`--${name}`);
  const src = positional[0] ?? 'goose/goose.3mf';
  const voidsPath = opt('voids') ?? 'goose/goose-voids.3mf';
  const out = opt('out') ?? 'goose/goose-slots.3mf';
  const partsDir = opt('parts');
  const options: SlotOptions = {
    ...DEFAULT_SLOTS,
    style: (opt('style') as SlotOptions['style']) ?? DEFAULT_SLOTS.style,
    keyEnd: opt('key') === 'upright' ? 'level' : 'square',
    channelClear: Number(opt('clear') ?? DEFAULT_SLOTS.channelClear),
    keyClear: Number(opt('key-clear') ?? DEFAULT_SLOTS.keyClear),
    keyGap: Number(opt('gap') ?? DEFAULT_SLOTS.keyGap),
    tongue: flag('no-tongue') ? null : { ...DEFAULT_SLOTS.tongue!, proud: Number(opt('proud') ?? DEFAULT_SLOTS.tongue!.proud) },
  };
  const parts = read3mf(src), voidParts = read3mf(voidsPath);
  console.log(`${parts.length} parts in ${src}, voids from ${voidsPath}; ${options.style} channels, ${options.keyEnd === 'level' ? 'upright' : 'side'} keys, clearances ${options.channelClear}/${options.keyClear}, gap ${options.keyGap}${options.tongue ? `, tongue ${options.tongue.proud} mm proud` : ', no tongue'}`);
  const b = await buildSlots(parts, voidParts, options);
  const objects = layoutBuild(b);
  writeFileSync(out, write3mfBuild(objects, b.materials, 'Gus Gus Goose, slide-in magnets'));
  console.log(`written ${out}: ${objects.map((o) => o.name).join(', ')}; materials ${b.materials.map((m, i) => `${i + 1} ${m.name} ${m.color}`).join(', ')}`);
  if (partsDir) {
    if (!existsSync(partsDir)) mkdirSync(partsDir, { recursive: true });
    for (const o of objects) for (const p of o.parts) writeFileSync(join(partsDir, `${o.name === p.name ? p.name : `${o.name}-${p.name}`}.stl`.replace(/\s+/g, '-')), serializeStl(p.mesh));
    console.log(`STLs in ${partsDir}`);
  }
  for (const n of b.notes) console.log(`  note: ${n}`);
  const bodies = b.goose.body.decompose().length;
  console.log(`body: ${b.goose.body.volume().toFixed(1)} mm³ (${(b.bodySolid.volume() - b.goose.body.volume()).toFixed(1)} mm³ removed), ${bodies} piece${bodies === 1 ? '' : 's'}, ${b.goose.body.numTri()} triangles`);
}

// Makes the app's otter from Jerred's model (characters/otter/otter-source.stl):
// painted after the concept art, trimmed flat, magnet seats in the head and
// chest (the geometry is in otter.ts). Writes the files the app serves beside
// the goose, and optionally the painted figure and the slide-in print as 3MFs.
//
//   node src/build-otter.ts [characters/otter/otter-source.stl] [--dir goose] [--painted otter-painted.3mf] [--print otter-slots.3mf]
//                           [--style swept|flat] [--key side|upright] [--clear 0.15] [--key-clear 0.2] [--gap 1] [--parts dir]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStl } from './stl-node.ts';
import { parseStl, serializeStl, survivesRoundTrip } from './stl.ts';
import { buildOtterBody, buildOtterSlots, layoutOtter, otterPaint, OTTER_MATERIALS, paintOtter, wholeFaceCodes } from './otter.ts';
import { DEFAULT_SLOTS, type SlotOptions } from './slots.ts';
import { write3mf, write3mfBuild } from './threemf-write.ts';
import { fromManifoldTagged } from './fit.ts';
import type { GooseColors } from './goose-colors.ts';

if (process.argv[1]?.endsWith('build-otter.ts')) {
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  const opt = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const src = positional[0] ?? 'characters/otter/otter-source.stl';
  const dir = opt('dir') ?? 'goose';
  const source = readStl(src);
  console.log(`${src}: ${source.triangles.length / 3} triangles`);
  let t = Date.now();
  const paint = paintOtter(source);
  const counts = OTTER_MATERIALS.map((_, m) => paint.reduce((n, x) => n + (x === m ? 1 : 0), 0));
  console.log(`painted in ${((Date.now() - t) / 1000).toFixed(1)} s: ${OTTER_MATERIALS.map((m, i) => `${m.name} ${counts[i]}`).join(', ')} triangles`);
  t = Date.now();
  const otter = await buildOtterBody(source, paint);
  // the app's files: the mesh with the seats cut, its colours (kept aligned with what the STL reads back as) and the fit profile
  const keep = survivesRoundTrip(otter.mesh);
  const faceMaterial = otter.faceMaterial.filter((_, i) => keep[i]);
  const runs: [number, number][] = [];
  for (const m of faceMaterial) { if (runs.length && runs[runs.length - 1][0] === m) runs[runs.length - 1][1]++; else runs.push([m, 1]); }
  const stl = serializeStl(otter.mesh);
  const readBack = parseStl(stl).triangles.length / 3;
  if (readBack !== faceMaterial.length) throw new Error(`colours cover ${faceMaterial.length} triangles but the STL reads back as ${readBack}`);
  writeFileSync(join(dir, 'otter.stl'), stl);
  writeFileSync(join(dir, 'otter-colors.json'), JSON.stringify({ materials: OTTER_MATERIALS, runs } satisfies GooseColors));
  writeFileSync(join(dir, 'otter-profile.json'), JSON.stringify(otter.profile, null, 2));
  console.log(`written ${dir}/otter.stl (${readBack} triangles), otter-colors.json (${runs.length} runs), otter-profile.json (${Object.keys(otter.profile.points).join(', ')}) in ${((Date.now() - t) / 1000).toFixed(1)} s`);

  const painted = opt('painted');
  if (painted) {
    const whole = fromManifoldTagged(otter.solid, otter.firstID, OTTER_MATERIALS.length, 0);
    writeFileSync(painted, write3mf(whole.mesh, OTTER_MATERIALS, whole.faceMaterial, 'Sea otter', wholeFaceCodes(whole.faceMaterial)));
    console.log(`written ${painted}: the painted otter, flat base, no magnets`);
  }
  const print = opt('print');
  if (print) {
    const options: SlotOptions = {
      ...DEFAULT_SLOTS,
      style: (opt('style') as SlotOptions['style']) ?? DEFAULT_SLOTS.style,
      keyEnd: opt('key') === 'upright' ? 'level' : 'square',
      channelClear: Number(opt('clear') ?? DEFAULT_SLOTS.channelClear),
      keyClear: Number(opt('key-clear') ?? DEFAULT_SLOTS.keyClear),
      keyGap: Number(opt('gap') ?? DEFAULT_SLOTS.keyGap),
      tongue: null,
    };
    const b = await buildOtterSlots(otter.body, otter.profile, options);
    const objects = layoutOtter(b, otterPaint(b, otter.firstID));
    writeFileSync(print, write3mfBuild(objects, OTTER_MATERIALS, 'Sea otter, slide-in magnets'));
    console.log(`written ${print}: ${objects.map((o) => o.name).join(', ')}; ${options.style} channels, ${options.keyEnd === 'level' ? 'upright' : 'side'} keys`);
    const partsDir = opt('parts');
    if (partsDir) {
      if (!existsSync(partsDir)) mkdirSync(partsDir, { recursive: true });
      for (const o of objects) for (const p of o.parts) writeFileSync(join(partsDir, `${p.name.replace(/\s+/g, '-')}.stl`), serializeStl(p.mesh));
      console.log(`STLs in ${partsDir}`);
    }
    for (const n of b.notes) console.log(`  note: ${n}`);
  }
}

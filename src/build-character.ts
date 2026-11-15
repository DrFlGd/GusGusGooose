// Makes the app's otter or bear from its source model (characters/<id>/):
// painted, trimmed flat, magnet seats cut (the geometry is in otter.ts and
// bear.ts). Writes the files the app serves beside the goose (<id>.stl,
// <id>-colors.json, <id>-profile.json), and optionally the painted figure and
// the slide-in print as 3MFs.
//
//   node src/build-character.ts otter|bear [source.stl] [--dir goose] [--painted <id>-painted.3mf] [--print <id>-slots.3mf]
//                               [--style swept|flat] [--key side|upright] [--clear 0.15] [--key-clear 0.2] [--gap 1] [--parts dir]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStl } from './stl-node.ts';
import { parseStl, serializeStl, survivesRoundTrip } from './stl.ts';
import { characterPaint, layoutCharacter, wholeFaceCodes } from './desk-character.ts';
import { buildSlideIn, SLIDE_IN_CHARACTERS, slideInCharacter } from './slide-in-characters.ts';
import { DEFAULT_SLOTS, type SlotOptions } from './slots.ts';
import { write3mf, write3mfBuild } from './threemf-write.ts';
import { fromManifoldTagged } from './fit.ts';
import type { GooseColors } from './goose-colors.ts';

if (process.argv[1]?.endsWith('build-character.ts')) {
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  const opt = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const c = slideInCharacter(positional[0]);
  if (!c) throw new Error(`which character? ${Object.keys(SLIDE_IN_CHARACTERS).join(' or ')}`);
  const src = positional[1] ?? c.source;
  const dir = opt('dir') ?? 'goose';
  const source = readStl(src);
  console.log(`${src}: ${source.triangles.length / 3} triangles`);
  let t = Date.now();
  const paint = c.paint(source);
  const counts = c.materials.map((_, m) => paint.reduce((n, x) => n + (x === m ? 1 : 0), 0));
  console.log(`painted in ${((Date.now() - t) / 1000).toFixed(1)} s: ${c.materials.map((m, i) => `${m.name} ${counts[i]}`).join(', ')} triangles`);
  t = Date.now();
  const built = await c.buildBody(source, paint);
  // the app's files: the mesh with the seats cut, its colours (kept aligned with what the STL reads back as) and the fit profile
  const keep = survivesRoundTrip(built.mesh);
  const faceMaterial = built.faceMaterial.filter((_, i) => keep[i]);
  const runs: [number, number][] = [];
  for (const m of faceMaterial) { if (runs.length && runs[runs.length - 1][0] === m) runs[runs.length - 1][1]++; else runs.push([m, 1]); }
  const stl = serializeStl(built.mesh);
  const readBack = parseStl(stl).triangles.length / 3;
  if (readBack !== faceMaterial.length) throw new Error(`colours cover ${faceMaterial.length} triangles but the STL reads back as ${readBack}`);
  writeFileSync(join(dir, `${c.id}.stl`), stl);
  writeFileSync(join(dir, `${c.id}-colors.json`), JSON.stringify({ materials: c.materials, runs } satisfies GooseColors));
  writeFileSync(join(dir, `${c.id}-profile.json`), JSON.stringify(built.profile, null, 2));
  console.log(`written ${dir}/${c.id}.stl (${readBack} triangles), ${c.id}-colors.json (${runs.length} runs), ${c.id}-profile.json (${Object.keys(built.profile.points).join(', ')}) in ${((Date.now() - t) / 1000).toFixed(1)} s`);

  const painted = opt('painted');
  if (painted) {
    const whole = fromManifoldTagged(built.solid, built.firstID, c.materials.length, 0);
    writeFileSync(painted, write3mf(whole.mesh, c.materials, whole.faceMaterial, c.name, wholeFaceCodes(whole.faceMaterial)));
    console.log(`written ${painted}: the painted ${c.id}, flat base, no magnets`);
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
    const b = await buildSlideIn(c, built.body, built.profile, options);
    const objects = layoutCharacter(b, characterPaint(b, built.firstID), c.id);
    writeFileSync(print, write3mfBuild(objects, c.materials, `${c.name}, slide-in magnets`));
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

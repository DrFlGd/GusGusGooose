// Node entry point for 3MF reading: unzips with the system `unzip` and hands
// the model files to the pure parser in threemf-parse.ts. Re-exports the
// parser's types and transform helpers so existing imports keep working.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partsFromFiles, type Part } from './threemf-parse.ts';

export { IDENTITY, applyXf, compose, invert, partsFromFiles, parse3mf, transformMesh } from './threemf-parse.ts';
export type { Part, Xf } from './threemf-parse.ts';

export function read3mf(path: string): Part[] {
  const dir = mkdtempSync(join(tmpdir(), '3mf-'));
  execFileSync('unzip', ['-o', '-q', path, '-d', dir]);
  const files = new Map<string, string>();
  for (const f of walk(dir)) {
    if (!f.endsWith('.model') && !f.endsWith('_settings.config')) continue;
    files.set('/' + f.slice(dir.length + 1).replace(/\\/g, '/'), readFileSync(f, 'utf8'));
  }
  try { return partsFromFiles(files); }
  catch (e) { throw new Error(`${path}: ${(e as Error).message}`); }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

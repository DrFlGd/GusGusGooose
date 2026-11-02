// Node file helpers around the pure STL parser.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseStl, serializeStl, type IndexedMesh } from './stl.ts';

export function readStl(path: string): IndexedMesh {
  return parseStl(readFileSync(path));
}

export function writeStl(path: string, mesh: IndexedMesh): void {
  writeFileSync(path, serializeStl(mesh));
}

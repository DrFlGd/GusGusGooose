// The goose's per-triangle colours, as written by build-goose.ts to
// goose/goose-colors.json and read by the app. Pure (no Node APIs).

import type { Material } from './threemf-write.ts';

export interface GooseColors {
  /** one per filament slot used by the goose, in slot order */
  materials: Material[];
  /** run-length encoded material index per triangle of goose.stl: [material, count] pairs */
  runs: [number, number][];
}

/** Expands the run-length encoded colours back to one material index per triangle. */
export function expandRuns(colors: GooseColors, triangleCount: number): Uint8Array {
  const out = new Uint8Array(triangleCount);
  let i = 0;
  for (const [m, n] of colors.runs) { out.fill(m, i, Math.min(triangleCount, i + n)); i += n; }
  return out;
}

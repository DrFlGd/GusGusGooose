// The desk characters made from a sculpt (the otter and the bear, unlike the
// goose, which is built from its project 3MFs): how each is painted, trimmed
// and seated (its own module), and how its slide-in channels run. The CLI
// (build-character.ts) makes each one's app files from its source model, and
// the app builds the slide-in print from those files with the same plans.
// Pure (no Node APIs).

import type { Manifold as ManifoldT } from 'manifold-3d';
import type { IndexedMesh } from './stl.ts';
import type { Material } from './threemf-write.ts';
import type { FitProfile } from './fit.ts';
import { DEFAULT_SLOTS, type SlotOptions } from './slots.ts';
import { buildCharacterSlots, type ChannelPlan, type CharacterSlotsBuild } from './desk-character.ts';
import { buildOtterBody, OTTER_MATERIALS, OTTER_PLANS, paintOtter } from './otter.ts';
import { BEAR_MATERIALS, BEAR_PLANS, buildBearBody, paintBear } from './bear.ts';

export interface CharacterBody {
  /** painted, trimmed, the seats cut: what accessories fit against */
  body: ManifoldT;
  /** the same before the seats were cut */
  solid: ManifoldT;
  faceMaterial: Uint8Array;
  mesh: IndexedMesh;
  profile: FitProfile;
  firstID: number;
}

export interface SlideInCharacter {
  id: 'otter' | 'bear';
  /** the 3MF's title */
  name: string;
  /** the model it is made from, in the repo */
  source: string;
  materials: Material[];
  plans: Record<string, ChannelPlan>;
  paint(mesh: IndexedMesh): Uint8Array;
  buildBody(source: IndexedMesh, paint: Uint8Array, log?: (s: string) => void): Promise<CharacterBody>;
}

export const SLIDE_IN_CHARACTERS: Record<SlideInCharacter['id'], SlideInCharacter> = {
  otter: { id: 'otter', name: 'Sea otter', source: 'characters/otter/otter-source.stl', materials: OTTER_MATERIALS, plans: OTTER_PLANS, paint: paintOtter, buildBody: buildOtterBody },
  bear: { id: 'bear', name: 'Bear', source: 'characters/bear/bear-source.stl', materials: BEAR_MATERIALS, plans: BEAR_PLANS, paint: paintBear, buildBody: buildBearBody },
};

export const slideInCharacter = (id: string): SlideInCharacter | undefined => SLIDE_IN_CHARACTERS[id as SlideInCharacter['id']];

/** The slide-in print from the app's character (`body`, seats already cut, and its profile). */
export function buildSlideIn(c: SlideInCharacter, body: ManifoldT, profile: FitProfile, options: SlotOptions = DEFAULT_SLOTS, log = (s: string) => console.log(s)): Promise<CharacterSlotsBuild> {
  return buildCharacterSlots(body, profile, c.plans, c.materials, options, log);
}

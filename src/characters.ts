// The desk characters accessories are made for. Each one is served as an STL
// (the solid accessories fit against, its magnet seats cut), its per-triangle
// colours and its fit profile (the magnet points), from the app's public
// folder. Pure: the app and the tests share it.

export interface Character {
  id: 'goose' | 'otter';
  /** for headings */
  name: string;
  /** the word in a sentence: "fit to the goose" */
  word: string;
  files: { stl: string; profile: string; colors: string };
  /** the clothing wrap and the neck band are made for the goose's long neck */
  clothing: boolean;
}

export const CHARACTERS: Record<Character['id'], Character> = {
  goose: { id: 'goose', name: 'Goose', word: 'goose', files: { stl: 'goose.stl', profile: 'profile.json', colors: 'goose-colors.json' }, clothing: true },
  otter: { id: 'otter', name: 'Sea otter', word: 'otter', files: { stl: 'otter.stl', profile: 'otter-profile.json', colors: 'otter-colors.json' }, clothing: false },
};

export const characterOf = (id: string | null | undefined): Character => CHARACTERS[id as Character['id']] ?? CHARACTERS.goose;

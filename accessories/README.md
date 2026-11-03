# Accessory library

Each accessory is either a generator script (`<name>.ts`, built with
Manifold primitives, parameters at the top) or an imported model
(`<name>/source.stl` plus a `LICENSE` or `SOURCE.md` naming where it came
from). Generators write their STL to `accessories/out/` (ignored by git);
fitted results are what you print.

| Accessory | Point | Kind | Status |
| --- | --- | --- | --- |
| santa-hat | head | generator | fits as one body; colour the brim and pom white in Paint |

Make one:

```sh
node accessories/santa-hat.ts
npm run fit -- --accessory accessories/out/santa-hat.stl --point head --sink 3
```

Or load `accessories/out/santa-hat.stl` in the app, pick the head, Fit,
Paint, Export 3MF.

Accessory frame for every model here: base centred on the origin, +Z up,
the −Z side meets the goose, sized for the goose (head about 25 mm wide at
the top, wings about 40 mm long, beak about 16 mm wide).

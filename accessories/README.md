# Accessory library

Accessories are downloaded models, not generated ones. Each one lives in
its own folder:

```
accessories/<name>/
  source.stl | source.obj | source.3mf   the model as downloaded
  SOURCE.md                              where it came from, author, licence, link
  fitted.<point>.stl / .3mf              what you print (ignored by git)
```

Only commit a model whose licence allows redistribution (CC-BY, CC0, MIT
and similar); otherwise keep just `SOURCE.md` with the link.

Fit one in the app: load the source file (or drop it on the view), choose
the side that meets the goose, type a width, add a plug if the model is
hollow, pick the point, Fit, Paint, Export. The same from the command line:

```sh
npm run fit -- --accessory accessories/top-hat/source.stl --point head --sink 3
```

Clothing follows the body instead of a magnet point. Make a shirt from the
goose itself, or wrap a downloaded garment over the body:

```sh
node src/cli.ts shirt --hem 46 --neck 108 --thickness 1.6 --out accessories/out/shirt.stl
node src/cli.ts wrap --garment accessories/sweater/source.stl --hem 46 --neck 108
```

Sizes on the goose: head about 25 mm wide at the top, wings about 40 mm
long, beak about 16 mm wide, body 76 mm wide and 115 mm long between the
hem (z = 46) and the neck (z = 108). `accessories/out/` is scratch space
for generated files and is ignored by git.

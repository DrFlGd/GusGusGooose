#!/bin/sh
# Builds the goose-proportioned hoodie: shirt body from the contour pipeline, soft parts modelled in Blender
# (pip install bpy) against the body profile, fabric folds on the body, all unioned into one printable STL.
#   sh scripts/hoodie/build.sh out/hoodie.stl
set -e
out=${1:-hoodie.stl}
work=$(mktemp -d)
node scripts/hoodie/cavity.ts "$work/cavity.stl" "$work/profile.json"
node src/cli.ts shirt --hem 46 --neck 108 --neckline crew --collar-height 3 --hem-band 6 --out "$work/body.stl"
python3 scripts/hoodie/parts.py "$work/profile.json" "$work"
python3 scripts/hoodie/fabric.py "$work/profile.json" "$work/body.stl" "$work/body_fabric.stl"
BODY=body_fabric.stl node scripts/hoodie/assemble.ts "$work" "$out"
rm -rf "$work"
echo "hoodie written to $out"

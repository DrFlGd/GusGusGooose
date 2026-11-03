import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frameFromAxes, manifold, toManifold, type FitProfile } from '../src/fit.ts';
import { parseStl } from '../src/stl.ts';
import { DEFAULT_NECK, fitOnNeck, forwardOf, makeNeckBand, SLOT_SKIN } from '../src/neck.ts';
import { holdsMagnet, prepareAccessory } from '../src/prepare.ts';

const goose = await toManifold(parseStl(readFileSync('goose/goose.stl')));
const profile: FitProfile = JSON.parse(readFileSync('goose/profile.json', 'utf8'));

test('the neck band is one C round the neck, open at the back, with two tabs at the front', async () => {
  const band = await makeNeckBand(goose, profile, DEFAULT_NECK);
  const fwd = forwardOf(profile);
  assert.ok(fwd[1] < -0.7, `forward points from the head to the beak: ${fwd}`);
  assert.ok(band.neckWidth > 10 && band.neckWidth < 20, `neck ${band.neckWidth} mm across`);
  assert.ok(Math.abs(band.openingWidth - band.neckWidth * 0.85) < 0.01, `opening ${band.openingWidth}`);
  assert.equal(band.band.decompose().length, 1, 'one body');
  assert.equal(band.tabs.length, 2);
  // the band hugs the neck: it lies between the neck's loop and 3 mm out, and nothing of it is inside the goose
  assert.ok(band.band.intersect(goose).volume() < 1, 'the band does not cut into the goose');
  const bb = band.band.boundingBox();
  assert.ok(bb.max[0] - bb.min[0] < band.neckWidth + 2 * DEFAULT_NECK.thickness + 2 * DEFAULT_NECK.clearance + 2 * DEFAULT_NECK.tabLength + 2, `band width ${bb.max[0] - bb.min[0]}`);
  // the accessory's point is on the front of the band, facing forward
  const c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2];
  const d = (band.point.center[0] - c[0]) * fwd[0] + (band.point.center[1] - c[1]) * fwd[1];
  assert.ok(d > band.neckWidth / 2 - 1, `point ${d.toFixed(1)} mm forward of the centre`);
  assert.deepEqual(band.point.axis, fwd);
});

test('a bow-tie block fits on the band: carved to it and slotted for the tabs, the band untouched', async () => {
  const { Manifold } = await manifold();
  const band = await makeNeckBand(goose, profile, DEFAULT_NECK);
  const bow = Manifold.cube([24, 8, 4], false).translate(-12, -4, 0);
  const r = await fitOnNeck(goose, bow, profile, band, { sink: 0.5, spin: 0, offset: [0, 0] }, DEFAULT_NECK);
  assert.equal(r.bodies, 1, r.warnings.join('; '));
  const slot = Math.PI * ((DEFAULT_NECK.tabDiameter + DEFAULT_NECK.tabClearance) / 2) ** 2 * (DEFAULT_NECK.tabLength + DEFAULT_NECK.tabClearance);
  assert.ok(r.volumeBefore - r.volumeAfter > slot * 0.9, `removed ${(r.volumeBefore - r.volumeAfter).toFixed(0)} mm³, slots alone are ${(2 * slot).toFixed(0)}`);
  // the tabs go into the slots: the band and the fitted bow do not overlap
  assert.ok(r.solid.intersect(band.band).volume() < 0.5, 'the tabs sit in the slots with clearance');
  assert.ok(Math.abs(r.band.volume() - band.band.volume()) < 1e-3, 'the 4 mm bow takes the full tabs, so the band is as it was');
  // the bow sits in front of the neck, upright
  const bb = r.solid.boundingBox();
  assert.ok(bb.max[2] - bb.min[2] > 7.5 && bb.max[2] - bb.min[2] < 8.5, `bow height ${bb.max[2] - bb.min[2]}`);
  assert.ok(bb.min[1] < band.point.center[1] - 3, 'the bow stands forward of the band');
});

test('tab slots are blind: they stop short of the front, and tabs shorten on a thin accessory', async () => {
  const { Manifold } = await manifold();
  const band = await makeNeckBand(goose, profile, DEFAULT_NECK);
  for (const thick of [3, 6]) {
    const plate = Manifold.cube([24, 8, thick], false).translate(-12, -4, 0);
    const r = await fitOnNeck(goose, plate, profile, band, { sink: 0, spin: 0, offset: [0, 0] }, DEFAULT_NECK);
    // a line straight through each tab's centre meets material in front of the slot: nothing is open at the front
    for (const t of band.tabs) {
      const ray = Manifold.cylinder(40, 0.3, 0.3, 12, false).transform(frameFromAxes(t, [0, 0, 1], band.forward) as any);
      const before = plate.volume();
      void before;
      const inFront = r.solid.intersect(ray).volume();
      assert.ok(inFront > Math.PI * 0.09 * (SLOT_SKIN - 0.1), `${thick} mm: material in front of the slot ${inFront.toFixed(3)} mm³`);
    }
    assert.equal(r.solid.genus(), 0, `${thick} mm: the slots do not open through (genus ${r.solid.genus()})`);
    if (thick === 3) assert.ok(r.tabLength >= 1 && r.tabLength < DEFAULT_NECK.tabLength + 0.01, `3 mm: tabs ${r.tabLength}`);
    if (thick === 6) assert.equal(r.tabLength, DEFAULT_NECK.tabLength);
    assert.ok(r.solid.intersect(r.band).volume() < 0.5, `${thick} mm: the tabs sit in their slots`);
  }
});

test('a thin sword gets a puck under its widest part and can then hold a magnet', async () => {
  const { Manifold } = await manifold();
  // a blade 40 long and 2 thick with a wider guard a third of the way along
  const sword = Manifold.cube([40, 5, 2], false).add(Manifold.cube([4, 14, 2], false).translate(10, -4.5, 0));
  const plain = await prepareAccessory(sword, { down: '-z', scale: 1, centre: 'bbox' });
  assert.equal(await holdsMagnet(plain.solid, 6, 3), false, 'a 2 mm blade cannot hold a 6 x 3 magnet');
  const r = await prepareAccessory(sword, { down: '-z', scale: 1, centre: 'bbox', puck: { diameter: 12, height: 5 } });
  assert.ok(r.puck, 'a puck was added');
  assert.ok(Math.abs(r.size[2] - 7) < 0.01, `height ${r.size[2]}`);
  assert.ok(Math.abs(r.puck!.at[0] - (12 - 20)) < 2.5 && Math.abs(r.puck!.at[1]) < 2, `the puck is under the guard: ${r.puck!.at}`);
  assert.equal(await holdsMagnet(r.solid, 6, 3), true, 'with the puck the magnet fits');
  assert.equal(r.solid.decompose().length, 1);
  const bb = r.solid.boundingBox();
  assert.ok(Math.abs(bb.min[2]) < 1e-6, 'the puck is the base');
  // behind: the puck stands beside the sword's back (+y), both on the base, the sword not lifted
  const behind = await prepareAccessory(sword, { down: '-z', scale: 1, centre: 'bbox', puck: { diameter: 12, height: 6, attach: 'behind' } });
  const bbb = behind.solid.boundingBox();
  assert.ok(Math.abs(bbb.min[2]) < 1e-6 && Math.abs(bbb.max[2] - 6) < 0.01, `behind: z ${bbb.min[2]}..${bbb.max[2]}`);
  assert.ok(bbb.min[1] < -6 - 1 && bbb.max[1] < 6.01, `behind: the sword is in front of the puck, y ${bbb.min[1].toFixed(1)}..${bbb.max[1].toFixed(1)}`);
  assert.equal(await holdsMagnet(behind.solid, 6, 3), true);
  assert.equal(behind.solid.decompose().length, 1);
  // a chosen spot wins over the pole
  const chosen = await prepareAccessory(sword, { down: '-z', scale: 1, centre: 'bbox', puck: { diameter: 10, height: 5, at: [15, 0] } });
  assert.deepEqual(chosen.puck!.at, [15, 0]);
  assert.equal(await holdsMagnet(chosen.solid, 6, 3), true);
});

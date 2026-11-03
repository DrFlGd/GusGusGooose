// Browser UI around the fitting pipeline: the goose with its magnet points,
// an accessory placed at one of them, Fit, export. Plus the magnet-hole tool.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { parseStl, serializeStl, type IndexedMesh } from '../stl.ts';
import { DEFAULT_PROFILE, fitAccessory, frameAt, fromManifold, fromManifoldTagged, manifold, spinToward, toManifold, toManifoldTagged, type FitProfile, type FitResult, type Placement } from '../fit.ts';
import { loadModel } from '../load-model.ts';
import { DEFAULT_PREPARE, holdsMagnet, prepareAccessory, type PrepareOptions, type Side } from '../prepare.ts';
import { buildFlat, cssColor, DEFAULT_FLAT, svgDesign, type FlatDesign, type FlatOptions } from '../flat.ts';
import { bounds, type Contour, type RGB } from '../vendor/contour.ts';
import { decodeImage, type Raster } from '../vendor/trace.ts';
import { parseSvg } from '../vendor/svg.ts';
import { hex, prepareImage, tracedPreview, type ImageSettings } from './prepare-image.ts';
import { DEFAULT_NECK, fitOnNeck, makeNeckBand, SLOT_SKIN, type NeckBand, type NeckOptions } from '../neck.ts';
import { contourGarment, wrapGarment, cavityProfile, wrapFrame, trimGarment, type Cavity, type GarmentOptions, type WrapOptions } from '../clothing.ts';
import { expandRuns, type GooseColors } from '../goose-colors.ts';
import { addMagnetHole } from '../hole.ts';
import type { MagnetVoid } from '../voids.ts';
import { write3mf, write3mfParts, type Material } from '../threemf-write.ts';
import { splitByMaterial } from '../split-colours.ts';
import { PaintState } from './paint.ts';
import { faceIdMap } from './pick.ts';
import { insidePolygon } from '../paint-fill.ts';
import type { StampView } from '../paint-model.ts';

type V3 = [number, number, number];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- number boxes: the arrows nudge by 0.1, typing takes down to 0.01 ----------
// (the step in the markup is overridden here; counts such as ribs or buttons stay whole numbers)
const NUDGE = 0.1, FINE = 0.01;
const COUNTS = new Set(['cloth-buttons', 'cloth-fabric-pitch', 'cloth-smooth', 'cloth-smooth-model', 'cloth-split-magnets', 'pocket-rib-count']);
/** A value to two places, without float dust (2.1300000001 → "2.13"). */
const fine = (v: number) => String(Number((Math.round(v / FINE) * FINE).toFixed(2)));
function setupNumberBoxes() {
  for (const box of document.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
    if (COUNTS.has(box.id)) continue;
    box.step = String(NUDGE);
    // first in line, so every other handler reads the rounded value
    box.addEventListener('change', () => { if (box.value !== '' && Number.isFinite(Number(box.value))) box.value = fine(Number(box.value)); });
  }
}
setupNumberBoxes();

// ---------- sliders with a number box ----------
/**
 * Every range input with an `<id>-num` number box: the two follow each other, and a typed value fires the range's
 * input handlers. The range holds the typed value to 0.01; dragging it or its arrow keys move in its own step.
 */
function pairSliders() {
  for (const range of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const snap = Number(range.step) || 1;
    range.step = String(FINE);
    range.addEventListener('input', (e) => {
      // a drag lands on the slider's own steps; values set from code or the number box stay as given
      if (e.isTrusted) range.value = fine(Math.round(Number(range.value) / snap) * snap);
    });
    range.addEventListener('keydown', (e) => {
      const dir = { ArrowUp: 1, ArrowRight: 1, PageUp: 10, ArrowDown: -1, ArrowLeft: -1, PageDown: -10 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const v = Math.max(Number(range.min), Math.min(Number(range.max), Number(range.value) + dir * snap));
      range.value = fine(v);
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    });
    fillRange(range);
    range.addEventListener('input', () => fillRange(range));
    const num = document.getElementById(`${range.id}-num`) as HTMLInputElement | null;
    if (!num) continue;
    num.value = range.value;
    range.addEventListener('input', () => { num.value = range.value; });
    num.addEventListener('change', () => {
      const v = Math.max(Number(range.min), Math.min(Number(range.max), Number(num.value) || 0));
      range.value = String(v);
      num.value = String(v);
      fillRange(range);
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}
/** The coloured part of a range's track, up to its value. */
function fillRange(r: HTMLInputElement) {
  const min = Number(r.min) || 0, max = Number(r.max) || 100;
  r.style.setProperty('--fill', `${((Number(r.value) - min) / (max - min || 1)) * 100}%`);
}
/** Copies a range's value into its number box (and its track) after the range was set from code. */
function syncSlider(id: string) {
  const range = $<HTMLInputElement>(id);
  fillRange(range);
  const num = document.getElementById(`${id}-num`) as HTMLInputElement | null;
  if (num) num.value = range.value;
}
pairSliders();

// ---------- scene ----------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 2000);
camera.up.set(0, 0, 1);
camera.position.set(-180, -260, 220);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(115, 140, 90);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(-1, -2, 3);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(2, 1, -1);
scene.add(fill);
let grid = new THREE.GridHelper(300, 30);

// ---------- theme: light or dark, as the system says until chosen, and remembered ----------
const THEME_KEY = 'gusgus.theme';
function storedTheme(): string | null { try { return localStorage.getItem(THEME_KEY); } catch { return null; } }
function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  scene.background = new THREE.Color(token('--bg', theme === 'dark' ? '#0f1114' : '#f6f7f9'));
  const visible = grid.visible;
  scene.remove(grid);
  grid.geometry.dispose();
  grid = new THREE.GridHelper(300, 30, new THREE.Color(token('--line-strong', '#cdd2d9')), new THREE.Color(token('--line', '#e2e5ea')));
  grid.rotation.x = Math.PI / 2;
  grid.position.set(115, 128, 0);
  grid.visible = visible;
  scene.add(grid);
  $('theme').title = theme === 'dark' ? 'Dark; click for light' : 'Light; click for dark';
}
applyTheme((storedTheme() as 'light' | 'dark' | null) ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* the choice lasts this visit only */ }
  applyTheme(next);
};

// the canvas fills the view (CSS sizes it); the drawing buffer follows the view's size, so nothing overflows or scrolls
function resize() {
  const w = Math.max(1, view.clientWidth), h = Math.max(1, view.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(() => { resize(); idMap = null; drawOverlay(); }).observe(view);
resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

function toGeometry(mesh: IndexedMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
  g.computeVertexNormals();
  return g;
}

const gooseMaterial = new THREE.MeshStandardMaterial({ color: 0xe9dcc3, roughness: 0.85, flatShading: false });
const accessoryMaterial = new THREE.MeshStandardMaterial({ color: 0x6fb1ff, roughness: 0.6, transparent: true, opacity: 0.75 });
const fittedMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
/** for the faces painted in part, whole, just behind their leaves (see PaintState.backing) */
const backingMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
const accessoryColouredMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, transparent: true, opacity: 0.85 });

// ---------- state ----------
let gooseMesh: IndexedMesh;
let gooseManifold: ManifoldT;
let gooseObject: THREE.Mesh;
let profile: FitProfile;
let accessoryMesh: IndexedMesh | null = null;
let accessoryManifold: ManifoldT | null = null;
let accessoryObject: THREE.Mesh | null = null;
// the accessory hangs in a pivot at the magnet point: the pivot carries the frame and the tilt/spin, the mesh only the slide
const accessoryPivot = new THREE.Group();
let fittedObject: THREE.Mesh | null = null;
let fitted: FitResult | null = null;
let activePoint = '';
// the goose's colours: one material per filament, tracked through booleans as Manifold runs
let gooseMaterials: Material[] = [{ name: 'Goose', color: '#e9dcc3' }];
let gooseFaceMaterial: Uint8Array | null = null;
let gooseFirstID = 0;
let gooseFallback = 0;
// the loaded model before preparation, and how it is prepared
let rawModel: ManifoldT | null = null;
let rawName = '';
// the loaded model's own colours (a 3MF's filament slots and paint), tracked through booleans as Manifold runs
let modelTags: { firstID: number; count: number; fallback: number } | null = null;
const prep: PrepareOptions = { ...DEFAULT_PREPARE };
/** where the prepare puck goes once it has been moved by hand, in the model's frame */
let puckAt: [number, number] | undefined;
/** where the last prepare put the puck, in the model's frame */
let preparedPuckAt: [number, number] | null = null;
// a flat accessory made from a picture: the traced design, and where its mount was moved to
let flatDesign: FlatDesign | null = null;
let flatName = '';
let flatMountAt: [number, number] | undefined;
let flatResult: Awaited<ReturnType<typeof buildFlat>> | null = null;
// the neck band, when the neck is the chosen position
let neckBand: NeckBand | null = null;
let neckKey = '';
let bandObject: THREE.Mesh | null = null;
const bandMaterial = new THREE.MeshStandardMaterial({ color: 0xf2b84b, roughness: 0.6, transparent: true, opacity: 0.9 });
/** the band the fitted accessory was fitted to, exported with it as its own part */
let fittedBand: ManifoldT | null = null;
let moveMode = false;
const markers = new THREE.Group();
scene.add(markers);
let pick: { point: V3; normal: V3 } | null = null;
let pickMarker: THREE.Object3D | null = null;

const status = (s: string) => { $('status').textContent = s; };

async function init() {
  const [stl, prof, colors] = await Promise.all([
    fetch(import.meta.env.BASE_URL + 'goose.stl').then((r) => r.arrayBuffer()),
    fetch(import.meta.env.BASE_URL + 'profile.json').then((r) => (r.ok ? r.json() : { ...DEFAULT_PROFILE, points: {} })),
    fetch(import.meta.env.BASE_URL + 'goose-colors.json').then((r) => (r.ok ? (r.json() as Promise<GooseColors>) : null)).catch(() => null),
  ]);
  gooseMesh = parseStl(stl);
  profile = prof;
  if (colors && colors.materials.length) {
    gooseMaterials = colors.materials;
    gooseFaceMaterial = expandRuns(colors, gooseMesh.triangles.length / 3);
    // the fallback for faces a cut creates: the material with the most faces
    const counts = new Array<number>(gooseMaterials.length).fill(0);
    for (const m of gooseFaceMaterial) counts[m]++;
    gooseFallback = counts.indexOf(Math.max(...counts));
  }
  setGoose(gooseMesh, gooseFaceMaterial);
  renderGooseColours();
  status('Starting geometry engine…');
  const { Manifold } = await manifold();
  if (gooseFaceMaterial) {
    gooseFirstID = Manifold.reserveIDs(gooseMaterials.length);
    gooseManifold = await toManifoldTagged(gooseMesh, gooseFaceMaterial, gooseFirstID);
  } else {
    gooseManifold = await toManifold(gooseMesh);
  }
  status(`Goose loaded: ${(gooseMesh.triangles.length / 3).toLocaleString()} triangles, ${Object.keys(profile.points).length} magnet points.`);
  renderPoints();
}

function setGoose(mesh: IndexedMesh, faceMaterial: Uint8Array | null = null) {
  gooseMesh = mesh;
  gooseFaceMaterial = faceMaterial;
  if (gooseObject) { scene.remove(gooseObject); gooseObject.geometry.dispose(); }
  gooseObject = faceMaterial
    ? new THREE.Mesh(colouredGeometry(mesh, faceMaterial, gooseMaterials), gooseColouredMaterial)
    : new THREE.Mesh(toGeometry(mesh), gooseMaterial);
  scene.add(gooseObject);
}

const gooseColouredMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });

/** Non-indexed geometry with smooth normals and one colour per face. */
function colouredGeometry(mesh: IndexedMesh, faceMaterial: Uint8Array, materials: Material[]): THREE.BufferGeometry {
  const indexed = toGeometry(mesh); // smooth vertex normals
  const normals = indexed.getAttribute('normal') as THREE.BufferAttribute;
  const n = mesh.triangles.length / 3;
  const pos = new Float32Array(n * 9), nor = new Float32Array(n * 9), col = new Float32Array(n * 9);
  const rgb = materials.map((m) => new THREE.Color(m.color));
  for (let i = 0; i < mesh.triangles.length; i++) {
    const v = mesh.triangles[i] * 3;
    pos[i * 3] = mesh.positions[v]; pos[i * 3 + 1] = mesh.positions[v + 1]; pos[i * 3 + 2] = mesh.positions[v + 2];
    nor[i * 3] = normals.getX(mesh.triangles[i]); nor[i * 3 + 1] = normals.getY(mesh.triangles[i]); nor[i * 3 + 2] = normals.getZ(mesh.triangles[i]);
    const c = rgb[faceMaterial[(i / 3) | 0]] ?? rgb[0];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  indexed.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Colour pickers for the goose's filaments; purely for the view. */
function renderGooseColours() {
  const el = $('goose-colours');
  el.innerHTML = '';
  if (!gooseFaceMaterial) return;
  $('goose-colours-section').classList.remove('hidden');
  gooseMaterials.forEach((m) => {
    const sw = document.createElement('label');
    sw.className = 'swatch';
    const color = document.createElement('input');
    color.type = 'color'; color.value = m.color;
    color.oninput = () => { m.color = color.value; if (gooseFaceMaterial) setGoose(gooseMesh, gooseFaceMaterial); };
    sw.append(color, document.createTextNode(m.name));
    el.appendChild(sw);
  });
}

// ---------- magnet points ----------
/** The point the accessory is placed on: a magnet void, or the front of the neck band. */
const currentPoint = (): MagnetVoid | undefined => (activePoint === 'neck' ? neckBand?.point : profile.points[activePoint]);
function renderPoints() {
  markers.clear();
  const list = $('points');
  list.innerHTML = '';
  const select = $<HTMLSelectElement>('point');
  select.innerHTML = '';
  const neckLi = document.createElement('li');
  neckLi.innerHTML = '<b>neck</b>a press-fit band round the neck, no magnet';
  neckLi.classList.toggle('active', activePoint === 'neck');
  neckLi.onclick = () => choosePoint('neck');
  const neckOpt = document.createElement('option');
  neckOpt.value = 'neck'; neckOpt.textContent = 'neck (band)';
  for (const [name, p] of Object.entries(profile.points)) {
    const li = document.createElement('li');
    const shape = p.shape === 'box' && p.size ? `${p.size[0].toFixed(1)} × ${p.size[1].toFixed(1)} block` : `${p.diameter.toFixed(1)} dia`;
    li.innerHTML = `<b>${name}</b>${shape} × ${p.depth.toFixed(1)} mm, ${p.mode ?? 'open'}${p.skin ? ` under ${p.skin.toFixed(1)} mm` : ''}`;
    li.classList.toggle('active', name === activePoint);
    li.onclick = () => choosePoint(name);
    list.appendChild(li);
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    select.appendChild(opt);
    markers.add(marker(p, name === activePoint));
  }
  list.appendChild(neckLi);
  select.appendChild(neckOpt);
  if (!activePoint && Object.keys(profile.points).length) { activePoint = Object.keys(profile.points)[0]; restorePosition(); renderPoints(); return; }
  select.value = activePoint;
  $('neck-panel').classList.toggle('hidden', activePoint !== 'neck');
  $('pocket-details').classList.toggle('hidden', activePoint === 'neck');
  pointHint();
  ensureBand();
}
/** After the point changes: the fit is stale, the model is rebuilt with the new place's mount, the preview moves. */
function onPointChange() {
  clearFitted();
  renderPoints();
  if (flatDesign) buildFlatNow();
  else if (rawModel) applyPrepare();
  else updatePreview();
}

function marker(p: MagnetVoid, active: boolean): THREE.Object3D {
  const g = new THREE.Group();
  const r = p.diameter / 2;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.4, 8, 48), new THREE.MeshBasicMaterial({ color: active ? 0xf2b84b : 0x6fb1ff }));
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 8, active ? 0xf2b84b : 0x6fb1ff, 3, 2);
  g.add(ring, arrow);
  g.applyMatrix4(new THREE.Matrix4().fromArray(frameAt(p.center, p.axis)));
  return g;
}

// ---------- accessory ----------
// sensible widths for a model at each point, mm, shown as the placeholder
const POINT_WIDTH: Record<string, number> = { head: 25, left_wing: 40, right_wing: 40, beak: 16, neck: 24 };
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

let loadSerial = 0;
/** Loads a model as the accessory; from the Clothing tab (`stay`) it is shown there as the wrap ghost instead of switching tabs. */
async function loadFile(file: File, stay = false) {
  if (IMAGE_FILE.test(file.name)) return loadFlat(file);
  status(`Reading ${file.name}…`);
  let loaded: Awaited<ReturnType<typeof loadModel>>;
  try {
    const voxel = $<HTMLInputElement>('repair-voxel').value;
    loaded = await loadModel(file.name, await file.arrayBuffer(), { repair: $<HTMLInputElement>('repair-import').checked, voxel: voxel === '' ? undefined : Number(voxel) });
    rawModel = loaded.solid;
    rawName = file.name;
    preparedKey = '';
    resetFlatPanel();
    // a 3MF's colours become the palette, so they come through to the paint tab and the export
    if (loaded.materials && loaded.firstID !== undefined) {
      modelTags = { firstID: loaded.firstID, count: loaded.materials.length, fallback: loaded.fallback ?? 0 };
      // the model's colours first (the tagged ones), then the usual extras so there is something to paint with
      setPalette([...loaded.materials, ...DEFAULT_PALETTE.slice(1).filter((d) => !loaded.materials!.some((m) => m.color === d.color))]);
    } else if (modelTags) {
      modelTags = null;
      setPalette(DEFAULT_PALETTE);
    }
    const bb = rawModel.boundingBox();
    const size = bb.max.map((v, i) => (v - bb.min[i]).toFixed(1)).join(' × ');
    const repaired = loaded.repaired ? ` ${loaded.repaired.parts} part(s) were not valid solids and were rebuilt on a ${loaded.repaired.voxel.toFixed(2)} mm voxel grid.` : '';
    const colours = loaded.materials ? ` ${loaded.materials.length} colour${loaded.materials.length > 1 ? 's' : ''} kept for the Paint tab.` : '';
    $('model-info').textContent = `${file.name}: ${loaded.triangles.toLocaleString()} triangles${loaded.parts > 1 ? `, ${loaded.parts} parts joined` : ''}, ${size} mm as downloaded.${repaired}${colours}`;
  } catch (err) {
    status(`${file.name}: ${(err as Error).message}`);
    return;
  }
  baseManifold = null;
  loadSerial++;
  $('prepare-controls').classList.remove('hidden');
  $<HTMLButtonElement>('wrap-garment').disabled = false;
  if (!(stay && tab === 'clothing')) setTab('accessory');
  resetPositions(); // a new model starts every position afresh
  await applyPrepare();
  $('cloth-model').textContent = `${file.name} is loaded and ready to wrap.${loaded.repaired ? ' It was rebuilt on a voxel grid on import.' : ''}`;
  updateClearButtons();
  if (tab === 'clothing') wrapPreview();
}
$<HTMLInputElement>('cloth-file').onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadFile(f, true);
};

/** Forgets the loaded model and any fitted part or garment, back to the bare goose, so another model can be started from scratch. */
function clearModel() {
  clearFitted();
  rawModel = null;
  rawName = '';
  preparedKey = '';
  resetFlatPanel();
  puckAt = undefined; preparedPuckAt = null;
  $('puck-info').textContent = '';
  if (modelTags) { modelTags = null; setPalette(DEFAULT_PALETTE); }
  baseManifold = null;
  accessoryManifold = null;
  accessoryMesh = null;
  garmentParts = null;
  loadSerial++;
  if (accessoryObject) { accessoryPivot.remove(accessoryObject); accessoryObject.geometry.dispose(); accessoryObject = null; gizmo.detach(); }
  if (ghost) { scene.remove(ghost); ghost.geometry.dispose(); ghost = null; cropKey = ''; }
  for (const id of ['accessory-file', 'cloth-file', 'flat-file']) $<HTMLInputElement>(id).value = ''; // so the same file can be loaded again
  $('prepare-controls').classList.add('hidden');
  $('accessory-controls').classList.add('hidden');
  $('model-info').textContent = '';
  $('cloth-model').textContent = 'No model loaded; Make shirt needs none.';
  $('cloth-result').textContent = '';
  $<HTMLButtonElement>('wrap-garment').disabled = true;
  resetPositions();
  updateClearButtons();
  updatePreview();
  status('Cleared. Load another model or a picture, or make a shirt.');
}
/** The Clear buttons are live when there is something to clear: a loaded model or a fitted part. */
function updateClearButtons() {
  const something = !!rawModel || !!flatDesign || !!fittedObject;
  for (const id of ['clear-model', 'clear-cloth']) {
    const b = $<HTMLButtonElement>(id);
    b.disabled = !something;
    b.title = something ? '' : 'Nothing to clear';
  }
}
$('clear-model').onclick = clearModel;
$('clear-cloth').onclick = clearModel;

/** Re-runs the prepare step on the loaded model and shows it as the accessory. */
async function applyPrepare() {
  if (!rawModel) return;
  prep.down = $<HTMLSelectElement>('prep-down').value as Side;
  prep.scale = Number($<HTMLInputElement>('prep-scale').value) || 1;
  const w = $<HTMLInputElement>('prep-width').value;
  prep.width = w === '' ? undefined : Number(w);
  prep.centre = $<HTMLSelectElement>('prep-centre').value as PrepareOptions['centre'];
  const pd = Number($<HTMLInputElement>('prep-plug-d').value), ph = Number($<HTMLInputElement>('prep-plug-h').value);
  prep.plug = pd > 0 && ph > 0 ? { diameter: pd, height: ph } : undefined;
  const fillDepth = Number($<HTMLInputElement>('prep-fill').value);
  prep.fill = fillDepth > 0 ? fillDepth : undefined;
  // the puck: always, never, or when the model on its own has no room for the pocket at the magnet; under the model or behind it
  const puckMode = activePoint === 'neck' ? 'never' : $<HTMLSelectElement>('prep-puck').value;
  const magnet = magnetSize();
  const attach = $<HTMLSelectElement>('prep-puck-attach').value as 'under' | 'behind';
  const puck = { diameter: Number($<HTMLInputElement>('prep-puck-d').value) || magnet.diameter + 4, height: Number($<HTMLInputElement>('prep-puck-h').value) || magnet.puckHeight, at: puckAt, attach };
  // the same model prepared the same way (another position with the same mount) needs no second pass
  const key = JSON.stringify([loadSerial, prep.down, prep.scale, prep.width, prep.centre, prep.plug, prep.fill, puckMode, puck]);
  if (key === preparedKey && accessoryObject) { updatePreview(); return; }
  if (prep.fill) { status('Filling the hollow underside…'); await new Promise((r) => setTimeout(r, 20)); }
  try {
    prep.puck = puckMode === 'always' ? puck : undefined;
    let prepared = await prepareAccessory(rawModel, prep);
    let puckNote = '';
    if (puckMode === 'auto') {
      if (await holdsMagnet(prepared.solid, magnet.diameter, magnet.thickness)) puckNote = 'The model has room for the magnet; no puck added.';
      else { prep.puck = puck; prepared = await prepareAccessory(rawModel, prep); }
    }
    preparedPuckAt = prepared.puck?.at ?? null;
    if (prepared.puck) puckNote = attach === 'behind'
      ? `Puck ${prep.puck!.diameter.toFixed(1)} × ${prep.puck!.height.toFixed(1)} mm behind the model at x ${prepared.puck.at[0].toFixed(1)}: it rests on the goose and the model stands just in front of it.`
      : `Puck ${prep.puck!.diameter.toFixed(1)} × ${prep.puck!.height.toFixed(1)} mm under (${prepared.puck.at.map((v) => v.toFixed(1)).join(', ')}) of the model; it is the base now.`;
    else if (puckMode === 'never') puckNote = '';
    $('puck-info').textContent = puckNote;
    accessoryManifold = prepared.solid;
    accessoryMesh = fromManifold(prepared.solid);
    const size = prepared.size.map((v) => v.toFixed(1)).join(' × ');
    const fill = prepared.fill ? ` Filled ${prepared.fill.volume.toFixed(0)} mm³, ${prepared.fill.depth.toFixed(1)} mm deep from a floor ${prepared.fill.floor.toFixed(1)} mm above the lowest point.` : '';
    status(`${rawName}: ${size} mm after preparing${prep.width ? ` (scaled ×${prepared.scale.toFixed(3)})` : ''}.${fill}${prepared.puck ? ` Puck added ${attach === 'behind' ? 'behind' : 'underneath'}.` : ''}${prepared.warnings.length ? ` ${prepared.warnings.join('; ')}.` : ''} Place it, then Fit.`);
  } catch (err) {
    status(`Prepare failed: ${(err as Error).message}`);
    return;
  }
  preparedKey = key;
  showAccessory();
}
/** What the last prepare was made from, so a position change with the same mount skips it. */
let preparedKey = '';

function showAccessory() {
  if (!accessoryMesh) return;
  clearFitted();
  if (accessoryObject) { accessoryPivot.remove(accessoryObject); accessoryObject.geometry.dispose(); }
  // a model with its own colours is previewed in them
  const tagged = modelTags && accessoryManifold ? fromManifoldTagged(accessoryManifold, modelTags.firstID, modelTags.count, modelTags.fallback) : null;
  accessoryObject = tagged
    ? new THREE.Mesh(colouredGeometry(tagged.mesh, tagged.faceMaterial, palette), accessoryColouredMaterial)
    : new THREE.Mesh(toGeometry(accessoryMesh), accessoryMaterial);
  accessoryPivot.add(accessoryObject);
  if (!accessoryPivot.parent) scene.add(accessoryPivot);
  $('accessory-controls').classList.remove('hidden');
  updateMountControls();
  updatePreview();
}

$<HTMLInputElement>('accessory-file').onchange = (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) loadFile(file);
};
for (const id of ['prep-down', 'prep-width', 'prep-scale', 'prep-centre']) {
  $<HTMLInputElement>(id).onchange = () => { puckAt = undefined; applyPrepare(); }; // the model's frame changes, so a moved puck starts over
}
for (const id of ['prep-plug-d', 'prep-plug-h', 'prep-fill', 'prep-puck', 'prep-puck-d', 'prep-puck-h']) {
  $<HTMLInputElement>(id).onchange = () => { updateMountControls(); applyPrepare(); };
}
// a puck behind starts over where it joins, and turns a model on the head to face the beak
$<HTMLSelectElement>('prep-puck-attach').onchange = () => {
  puckAt = undefined;
  $<HTMLInputElement>('spin').value = String(defaultSpin());
  applyPrepare();
};
/**
 * The magnet the pocket is cut for: the pocket boxes when typed, else the point's own void (a box by its diagonal);
 * and the puck height that leaves a floor under its pocket, which starts a sink above the base.
 */
function magnetSize(): { diameter: number; thickness: number; puckHeight: number } {
  const pt = currentPoint();
  const d = Number($<HTMLInputElement>('pocket-dia').value), t = Number($<HTMLInputElement>('pocket-thick').value);
  const voidD = pt ? (pt.shape === 'box' && pt.size ? Math.hypot(...pt.size) : pt.diameter) : 10;
  const thickness = t || profile.magnetThickness || pt?.depth || 3;
  const sink = Number($<HTMLInputElement>('sink').value) || 0;
  return { diameter: d || voidD, thickness, puckHeight: Math.round((thickness + sink + 1.5) * 2) / 2 };
}

// ---------- flat accessories from a picture ----------
// a picture goes through the Prepare image dialog (background, colours, cleanup, exposure) and is traced with what it
// shows; the decoded picture is kept so Adjust can open the dialog again. An SVG keeps its own fills and needs none.
let flatRaster: Raster | null = null;
let flatImageSettings: Partial<ImageSettings> = {};
const flatEmpty = $('flat-preview').innerHTML;
const flatInfoDefault = $('flat-info').textContent ?? '';

/** The traced picture as a design for the plate. */
const designOf = (p: { width: number; height: number; silhouette: FlatDesign['silhouette']; regions: FlatDesign['regions'] }): FlatDesign => ({ width: p.width, height: p.height, silhouette: p.silhouette, regions: p.regions.map((r) => ({ color: r.color, contours: r.contours })) });

/** Reads a picture or SVG as a design and builds it. Cancelling the dialog keeps whatever was there before. */
async function loadFlat(file: File) {
  try {
    let design: FlatDesign, info: string;
    let raster: Raster | null = null;
    let settings: Partial<ImageSettings> = {};
    if (/\.svg$/i.test(file.name)) {
      status(`Reading ${file.name}…`);
      const doc = parseSvg(await file.text());
      const shapes = doc.shapes.filter((sh) => sh.fill !== 'none');
      if (!shapes.length) throw new Error('no filled shapes in the SVG');
      design = svgDesign(shapes); // parseSvg has already turned the page's y-down into y up
      info = `${file.name}: a vector file, ${shapes.length} shape${shapes.length === 1 ? '' : 's'}, ${design.regions.length} colour${design.regions.length === 1 ? '' : 's'} from its fills.`;
    } else {
      status(`Opening ${file.name}…`);
      raster = await decodeImage(file);
      status(`Prepare ${file.name}: drop the background and pick the colours to keep.`);
      const prepared = await prepareImage(raster, file.name, {});
      if (!prepared) { status(`${file.name} was not used.`); $<HTMLInputElement>('flat-file').value = ''; return; }
      design = designOf(prepared);
      settings = prepared.settings;
      info = `${file.name}: ${raster.width} × ${raster.height} px, ${design.regions.length} colour${design.regions.length === 1 ? '' : 's'} kept.`;
    }
    flatRaster = raster;
    flatImageSettings = settings;
    flatDesign = design;
    flatName = file.name;
    rawModel = null; rawName = ''; preparedKey = '';
    $('prepare-controls').classList.add('hidden');
    $('model-info').textContent = '';
    $('flat-info').textContent = info;
    showFlatPreview();
    $<HTMLButtonElement>('wrap-garment').disabled = true;
    setTab('accessory');
    resetPositions(); // a new model starts every position afresh
    await buildFlatNow();
  } catch (err) {
    status(`${file.name}: ${(err as Error).message}`);
  }
}
/** The traced picture in the panel, and the Adjust and Remove buttons. */
function showFlatPreview() {
  const el = $('flat-preview');
  if (flatDesign) el.replaceChildren(tracedPreview(flatDesign));
  else el.innerHTML = flatEmpty;
  const adjust = $<HTMLButtonElement>('flat-adjust');
  adjust.disabled = !flatRaster;
  adjust.title = flatRaster ? 'Background, colours, cleanup and exposure' : flatDesign ? 'A vector file keeps its own colours' : 'Choose a picture first';
  $<HTMLButtonElement>('flat-remove').disabled = !flatDesign;
}
/** Forgets the picture: the panel goes back to empty. */
function resetFlatPanel() {
  flatDesign = null; flatResult = null; flatMountAt = undefined; flatRaster = null; flatImageSettings = {};
  $('flat-info').textContent = flatInfoDefault;
  $<HTMLInputElement>('flat-file').value = '';
  showFlatPreview();
}
$('flat-adjust').onclick = async () => {
  if (!flatRaster || !flatDesign) return;
  const prepared = await prepareImage(flatRaster, flatName, flatImageSettings);
  if (!prepared) return;
  flatImageSettings = prepared.settings;
  flatDesign = designOf(prepared);
  flatMountAt = undefined; // the outline may have changed under it
  $('flat-info').textContent = `${flatName}: ${flatRaster.width} × ${flatRaster.height} px, ${flatDesign.regions.length} colour${flatDesign.regions.length === 1 ? '' : 's'} kept.`;
  showFlatPreview();
  await buildFlatNow();
};
$('flat-remove').onclick = () => clearModel();
/** Options from the picture panel and the position's mount. */
function flatOptions(): FlatOptions {
  const num = (id: string, d: number) => { const v = Number($<HTMLInputElement>(id).value); return v > 0 ? v : d; };
  const orientation = $<HTMLSelectElement>('flat-orientation').value as FlatOptions['mount']['orientation'];
  let kind = $<HTMLSelectElement>('flat-mount').value as FlatOptions['mount']['kind'];
  if (activePoint === 'neck') kind = 'none'; // the band holds it
  const attach = orientation === 'flat' ? 'back' : ($<HTMLSelectElement>('flat-attach').value as 'back' | 'bottom');
  const magnet = magnetSize();
  return {
    width: num('flat-width', DEFAULT_FLAT.width),
    depth: num('flat-depth', DEFAULT_FLAT.depth),
    inlayDepth: Math.max(0, Number($<HTMLInputElement>('flat-inlay').value) || 0),
    sides: $<HTMLSelectElement>('flat-sides').value as FlatOptions['sides'],
    margin: Math.max(0, Number($<HTMLInputElement>('flat-margin').value) || 0),
    fillHoles: $<HTMLInputElement>('flat-fill-holes').checked,
    mount: { kind, orientation, attach, at: flatMountAt, diameter: num('flat-puck-d', magnet.diameter + 4), height: num('flat-puck-h', magnet.puckHeight) },
  };
}
/** Where the puck goes on the picture, in words. */
function mountWords(m: FlatOptions['mount']): string {
  if (m.kind === 'none') return 'no magnet mount';
  if (m.kind === 'plate') return 'magnet in the plate';
  const where = m.orientation === 'flat' ? 'under its back' : m.attach === 'bottom' ? 'under its bottom edge' : 'behind it, standing on the goose';
  return `${m.diameter.toFixed(1)} × ${m.height.toFixed(1)} mm puck ${where}`;
}
let flatSerial = 0;
/** Builds the picture into the accessory with the current options and shows it. */
async function buildFlatNow() {
  if (!flatDesign) return;
  const serial = ++flatSerial;
  const opts = flatOptions();
  status('Building the picture…');
  await new Promise((r) => setTimeout(r, 20));
  try {
    const r = await buildFlat(flatDesign, opts);
    if (serial !== flatSerial) return;
    flatResult = r;
    accessoryManifold = r.solid;
    accessoryMesh = fromManifold(r.solid);
    modelTags = { firstID: r.firstID, count: r.materials.length, fallback: 0 };
    setPalette([...r.materials, ...DEFAULT_PALETTE.slice(1).filter((d) => !r.materials.some((m) => m.color === d.color))]);
    baseManifold = null;
    loadSerial++;
    const size = `${r.size[0].toFixed(1)} × ${r.size[1].toFixed(1)} × ${opts.depth} mm`;
    const facing = opts.mount.orientation === 'standing' ? 'standing up' : 'lying flat';
    $('model-info').textContent = `${flatName}: ${size}, ${r.materials.length} colour${r.materials.length === 1 ? '' : 's'}, ${facing}, ${mountWords(opts.mount)}.`;
    status(`Picture built: ${size}, ${facing}.${r.warnings.length ? ` ${r.warnings.join('; ')}.` : ''} Place it, then Fit.`);
    showAccessory();
  } catch (err) {
    status(`Picture failed: ${(err as Error).message}`);
  }
}
/** The goose's forward direction in the plane: from the head point to the beak point. */
function forwardOnGoose(): V3 {
  const h = profile.points.head, b = profile.points.beak;
  if (!h || !b) return [0, -1, 0];
  const dx = b.center[0] - h.center[0], dy = b.center[1] - h.center[1], l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l, 0];
}
$<HTMLInputElement>('flat-file').onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadFlat(f);
};
for (const id of ['flat-width', 'flat-depth', 'flat-inlay', 'flat-sides', 'flat-margin', 'flat-fill-holes', 'flat-mount', 'flat-puck-d', 'flat-puck-h']) {
  $<HTMLInputElement>(id).onchange = () => { if (id === 'flat-width') flatMountAt = undefined; updateMountControls(); if (flatDesign) buildFlatNow(); };
}
// turning the picture up or down, or joining the puck elsewhere, starts the mount and the spin over for that layout
for (const id of ['flat-orientation', 'flat-attach']) {
  $<HTMLSelectElement>(id).onchange = () => {
    flatMountAt = undefined;
    updateMountControls();
    $<HTMLInputElement>('spin').value = String(defaultSpin());
    if (flatDesign) buildFlatNow();
  };
}

// ---------- the magnet mount and the placement, per position ----------
// each position keeps its own placement and mount, so a picture standing on the head and one lying on a wing do not
// share a spin or a puck; a new model starts every position afresh from its defaults
const POSITION_FIELDS = ['sink', 'spin', 'tilt-x', 'tilt-y', 'dx', 'dy', 'flat-mount', 'flat-orientation', 'flat-attach', 'flat-puck-d', 'flat-puck-h', 'prep-puck', 'prep-puck-attach', 'prep-puck-d', 'prep-puck-h'];
interface PositionState { values: Record<string, string>; flatMountAt?: [number, number]; puckAt?: [number, number] }
const positions = new Map<string, PositionState>();
/** A position's starting settings: pictures stand up on the head (puck behind, resting on it) and lie flat elsewhere; the neck band needs no magnet. */
function positionDefaults(name: string): Record<string, string> {
  return {
    sink: name === 'neck' ? '0' : '2', spin: '0', 'tilt-x': '0', 'tilt-y': '0', dx: '0', dy: '0',
    'flat-mount': name === 'neck' ? 'none' : 'puck', 'flat-orientation': name === 'head' ? 'standing' : 'flat', 'flat-attach': 'back', 'flat-puck-d': '', 'flat-puck-h': '',
    'prep-puck': name === 'neck' ? 'never' : 'auto', 'prep-puck-attach': 'under', 'prep-puck-d': '', 'prep-puck-h': '',
  };
}
/** The spin a layout starts with: something standing on top of the goose (the head) turns to face the beak. */
function defaultSpin(): number {
  const pt = currentPoint();
  if (!pt || pt.axis[2] <= 0.5) return 0;
  const standing = flatDesign ? $<HTMLSelectElement>('flat-orientation').value === 'standing' : !!rawModel && $<HTMLSelectElement>('prep-puck-attach').value === 'behind';
  return standing ? Math.round(spinToward(pt.axis, [0, -1], forwardOnGoose())) : 0;
}
function savePosition() {
  if (!activePoint) return;
  positions.set(activePoint, { values: Object.fromEntries(POSITION_FIELDS.map((id) => [id, $<HTMLInputElement>(id).value])), flatMountAt, puckAt });
}
function restorePosition() {
  const saved = positions.get(activePoint);
  const values = saved?.values ?? positionDefaults(activePoint);
  for (const id of POSITION_FIELDS) $<HTMLInputElement>(id).value = values[id] ?? '';
  flatMountAt = saved?.flatMountAt;
  puckAt = saved?.puckAt;
  updateMountControls();
  if (!saved) $<HTMLInputElement>('spin').value = String(defaultSpin());
  for (const id of ['sink', 'spin', 'tilt-x', 'tilt-y', 'dx', 'dy']) syncSlider(id);
}
/** Forgets every position's settings (a new model), and sets the current one to its defaults. */
function resetPositions() {
  positions.clear();
  restorePosition();
}
/** Moves to another position: this one's settings are kept for coming back, the other's are put in place. */
function choosePoint(name: string) {
  if (name === activePoint) return;
  savePosition();
  activePoint = name;
  restorePosition();
  onPointChange();
}
/** Shows the mount choices that apply to what is loaded and where, and explains the one chosen. */
function updateMountControls() {
  const neck = activePoint === 'neck';
  $('mount-details').classList.toggle('hidden', neck);
  $('flat-mount-controls').classList.toggle('hidden', !flatDesign);
  $('puck-controls').classList.toggle('hidden', !rawModel);
  const kind = $<HTMLSelectElement>('flat-mount').value;
  const orientation = $<HTMLSelectElement>('flat-orientation').value;
  const attach = $<HTMLSelectElement>('flat-attach');
  // a picture lying flat has only its back to join a puck to
  attach.querySelector<HTMLOptionElement>('option[value="bottom"]')!.disabled = orientation === 'flat';
  if (orientation === 'flat') attach.value = 'back';
  attach.disabled = kind !== 'puck' || orientation === 'flat';
  $<HTMLSelectElement>('flat-orientation').disabled = kind === 'none';
  for (const id of ['flat-puck-d', 'flat-puck-h']) $<HTMLInputElement>(id).disabled = kind !== 'puck';
  const hint = kind === 'none' ? 'No magnet: glue it on, or wear it on the neck band.'
    : kind === 'plate' ? (orientation === 'standing' ? 'A standing picture needs a puck: its edge is too thin for the magnet.' : 'The magnet goes into the picture\'s back, which lies on the goose; 4 mm or more of thickness holds it.')
    : orientation === 'flat' ? 'Parallel: the puck is under the picture\'s back, and the picture lies on the goose over the magnet.'
    : attach.value === 'back' ? 'Perpendicular: the puck rests on the goose behind the picture, joined to its back at the bottom, and the picture stands just in front of it facing the beak.'
    : 'Perpendicular: the puck is under the picture\'s bottom edge, and the picture stands on top of it.';
  $('flat-mount-hint').textContent = hint;
  const never = $<HTMLSelectElement>('prep-puck').value === 'never';
  for (const id of ['prep-puck-attach', 'prep-puck-d', 'prep-puck-h']) $<HTMLInputElement>(id).disabled = never;
  $<HTMLButtonElement>('move-mount').disabled = !accessoryObject;
}

// drag a file anywhere onto the page
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); view.classList.add('drop'); });
document.addEventListener('dragleave', (e) => { if (!(e as DragEvent).relatedTarget) view.classList.remove('drop'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  view.classList.remove('drop');
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) loadFile(file, true); // dropped on the Clothing tab, it stays there as the wrap ghost
});

// ---------- base generators ----------
$<HTMLSelectElement>('gen-shape').onchange = (e) => {
  const shape = (e.target as HTMLSelectElement).value;
  $('gen-d-row').classList.toggle('hidden', shape !== 'plate');
  $('gen-i-row').classList.toggle('hidden', shape !== 'ring');
  if (shape === 'dome') $<HTMLInputElement>('gen-h').value = (Number($<HTMLInputElement>('gen-w').value) / 2).toString();
};

let baseManifold: ManifoldT | null = null;
let decorationManifold: ManifoldT | null = null;

async function generateBase(): Promise<ManifoldT> {
  const { Manifold } = await manifold();
  const shape = $<HTMLSelectElement>('gen-shape').value;
  const w = Number($<HTMLInputElement>('gen-w').value);
  const h = Number($<HTMLInputElement>('gen-h').value);
  const pt = activePoint === 'neck' ? undefined : profile.points[activePoint];
  const minW = pt ? (pt.shape === 'box' && pt.size ? Math.hypot(...pt.size) : pt.diameter) + 3 : 0;
  if (w < minW) status(`Note: ${w} mm is narrower than the ${minW.toFixed(1)} mm this magnet needs with 1.5 mm walls.`);
  switch (shape) {
    case 'dome': {
      const r = w / 2;
      return Manifold.sphere(r, 96).intersect(Manifold.cube([w, w, r], false).translate(-r, -r, 0));
    }
    case 'plate': {
      const d = Number($<HTMLInputElement>('gen-d').value);
      const rr = Math.min(3, w / 4, d / 4);
      // rounded box: hull of four corner cylinders
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
        Manifold.cylinder(h, rr, rr, 32, false).translate(sx * (w / 2 - rr), sy * (d / 2 - rr), 0));
      return Manifold.hull(corners);
    }
    case 'ring': {
      const inner = Number($<HTMLInputElement>('gen-i').value) / 2;
      return Manifold.cylinder(h, w / 2, w / 2, 96, false).subtract(Manifold.cylinder(h + 2, inner, inner, 96, false).translate(0, 0, -1));
    }
    default:
      return Manifold.cylinder(h, w / 2, w / 2, 96, false);
  }
}

async function useBase() {
  baseManifold = await generateBase();
  let m = baseManifold;
  if (decorationManifold) m = m.add(decorationManifold);
  accessoryManifold = m;
  accessoryMesh = fromManifold(m);
  showAccessory();
  status(`Base generated${decorationManifold ? ' with decoration' : ''}. Place it, then Fit.`);
}
$('generate').onclick = () => { useBase().catch((e) => status(`Generate failed: ${e.message}`)); };
for (const id of ['gen-w', 'gen-d', 'gen-h', 'gen-i']) $<HTMLInputElement>(id).onchange = () => { if (baseManifold) useBase(); };

$<HTMLInputElement>('decoration-file').onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const { Manifold } = await manifold();
    const mesh = parseStl(await file.arrayBuffer());
    const deco = await toManifold(mesh);
    // the decoration sits on top of the base: its lowest point lands at the base's top
    const h = Number($<HTMLInputElement>('gen-h').value);
    const bb = deco.boundingBox();
    decorationManifold = deco.translate(-(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2, h - bb.min[2] - 0.5);
    void Manifold;
    await useBase();
  } catch (err) {
    status(`${file.name}: ${(err as Error).message}`);
  }
};

function placement(): Placement {
  const num = (id: string) => { const v = $<HTMLInputElement>(id).value; return v === '' ? undefined : Number(v); };
  return {
    point: activePoint,
    sink: Number($<HTMLInputElement>('sink').value),
    spin: Number($<HTMLInputElement>('spin').value),
    tilt: [Number($<HTMLInputElement>('tilt-x').value), Number($<HTMLInputElement>('tilt-y').value)],
    offset: [Number($<HTMLInputElement>('dx').value), Number($<HTMLInputElement>('dy').value)],
    pocket: {
      diameter: num('pocket-dia'),
      thickness: num('pocket-thick'),
      radialClearance: num('pocket-radial'),
      axialClearance: num('pocket-axial'),
      none: $<HTMLInputElement>('pocket-none').checked,
      ribs: $<HTMLInputElement>('pocket-ribs').checked ? Number($<HTMLInputElement>('pocket-rib-count').value) || 3 : 0,
      ribCrush: num('pocket-rib-crush'),
    },
  };
}

// ---------- magnet presets: common discs fill the size boxes, a fit preset the clearances; typing makes them custom ----------
const MAGNET_SIZES = [[3, 1], [3, 2], [4, 1], [4, 2], [5, 1], [5, 2], [5, 3], [6, 1], [6, 2], [6, 3], [8, 2], [8, 3], [10, 2], [10, 3], [10, 4], [12, 2], [12, 3], [15, 3], [20, 3]];
const FIT_PRESETS: Record<string, { radial: number; axial: number; ribs: boolean }> = {
  press: { radial: 0, axial: 0.1, ribs: false },
  snug: { radial: 0.1, axial: 0.1, ribs: false },
  loose: { radial: 0.2, axial: 0.15, ribs: false },
  ribs: { radial: 0.25, axial: 0.1, ribs: true },
};
{
  const preset = $<HTMLSelectElement>('pocket-preset');
  const custom = preset.querySelector('option[value="custom"]')!;
  for (const [d, t] of MAGNET_SIZES) {
    const o = document.createElement('option');
    o.value = `${d}x${t}`; o.textContent = `${d} × ${t} mm disc`;
    preset.insertBefore(o, custom);
  }
  preset.onchange = () => {
    const v = preset.value;
    const dia = $<HTMLInputElement>('pocket-dia'), thick = $<HTMLInputElement>('pocket-thick');
    if (v === 'auto') { dia.value = ''; thick.value = ''; }
    else if (v !== 'custom') { const [d, t] = v.split('x'); dia.value = d; thick.value = t; }
    clearFitted();
  };
  for (const id of ['pocket-dia', 'pocket-thick']) $<HTMLInputElement>(id).addEventListener('input', () => {
    const d = $<HTMLInputElement>('pocket-dia').value, t = $<HTMLInputElement>('pocket-thick').value;
    const match = MAGNET_SIZES.find(([dd, tt]) => String(dd) === d && String(tt) === t);
    preset.value = d === '' && t === '' ? 'auto' : match ? `${match[0]}x${match[1]}` : 'custom';
  });
  const fit = $<HTMLSelectElement>('pocket-fit');
  fit.onchange = () => {
    const p = FIT_PRESETS[fit.value];
    if (!p) return;
    $<HTMLInputElement>('pocket-radial').value = String(p.radial);
    $<HTMLInputElement>('pocket-axial').value = String(p.axial);
    $<HTMLInputElement>('pocket-ribs').checked = p.ribs;
    clearFitted();
  };
  for (const id of ['pocket-radial', 'pocket-axial', 'pocket-ribs']) $<HTMLInputElement>(id).addEventListener('input', () => {
    const r = Number($<HTMLInputElement>('pocket-radial').value), a = Number($<HTMLInputElement>('pocket-axial').value), ribs = $<HTMLInputElement>('pocket-ribs').checked;
    const match = Object.entries(FIT_PRESETS).find(([, p]) => p.radial === r && p.axial === a && p.ribs === ribs);
    fit.value = match ? match[0] : 'custom';
  });
  // the default press fit fills the boxes
  $<HTMLInputElement>('pocket-radial').value = '0';
  $<HTMLInputElement>('pocket-axial').value = '0.1';
}

function updatePreview() {
  for (const id of ['sink', 'spin', 'tilt-x', 'tilt-y', 'dx', 'dy', 'clearance']) syncSlider(id);
  if (!accessoryObject) return;
  const pt = currentPoint();
  if (!pt) return;
  const pl = placement();
  const origin: V3 = [pt.center[0] - pt.axis[0] * pl.sink, pt.center[1] - pt.axis[1] * pl.sink, pt.center[2] - pt.axis[2] * pl.sink];
  // pivot = frame (with the spin) · tilt about y · tilt about x, as fitAccessory applies them; the mesh carries the slide
  const frame = new THREE.Matrix4().fromArray(frameAt(origin, pt.axis, pl.spin));
  const tilt = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(pl.tilt![0]), THREE.MathUtils.degToRad(pl.tilt![1]), 0, 'ZYX'));
  frame.multiply(tilt).decompose(accessoryPivot.position, accessoryPivot.quaternion, accessoryPivot.scale);
  accessoryObject.position.set(pl.offset[0], pl.offset[1], 0);
  accessoryObject.visible = !fittedObject;
  if (fittedObject) gizmo.detach();
}

for (const id of ['sink', 'spin', 'tilt-x', 'tilt-y', 'dx', 'dy', 'clearance']) {
  $<HTMLInputElement>(id).oninput = () => { clearFitted(); updatePreview(); };
}

// ---------- rotation rings on the accessory ----------
// a click on the accessory shows three rings (red and green tilt it, blue spins it about the magnet axis); dragging a ring
// turns the pivot, which is read back into the sliders so the fit uses exactly what is shown
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setMode('rotate');
gizmo.setSpace('local');
gizmo.setSize(0.9);
scene.add(gizmo.getHelper());
gizmo.addEventListener('dragging-changed', (e) => { controls.enabled = !(e as unknown as { value: boolean }).value; });
gizmo.addEventListener('objectChange', () => {
  const pt = currentPoint();
  if (!pt) return;
  const pl = placement();
  const origin: V3 = [pt.center[0] - pt.axis[0] * pl.sink, pt.center[1] - pt.axis[1] * pl.sink, pt.center[2] - pt.axis[2] * pl.sink];
  // what is left once the bare frame is taken off the pivot: Rz(spin) · Ry(tilt y) · Rx(tilt x)
  const bare = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(frameAt(origin, pt.axis, 0)));
  const local = bare.invert().multiply(accessoryPivot.quaternion);
  const e = new THREE.Euler().setFromQuaternion(local, 'ZYX');
  const set = (id: string, deg: number, step: number, limit: number) => { $<HTMLInputElement>(id).value = String(Math.max(-limit, Math.min(limit, Math.round(deg / step) * step))); };
  set('tilt-x', THREE.MathUtils.radToDeg(e.x), 0.5, 90);
  set('tilt-y', THREE.MathUtils.radToDeg(e.y), 0.5, 90);
  set('spin', THREE.MathUtils.radToDeg(e.z), 1, 180);
  clearFitted();
  updatePreview();
});
/** Shows the rings on the accessory, or hides them. */
function showGizmo(on: boolean) {
  if (on && accessoryObject && accessoryObject.visible) gizmo.attach(accessoryPivot);
  else gizmo.detach();
}
for (const id of ['pocket-dia', 'pocket-thick', 'pocket-radial', 'pocket-axial', 'pocket-none', 'pocket-ribs', 'pocket-rib-count', 'pocket-rib-crush']) {
  $<HTMLInputElement>(id).onchange = clearFitted;
}
$<HTMLSelectElement>('point').onchange = (e) => choosePoint((e.target as HTMLSelectElement).value);
function pointHint() {
  const w = POINT_WIDTH[activePoint];
  const input = $<HTMLInputElement>('prep-width');
  input.placeholder = w ? `≈ ${w}` : 'as is';
  input.title = w ? `Empty keeps the model's size; about ${w} mm suits the ${activePoint.replace('_', ' ')}` : 'Empty keeps the model\'s size';
}

function clearFitted() {
  if (fittedObject) { scene.remove(fittedObject); fittedObject.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); fittedObject = null; }
  fitted = null;
  // the band goes back to the one the options make, with its tabs at full length
  if (fittedBand && neckBand) showBand(neckBand.band);
  fittedBand = null;
  paint = null;
  $<HTMLButtonElement>('paint-tab-button').disabled = true;
  $('fit-result').textContent = '';
  if (accessoryObject) accessoryObject.visible = tab !== 'clothing';
  if (ghost) ghost.visible = tab === 'clothing';
  updateExports();
  applyFocus();
}

/** The export buttons are live when there is a fitted part or a garment, and the panel says what they give. */
function updateExports() {
  for (const id of ['export-3mf', 'export-fitted', 'export-split']) $<HTMLButtonElement>(id).disabled = !paint;
  let info = 'Fit an accessory or make a garment to export it.';
  if (paint) {
    const used = paint.materialsUsed().size;
    const what = fitted ? `The ${activePoint === 'neck' ? 'neck' : activePoint.replace('_', ' ')} accessory` : 'The garment';
    info = `${what}: ${paint.count.toLocaleString()} faces, ${used} colour${used === 1 ? '' : 's'}.`;
    if (paint.trees.size) info += ` ${paint.trees.size.toLocaleString()} face${paint.trees.size === 1 ? ' is' : 's are'} painted in part, which Bambu Studio, OrcaSlicer and PrusaSlicer read from the 3MF.`;
    if (fittedBand) info += ' The neck band is its own part: a second STL, or a second part in the 3MF.';
    if (!fitted && garmentParts) info += ` STL gives ${garmentParts.length} files, one per half.`;
  }
  $('export-info').textContent = info;
}

/** Shows `mesh` as the fitted part, with per-face paint colours: `faceMaterial` when known, else carried over from the part shown before. */
function showFitted(mesh: IndexedMesh, faceMaterial?: Uint8Array) {
  const previous = paint;
  paint = new PaintState(mesh, palette);
  if (faceMaterial) paint.setFaces(faceMaterial);
  else if (previous?.painted) paint.carryFrom(previous); // by nearest point of the old part's paint
  if (fittedObject) { scene.remove(fittedObject); fittedObject.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); }
  fittedObject = new THREE.Mesh(paint.geometry, fittedMaterial);
  fittedObject.add(paint.backingMesh(backingMaterial));
  scene.add(fittedObject);
  idMap = null;
  if (accessoryObject) accessoryObject.visible = false;
  hideGhost();
  $<HTMLButtonElement>('paint-tab-button').disabled = false;
  $('paint-info').textContent = `${(mesh.triangles.length / 3).toLocaleString()} faces.`;
  updateClearButtons();
  updateExports();
  if (focusOn()) frameFitted();
}

$('fit').onclick = async () => {
  if (!accessoryManifold) return;
  clearFitted();
  status('Fitting…');
  $<HTMLButtonElement>('fit').disabled = true;
  await new Promise((r) => setTimeout(r, 20)); // let the status paint
  try {
    profile.clearance = Number($<HTMLInputElement>('clearance').value);
    const t0 = performance.now();
    if (activePoint === 'neck') {
      const band = await ensureBand();
      if (!band) throw new Error('the neck band could not be made');
      const { point: _p, pocket: _k, ...rest } = placement();
      const r = await fitOnNeck(gooseManifold, accessoryManifold, profile, band, rest, neckOptions());
      fitted = r;
      fittedBand = r.band;
      showBand(r.band); // with its tabs as long as the accessory has room for, or none
      $('neck-info').textContent = band.tabs.length ? (r.tabLength ? `Fitted with ${r.tabLength.toFixed(1)} mm tabs; the slots stop ${SLOT_SKIN} mm short of the accessory's front.` : 'Fitted without tabs: the accessory is too thin for slots, so glue it to the band.') : 'Fitted for gluing to the band.';
    } else {
      fitted = await fitAccessory(gooseManifold, accessoryManifold, profile, placement());
    }
    const tagged = modelTags ? fromManifoldTagged(fitted.solid, modelTags.firstID, modelTags.count, modelTags.fallback) : null;
    showFitted(fitted.mesh, tagged?.faceMaterial);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('fit-result').textContent = `Fitted in ${secs} s: ${fitted.volumeBefore.toFixed(0)} → ${fitted.volumeAfter.toFixed(0)} mm³, ${fitted.bodies} body.` + (fittedBand ? ' The band is a separate part: Export gives both.' : '') + (fitted.warnings.length ? ` Warnings: ${fitted.warnings.join('; ')}` : '');
    updateExports();
    status('Fit done. Export on the right, or adjust and fit again.');
  } catch (err) {
    status(`Fit failed: ${(err as Error).message}`);
  } finally {
    $<HTMLButtonElement>('fit').disabled = false;
  }
};

/** STL: the fitted part (plus the neck band as a second file), or a garment, one file per half when it is split. */
$('export-fitted').onclick = () => {
  if (!paint) return;
  if (!fitted && garmentParts) { garmentParts.forEach((p, i) => setTimeout(() => download(`${garmentName}.${'ab'[i] ?? i}.stl`, serializeStl(p)), i * 300)); return; }
  download(`${exportName()}.stl`, serializeStl(paint.mesh));
  if (fittedBand) setTimeout(() => download('accessory.neck.band.stl', serializeStl(fromManifold(fittedBand!))), 300);
};

// ---------- paint ----------
let paint: PaintState | null = null;
const DEFAULT_PALETTE: Material[] = [
  { name: 'Base', color: '#e9dcc3' },
  { name: 'Black', color: '#222222' },
  { name: 'Orange', color: '#f28c28' },
  { name: 'Red', color: '#d03b2f' },
];
const palette: Material[] = DEFAULT_PALETTE.map((m) => ({ ...m }));
let activeMaterial = 1;
/** Replaces the palette (the paint state shares the array, so it recolours too). */
function setPalette(materials: Material[]) {
  palette.splice(0, palette.length, ...materials.map((m) => ({ ...m })));
  activeMaterial = Math.min(1, palette.length - 1);
  renderPalette();
  paint?.recolor();
}

function renderPalette() {
  const el = $('palette');
  el.innerHTML = '';
  palette.forEach((m, i) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (i === activeMaterial ? ' active' : '');
    const color = document.createElement('input');
    color.type = 'color'; color.value = m.color;
    color.oninput = () => { m.color = color.value; paint?.recolor(); };
    const name = document.createElement('input');
    name.type = 'text'; name.value = m.name; name.title = 'Filament name, as it will appear in the 3MF';
    name.onchange = () => { m.name = name.value; };
    sw.append(color, name);
    sw.onclick = (e) => { if (e.target === sw || e.target === color) { activeMaterial = i; renderPalette(); } };
    el.appendChild(sw);
  });
}
$('palette-add').onclick = () => { palette.push({ name: `Colour ${palette.length + 1}`, color: '#4f8bd6' }); activeMaterial = palette.length - 1; renderPalette(); };
$('fill-all').onclick = () => { if (paint) { paint.snapshot(); paint.fillAll(activeMaterial); } };
$('undo').onclick = () => { if (paint && !paint.undo()) status('Nothing to undo.'); };
$('refine').onclick = async () => {
  if (!paint) return;
  const len = Number($<HTMLInputElement>('refine-len').value);
  status('Refining…');
  await new Promise((r) => setTimeout(r, 20));
  try {
    // the paint rides along as material runs, so every new face keeps its parent's colour
    const { Manifold } = await manifold();
    const firstID = Manifold.reserveIDs(palette.length);
    const baked = paint.baked(); // paint inside faces becomes faces of its own first
    const m = await toManifoldTagged(baked.mesh, baked.faceMaterial, firstID);
    const refined = fromManifoldTagged(m.refineToLength(len), firstID, palette.length);
    showFitted(refined.mesh, refined.faceMaterial);
    status(`Refined to ${(refined.mesh.triangles.length / 3).toLocaleString()} faces.`);
  } catch (err) {
    status(`Refine failed: ${(err as Error).message}`);
  }
};
/** Palette index → the slicer's paint state: 0 leaves the base to the object's own filament (1), colour n is filament n + 1. */
const paintState = (m: number) => (m === 0 ? 0 : m + 1);
/** The painted part for a 3MF: the mesh with slicer paint codes (paint inside faces kept as is), or, unticked, the paint made into faces. */
function paintedForExport(): { mesh: IndexedMesh; faceMaterial: Uint8Array; paintCodes?: string[] } {
  if (!paint) throw new Error('nothing to export');
  if ($<HTMLInputElement>('export-subtri').checked) return { mesh: paint.mesh, faceMaterial: paint.faceMaterial, paintCodes: paint.paintCodes(paintState) };
  const b = paint.baked();
  return { mesh: b.mesh, faceMaterial: b.faceMaterial };
}
$('export-3mf').onclick = () => {
  if (!paint) return;
  const used = paint.materialsUsed();
  const names = palette.filter((_, i) => used.has(i)).map((m) => m.name).join(', ');
  const part = paintedForExport();
  if (fittedBand) {
    // the painted accessory and the band as two parts of one object
    const parts = [{ name: 'Accessory', material: 0, ...part }, { name: 'Neck band', mesh: fromManifold(fittedBand), material: 0 }];
    download(`${exportName()}.3mf`, write3mfParts(parts, palette, `goose ${activePoint} accessory`));
    status(`3MF exported with colours: ${names}, and the neck band as a second part.`);
    return;
  }
  download(`${exportName()}.3mf`, write3mf(part.mesh, palette, part.faceMaterial, `goose ${activePoint} accessory`, part.paintCodes));
  status(`3MF exported with colours: ${names}. Map them to filaments in your slicer${part.paintCodes ? ` (filament ${palette.length > 1 ? `1 to ${palette.length}` : '1'} in palette order)` : ''}.`);
};
/** The fitted part's file name: the garment's when one was made, else the accessory's point. */
const exportName = () => (garmentName && !fitted ? garmentName : `accessory.${activePoint}.fitted`);
$('export-split').onclick = async () => {
  if (!paint) return;
  const depth = Number($<HTMLInputElement>('split-depth').value) || 1.2;
  status('Splitting by colour…');
  $<HTMLButtonElement>('export-split').disabled = true;
  await new Promise((r) => setTimeout(r, 20));
  try {
    const t0 = performance.now();
    const baked = paint.baked();
    const r = await splitByMaterial(baked.mesh, baked.faceMaterial, palette.length, { depth });
    const parts = r.parts.map((p) => ({ name: palette[p.material].name, mesh: p.mesh, material: p.material }));
    if (fittedBand) parts.push({ name: 'Neck band', mesh: fromManifold(fittedBand), material: 0 });
    download(`${exportName()}.parts.3mf`, write3mfParts(parts, palette, `goose ${activePoint} accessory`));
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('split-info').textContent = `${parts.length} parts in ${secs} s: ${r.parts.map((p) => `${palette[p.material].name} ${p.volume.toFixed(0)} mm³`).join(', ')}.` + (r.warnings.length ? ` ${r.warnings.join('; ')}.` : '');
    status(`Exported one part per colour (${parts.length}); the slicer loads them as one object.`);
  } catch (err) {
    status(`Split failed: ${(err as Error).message}`);
  } finally {
    $<HTMLButtonElement>('export-split').disabled = false;
  }
};
renderPalette();

// ---------- focus view: the goose and its markers out of the way, the camera on the accessory ----------
// the Hide goose button over the view; it applies on every tab but Hole, where the goose is what you click
let focus = false;
const focusOn = () => focus && tab !== 'hole';
let savedView: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
/** The part on its own: fitted, placed, or the wrap preview. */
function focusSubject(): THREE.Object3D | null {
  return fittedObject ?? (accessoryObject && accessoryObject.visible ? accessoryPivot : null) ?? (ghost && ghost.visible ? ghost : null);
}
/** Hides or shows everything that is not the part; the camera frames the part when the goose goes, and comes back after. */
function applyFocus() {
  const on = focusOn() && !!focusSubject();
  if (gooseObject) gooseObject.visible = !on;
  markers.visible = !on;
  if (pickMarker) pickMarker.visible = !on;
  grid.visible = !on;
  if (bandObject) bandObject.visible = !on && activePoint === 'neck';
  if (on && !savedView) {
    savedView = { position: camera.position.clone(), target: controls.target.clone() };
    frameFitted();
  } else if (!on && savedView) {
    camera.position.copy(savedView.position);
    controls.target.copy(savedView.target);
    savedView = null;
  }
}
/** Everything shown that the view should take in: the part alone when the goose is hidden. */
function subjectBox(): THREE.Box3 {
  const box = new THREE.Box3();
  const part = focusSubject();
  if (focusOn() && part) return box.setFromObject(part);
  for (const o of [gooseObject, part, bandObject && bandObject.visible ? bandObject : null]) if (o) box.expandByObject(o);
  return box;
}
/** Points the camera along `dir` (from the subject towards the camera; the current direction when not given) at a distance that fits the subject in the view. */
function frameView(dir?: THREE.Vector3) {
  const box = subjectBox();
  if (box.isEmpty()) return;
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(5, box.getSize(new THREE.Vector3()).length() / 2);
  const d = (dir ?? camera.position.clone().sub(controls.target)).clone().normalize();
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
  controls.target.copy(centre);
  camera.position.copy(centre).addScaledVector(d, dist);
  controls.update();
  idMap = null;
}
/** Frames the part, keeping the camera's direction. */
function frameFitted() { frameView(); }
$('focus').onclick = () => {
  focus = !focus;
  const b = $('focus');
  b.classList.toggle('on', focus);
  b.setAttribute('aria-pressed', String(focus));
  b.textContent = focus ? 'Show goose' : 'Hide goose';
  applyFocus();
};
// views from the goose's own front, side and top (the goose is turned on its base, so these follow it, not the axes)
{
  const f = () => { const v = forwardOnGoose(); return new THREE.Vector3(v[0], v[1], 0); };
  const left = () => { const v = forwardOnGoose(); return new THREE.Vector3(-v[1], v[0], 0); };
  const up = new THREE.Vector3(0, 0, 1);
  $('view-iso').onclick = () => frameView(f().multiplyScalar(0.75).addScaledVector(left(), -0.5).addScaledVector(up, 0.5));
  $('view-front').onclick = () => frameView(f().addScaledVector(up, 0.08));
  $('view-side').onclick = () => frameView(left().addScaledVector(up, 0.08));
  $('view-top').onclick = () => frameView(up.clone().addScaledVector(f(), -0.02));
  $('view-fit').onclick = () => frameView();
}

// ---------- moving the magnet: a click on the model says where it should be ----------
function setMoveMode(on: boolean) {
  moveMode = on;
  $('move-mount').classList.toggle('active', on);
  $('move-mount').textContent = on ? 'Click the model where the magnet goes (Esc stops)' : 'Move the magnet: click the model';
  if (on) showGizmo(false);
}
$('move-mount').onclick = () => setMoveMode(!moveMode);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && moveMode) setMoveMode(false); });
/** Puts the magnet under a world point on the accessory: the puck or the picture's mount moves there, or a plain model slides. */
async function moveMountTo(world: THREE.Vector3) {
  accessoryPivot.updateMatrixWorld(true);
  const p = accessoryPivot.worldToLocal(world.clone());
  const pl = placement();
  const dx = p.x - pl.offset[0], dy = p.y - pl.offset[1]; // in the model's own frame, from the magnet at its origin
  if (flatDesign && flatResult) {
    const o = flatOptions();
    if (o.mount.kind === 'none') { status('This picture has no magnet mount; choose a puck or the plate first.'); return; }
    flatMountAt = o.mount.orientation === 'standing' ? [flatResult.mountAt[0] + dx, flatResult.mountAt[1]] : [flatResult.mountAt[0] + dx, flatResult.mountAt[1] + dy];
    await buildFlatNow();
    status(`Mount moved to (${flatMountAt.map((v) => v.toFixed(1)).join(', ')}) on the picture. Fit again.`);
  } else if (rawModel && preparedPuckAt) {
    puckAt = [preparedPuckAt[0] + dx, preparedPuckAt[1] + dy];
    await applyPrepare();
    status($<HTMLSelectElement>('prep-puck-attach').value === 'behind' ? `Puck moved along the model's back to x ${puckAt[0].toFixed(1)}. Fit again.` : `Puck moved under (${puckAt.map((v) => v.toFixed(1)).join(', ')}) of the model. Fit again.`);
  } else if (accessoryObject) {
    const clamp = (v: number) => Math.max(-30, Math.min(30, Math.round(v * 2) / 2));
    $<HTMLInputElement>('dx').value = String(clamp(pl.offset[0] - dx));
    $<HTMLInputElement>('dy').value = String(clamp(pl.offset[1] - dy));
    clearFitted();
    updatePreview();
    status('The model slid so that spot sits over the magnet. Fit again.');
  }
}


let painting = false;
function paintAt(e: PointerEvent) {
  if (!paint || !fittedObject) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(fittedObject)[0];
  if (hit && paint.brush(hit.point, Number($<HTMLInputElement>('brush').value), activeMaterial)) updatePaintInfo();
}
function updatePaintInfo() {
  if (!paint) return;
  const split = paint.trees.size;
  $('paint-info').textContent = `${paint.count.toLocaleString()} faces, ${paint.paintedFaces.toLocaleString()} painted` + (split ? `, ${split.toLocaleString()} of them in part.` : '.');
  updateExports();
}

// ---------- paint tools: bucket, corners, text ----------
type PaintTool = 'brush' | 'bucket' | 'corners' | 'text' | 'image';
let paintTool: PaintTool = 'brush';
const overlay = $<HTMLCanvasElement>('overlay');
let corners: [number, number][] = [];
let hover: [number, number] | null = null;
interface StampLayer { color: RGB; contours: Contour[]; rule: CanvasFillRule; path: Path2D }
/** The picture, as layers in painting order (later ones on top), in its own units with y up. */
let stamp: { name: string; width: number; cx: number; cy: number; layers: StampLayer[] } | null = null;
let stampRaster: Raster | null = null;
let stampSettings: Partial<ImageSettings> = {};
function setPaintTool(t: PaintTool) {
  paintTool = t;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#paint-tools button')) b.classList.toggle('active', b.dataset.tool === t);
  for (const x of ['brush', 'bucket', 'corners', 'text', 'image']) $(`tool-${x}`).classList.toggle('hidden', x !== t);
  if (t !== 'corners') clearCorners();
  drawOverlay();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#paint-tools button')) b.onclick = () => setPaintTool(b.dataset.tool as PaintTool);

// which face is under each pixel: rendered once per camera position, on demand
let idMap: { ids: Int32Array; w: number; h: number } | null = null;
controls.addEventListener('change', () => { idMap = null; });
function faceMap() {
  if (!fittedObject) return null;
  const w = view.clientWidth, h = view.clientHeight;
  if (!idMap || idMap.w !== w || idMap.h !== h) idMap = { ids: faceIdMap(renderer, camera, fittedObject, w, h), w, h };
  return idMap;
}
const faceAt = (x: number, y: number) => { const m = faceMap(); if (!m) return -1; const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= m.w || yi >= m.h ? -1 : m.ids[yi * m.w + xi]; };
const local = (e: { clientX: number; clientY: number }): [number, number] => { const r = renderer.domElement.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
/** Where a face's centre lands on screen. */
function centroidOnScreen(f: number): [number, number] {
  const c = paint!.centroids;
  const v = new THREE.Vector3(c[f * 3], c[f * 3 + 1], c[f * 3 + 2]).project(camera);
  return [((v.x + 1) / 2) * view.clientWidth, ((1 - v.y) / 2) * view.clientHeight];
}
function frontFacing(f: number): boolean {
  const c = paint!.centroids, n = paint!.faceNormals;
  const dx = c[f * 3] - camera.position.x, dy = c[f * 3 + 1] - camera.position.y, dz = c[f * 3 + 2] - camera.position.z;
  return n[f * 3] * dx + n[f * 3 + 1] * dy + n[f * 3 + 2] * dz < 0;
}
/** Screen pixels per millimetre at the depth of a face (the centre of the part when none is given). */
function pixelsPerMm(f: number): number {
  let p: THREE.Vector3;
  if (f >= 0 && paint) { const c = paint.centroids; p = new THREE.Vector3(c[f * 3], c[f * 3 + 1], c[f * 3 + 2]); }
  else if (fittedObject) p = new THREE.Box3().setFromObject(fittedObject).getCenter(new THREE.Vector3());
  else p = controls.target.clone();
  const dist = Math.max(1, camera.position.distanceTo(p));
  return (view.clientHeight / 2) / (dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
/** A screen mask as labels: `activeMaterial` where `inMask`, else nothing. */
function maskLabels(inMask: (x: number, y: number) => boolean): Int16Array {
  const w = view.clientWidth, h = view.clientHeight, labels = new Int16Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inMask(x, y)) labels[y * w + x] = activeMaterial;
  return labels;
}
/** Labels from a canvas drawn over the view: `material` where its alpha passes half, others left as they are. */
function canvasLabels(ctx: CanvasRenderingContext2D, labels: Int16Array, material: number) {
  const w = view.clientWidth, h = view.clientHeight;
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] > 127) labels[i] = material;
}
/**
 * Paints a screen stamp (a palette index per pixel, −1 for none) onto the
 * faces that show under it, splitting faces where its colours change, so it
 * needs no Refine. Faces too small to own a pixel come along from the ring
 * around the ones that do.
 */
function paintStamp(labels: Int16Array, what: string) {
  const map = faceMap();
  if (!map || !paint) return;
  const { ids, w, h } = map;
  const p = paint;
  const seen = new Set<number>();
  for (let i = 0; i < w * h; i++) {
    if (labels[i] < 0) continue;
    // the pixel and its neighbours, so faces along the stamp's edge are in too
    for (const j of [i, i - 1, i + 1, i - w, i + w]) { const f = ids[j]; if (j >= 0 && j < w * h && f >= 0 && f < p.count) seen.add(f); }
  }
  const adj = p.faceAdjacency;
  const candidates = new Set<number>();
  for (const f of seen) {
    if (frontFacing(f)) candidates.add(f);
    for (let k = 0; k < 3; k++) { const g = adj[f * 3 + k]; if (g >= 0 && !seen.has(g) && frontFacing(g)) candidates.add(g); }
  }
  const v = new THREE.Vector3();
  const stampView: StampView = {
    project: (x, y, z) => { v.set(x, y, z).project(camera); return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h]; },
    visible: (f, x, y) => { const g = ids[Math.floor(y) * w + Math.floor(x)]; return g === f || (g >= 0 && p.touches(f, g)); },
  };
  paint.snapshot();
  const t0 = performance.now();
  const n = paint.paintLabels({ labels, width: w, height: h }, stampView, candidates);
  updatePaintInfo();
  const ms = performance.now() - t0;
  status(n ? `${what}: ${n.toLocaleString()} faces painted${paint.trees.size ? ', split where the edge crosses them' : ''} (${ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`}).` : `${what}: nothing under it. Point at the part, or zoom in.`);
}
const textOptions = () => ({
  text: $<HTMLInputElement>('text-value').value,
  size: Number($<HTMLInputElement>('text-size').value),
  angle: Number($<HTMLInputElement>('text-angle').value),
  font: $<HTMLSelectElement>('text-font').value,
});
/** Draws the text into a 2D context at a screen point, as the stamp and the preview do. */
function placeText(ctx: CanvasRenderingContext2D, x: number, y: number, fontPx: number, mode: 'fill' | 'stroke') {
  const o = textOptions();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(THREE.MathUtils.degToRad(-o.angle));
  ctx.font = o.font.replace('1px', `${fontPx.toFixed(1)}px`);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (mode === 'fill') { ctx.fillStyle = '#fff'; ctx.fillText(o.text, 0, 0); }
  else { ctx.lineWidth = 1.5; ctx.strokeStyle = '#f2b84b'; ctx.strokeText(o.text, 0, 0); ctx.fillStyle = 'rgba(242,184,75,0.25)'; ctx.fillText(o.text, 0, 0); }
  ctx.restore();
}
function stampText(x: number, y: number) {
  const o = textOptions();
  if (!o.text.trim()) { status('Type some text first.'); return; }
  const f = faceAt(x, y);
  if (f < 0) { status('Point at the part to stamp the text on it.'); return; }
  const w = view.clientWidth, h = view.clientHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  placeText(ctx, x, y, o.size * pixelsPerMm(f), 'fill');
  const labels = new Int16Array(w * h).fill(-1);
  canvasLabels(ctx, labels, activeMaterial);
  paintStamp(labels, `"${o.text}"`);
}
function applyCorners() {
  if (corners.length < 3) { status('Click at least three corners first.'); return; }
  const poly = corners;
  paintStamp(maskLabels((x, y) => insidePolygon(poly, x + 0.5, y + 0.5)), `${poly.length} corners`);
  clearCorners();
}
function clearCorners() {
  corners = [];
  $<HTMLButtonElement>('corners-apply').disabled = true;
  $('corners-info').textContent = 'No corners yet.';
  drawOverlay();
}
$('corners-apply').onclick = applyCorners;
$('corners-clear').onclick = clearCorners;
window.addEventListener('keydown', (e) => {
  if (tab !== 'paint' || paintTool !== 'corners' || (e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'Escape') clearCorners();
  if (e.key === 'Enter') applyCorners();
});
/** The 2D layer over the view: the corners so far and the text about to be stamped. */
function drawOverlay() {
  const w = view.clientWidth, h = view.clientHeight;
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  if (tab !== 'paint' || !paint) return;
  if (paintTool === 'corners' && corners.length) {
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (hover) ctx.lineTo(hover[0], hover[1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(242,184,75,0.18)'; ctx.fill();
    ctx.strokeStyle = '#f2b84b'; ctx.lineWidth = 1.5; ctx.stroke();
    for (const [x, y] of corners) { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = '#f2b84b'; ctx.fill(); }
  }
  if (paintTool === 'text' && hover) {
    const f = faceAt(hover[0], hover[1]);
    placeText(ctx, hover[0], hover[1], textOptions().size * pixelsPerMm(f), 'stroke');
  }
  if (paintTool === 'image' && hover && stamp) {
    const f = faceAt(hover[0], hover[1]);
    ctx.save();
    ctx.globalAlpha = 0.7;
    placeStamp(ctx, hover[0], hover[1], pixelsPerMm(f), (layer) => { ctx.fillStyle = hex(layer.color); ctx.fill(layer.path, layer.rule); });
    ctx.restore();
    // the outline, so it shows on a part of the same colour
    placeStamp(ctx, hover[0], hover[1], pixelsPerMm(f), (layer, scale) => { ctx.lineWidth = 1.2 / scale; ctx.strokeStyle = '#f2b84b'; ctx.stroke(layer.path); });
  }
}

// ---------- image stamp: a picture painted onto the part as the camera sees it ----------
function setStamp(name: string, layers: Omit<StampLayer, 'path'>[]) {
  const all = layers.flatMap((l) => l.contours);
  if (!all.length) throw new Error('nothing left to stamp');
  const b = bounds(all);
  stamp = {
    name, width: Math.max(1e-6, b.maxX - b.minX), cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2,
    layers: layers.map((l) => {
      const path = new Path2D();
      for (const c of l.contours) { for (let i = 0; i < c.length; i += 2) (i ? path.lineTo(c[i], c[i + 1]) : path.moveTo(c[i], c[i + 1])); path.closePath(); }
      return { ...l, path };
    }),
  };
  $('stamp-preview').replaceChildren(tracedPreview({ width: stamp.width, height: b.maxY - b.minY, regions: stamp.layers }));
  $<HTMLButtonElement>('stamp-adjust').disabled = !stampRaster;
  const colours = new Set(stamp.layers.map((l) => hex(l.color))).size;
  $('stamp-info').textContent = `${name}: ${colours} colour${colours === 1 ? '' : 's'}. Move over the part to place it, click to paint. Right-drag to turn the view.`;
  setPaintTool('image');
}
/** Draws the stamp's layers centred on a screen point, `pxPerMm` at the part's depth there. */
function placeStamp(ctx: CanvasRenderingContext2D, x: number, y: number, pxPerMm: number, draw: (layer: StampLayer, scale: number) => void) {
  if (!stamp) return;
  const scale = (Number($<HTMLInputElement>('stamp-width').value) * pxPerMm) / stamp.width; // screen px per picture unit
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(THREE.MathUtils.degToRad(-Number($<HTMLInputElement>('stamp-angle').value)));
  ctx.scale(scale, -scale); // the picture's y is up
  ctx.translate(-stamp.cx, -stamp.cy);
  for (const layer of stamp.layers) draw(layer, scale);
  ctx.restore();
}
/** The palette entry for a colour: the one already that colour, or a new one. */
function paletteIndexOf(color: string): number {
  const i = palette.findIndex((m) => m.color.toLowerCase() === color.toLowerCase());
  if (i >= 0) return i;
  palette.push({ name: `Image ${palette.filter((m) => /^Image \d+$/.test(m.name)).length + 1}`, color });
  return palette.length - 1;
}
function stampImage(x: number, y: number) {
  if (!stamp) { status('Choose a picture first.'); return; }
  const f = faceAt(x, y);
  if (f < 0) { status('Point at the part to stamp the picture on it.'); return; }
  const w = view.clientWidth, h = view.clientHeight;
  const one = $<HTMLInputElement>('stamp-one').checked;
  const before = palette.length;
  const materials = stamp.layers.map((l) => (one ? activeMaterial : paletteIndexOf(hex(l.color))));
  if (palette.length !== before) renderPalette();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const labels = new Int16Array(w * h).fill(-1);
  const ppm = pixelsPerMm(f);
  stamp.layers.forEach((layer, i) => {
    ctx.clearRect(0, 0, w, h);
    placeStamp(ctx, x, y, ppm, (l, _scale) => { if (l === layer) { ctx.fillStyle = '#fff'; ctx.fill(l.path, l.rule); } });
    canvasLabels(ctx, labels, materials[i]);
  });
  paintStamp(labels, stamp.name);
}
async function loadStamp(file: File) {
  try {
    if (/\.svg$/i.test(file.name)) {
      const doc = parseSvg(await file.text()); // y already up
      const shapes = doc.shapes.filter((sh) => sh.fill !== 'none');
      if (!shapes.length) throw new Error('no filled shapes in the SVG');
      stampRaster = null; stampSettings = {};
      setStamp(file.name, shapes.map((sh) => ({ color: cssColor(sh.fill ?? '#000000'), contours: sh.contours, rule: sh.fillRule })));
    } else {
      status(`Opening ${file.name}…`);
      const raster = await decodeImage(file);
      const prepared = await prepareImage(raster, file.name, stampSettings, { title: 'Prepare the picture to paint' });
      if (!prepared) { status(`${file.name} was not used.`); return; }
      stampRaster = raster; stampSettings = prepared.settings;
      setStamp(file.name, prepared.regions.map((r) => ({ color: r.color, contours: r.contours, rule: 'evenodd' as CanvasFillRule })));
    }
    status(`${file.name} is ready: click the part to paint it.`);
  } catch (err) {
    status(`${file.name}: ${(err as Error).message}`);
  }
}
$<HTMLInputElement>('stamp-file').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await loadStamp(file);
  input.value = '';
};
$('stamp-adjust').onclick = async () => {
  if (!stampRaster || !stamp) return;
  const prepared = await prepareImage(stampRaster, stamp.name, stampSettings, { title: 'Prepare the picture to paint' });
  if (!prepared) return;
  stampSettings = prepared.settings;
  setStamp(stamp.name, prepared.regions.map((r) => ({ color: r.color, contours: r.contours, rule: 'evenodd' as CanvasFillRule })));
};
for (const id of ['stamp-width', 'stamp-angle', 'stamp-width-num', 'stamp-angle-num']) $<HTMLInputElement>(id).addEventListener('input', drawOverlay);

for (const id of ['text-value', 'text-size', 'text-angle', 'text-font', 'text-size-num', 'text-angle-num']) $<HTMLInputElement>(id).addEventListener('input', drawOverlay);
renderer.domElement.addEventListener('pointerleave', () => { hover = null; drawOverlay(); });
renderer.domElement.addEventListener('dblclick', (e) => {
  if (tab !== 'paint' || paintTool !== 'corners') return;
  e.preventDefault();
  corners.pop(); // the second click of the double added one more corner
  applyCorners();
});

// ---------- tabs ----------
let tab = 'accessory';
function setTab(name: string) {
  tab = name;
  for (const x of document.querySelectorAll<HTMLButtonElement>('.tabs button')) x.classList.toggle('active', x.dataset.tab === name);
  for (const t of ['accessory', 'clothing', 'hole', 'paint']) $(`tab-${t}`).classList.toggle('hidden', t !== name);
  guides.visible = name === 'clothing';
  if (name === 'clothing') { updateGuides(); wrapPreview(); } else { hideGhost(); if (name === 'accessory') updatePreview(); }
  applyFocus();
  if (name !== 'accessory') { showGizmo(false); setMoveMode(false); }
  drawOverlay();
  // in paint mode the left button paints and the right button orbits
  controls.mouseButtons = name === 'paint'
    ? { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.onclick = () => setTab(b.dataset.tab!);
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (tab !== 'paint' || e.button !== 0 || !paint || paintTool !== 'brush') return;
  painting = true;
  paint.snapshot();
  paintAt(e);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (painting) paintAt(e);
  if (tab === 'paint' && (paintTool === 'text' || paintTool === 'corners' || paintTool === 'image')) { hover = local(e); drawOverlay(); }
});
window.addEventListener('pointerup', () => { painting = false; });

// ---------- the neck band ----------
function neckOptions(): NeckOptions {
  const num = (id: string, d: number) => { const v = Number($<HTMLInputElement>(id).value); return Number.isFinite(v) && $<HTMLInputElement>(id).value !== '' ? v : d; };
  return {
    height: num('neck-height', DEFAULT_NECK.height),
    bandHeight: num('neck-band-h', DEFAULT_NECK.bandHeight),
    thickness: num('neck-thick', DEFAULT_NECK.thickness),
    clearance: num('neck-clear', DEFAULT_NECK.clearance),
    opening: num('neck-opening', DEFAULT_NECK.opening),
    attach: $<HTMLSelectElement>('neck-attach').value as NeckOptions['attach'],
    tabDiameter: num('neck-tab-d', DEFAULT_NECK.tabDiameter),
    tabLength: num('neck-tab-l', DEFAULT_NECK.tabLength),
    tabSpacing: num('neck-tab-s', DEFAULT_NECK.tabSpacing),
    tabClearance: DEFAULT_NECK.tabClearance,
  };
}
let bandPending: Promise<NeckBand | null> | null = null;
/** Builds the band for the current options when the neck is the chosen point (once per set of options), and shows it. */
function ensureBand(): Promise<NeckBand | null> {
  if (activePoint !== 'neck' || !gooseManifold) { if (bandObject) bandObject.visible = false; return Promise.resolve(null); }
  const o = neckOptions();
  const key = JSON.stringify(o);
  if (key === neckKey && neckBand) { if (bandObject) bandObject.visible = !focusOn(); return Promise.resolve(neckBand); }
  if (key === neckKey && bandPending) return bandPending;
  neckKey = key;
  clearFitted();
  bandPending = makeNeckBand(gooseManifold, profile, o).then((b) => {
    if (key !== neckKey) return neckBand;
    neckBand = b;
    showBand(b.band);
    $('neck-info').textContent = `Neck ${b.neckWidth.toFixed(1)} mm across here, opening ${b.openingWidth.toFixed(1)} mm at the back${b.tabs.length ? `, ${b.tabs.length} tabs` : ''}.${b.warnings.length ? ` ${b.warnings.join('; ')}.` : ''}`;
    updatePreview();
    return b;
  }).catch((err) => { status(`Band failed: ${(err as Error).message}`); $('neck-info').textContent = (err as Error).message; return null; });
  return bandPending;
}
/** Shows a band on the neck: the one the options make, or the one fitted with its tabs shortened. */
function showBand(m: ManifoldT) {
  if (bandObject) { scene.remove(bandObject); bandObject.geometry.dispose(); }
  bandObject = new THREE.Mesh(toGeometry(fromManifold(m)), bandMaterial);
  bandObject.visible = activePoint === 'neck' && !focusOn();
  scene.add(bandObject);
}
let bandTimer = 0;
for (const id of ['neck-height', 'neck-band-h', 'neck-thick', 'neck-clear', 'neck-opening', 'neck-attach', 'neck-tab-d', 'neck-tab-l', 'neck-tab-s']) {
  $<HTMLInputElement>(id).addEventListener('input', () => {
    syncSlider('neck-height'); syncSlider('neck-opening');
    $('neck-tab-row').classList.toggle('hidden', $<HTMLSelectElement>('neck-attach').value !== 'tabs');
    clearTimeout(bandTimer);
    bandTimer = window.setTimeout(() => { ensureBand(); }, 150);
  });
}

// ---------- clothing ----------
// two rings on the goose mark the hem and neck heights
const guides = new THREE.Group();
guides.visible = false;
scene.add(guides);
function ring(color: number): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 96; i++) { const a = (i / 96) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * 72, Math.sin(a) * 72, 0)); }
  return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
}
const hemRing = ring(0xf2b84b), neckRing = ring(0x6fb1ff);
guides.add(hemRing, neckRing);
function garmentOptions(): Partial<WrapOptions> {
  const num = (id: string) => Number($<HTMLInputElement>(id).value);
  return {
    hem: num('cloth-hem'), neck: num('cloth-neck'), thickness: num('cloth-thick'), clearance: num('cloth-clear'),
    collar: $<HTMLSelectElement>('cloth-collar').value as GarmentOptions['collar'], collarGap: num('cloth-gap'), smooth: num('cloth-smooth'),
    neckSpread: num('cloth-spread'), neckSpreadHeight: num('cloth-spread-height'),
    neckline: $<HTMLSelectElement>('cloth-neckline').value as GarmentOptions['neckline'], necklineDepth: num('cloth-neckline-depth'), necklineWidth: num('cloth-neckline-width'),
    collarHeight: num('cloth-collar-height'), frontOffset: num('cloth-front'),
    fabric: $<HTMLSelectElement>('cloth-fabric').value as GarmentOptions['fabric'], fabricDepth: num('cloth-fabric-depth'), fabricPitch: num('cloth-fabric-pitch'),
    buttons: num('cloth-buttons'), buttonDiameter: num('cloth-button-dia'), placket: $<HTMLInputElement>('cloth-placket').checked,
    hemBand: num('cloth-hem-band'), stripes: num('cloth-stripes'), axisToNeck: num('cloth-lean'),
    split: $<HTMLSelectElement>('cloth-split').value as GarmentOptions['split'], formFit: $<HTMLInputElement>('cloth-form-fit').checked,
    splitMagnets: num('cloth-split-magnets'), splitMagnetDiameter: num('cloth-split-magnet-dia'), splitMagnetThickness: num('cloth-split-magnet-thick'),
    keepTop: num('cloth-keep-top'), liner: num('cloth-liner'), smoothModel: num('cloth-smooth-model'), garmentTurn: num('wrap-turn'), garmentShift: [num('wrap-dx'), num('wrap-dy')],
    garmentBand: [num('wrap-band-lo'), $<HTMLInputElement>('wrap-band-hi').value === '' ? Infinity : num('wrap-band-hi')],
    garmentCrop: [num('wrap-crop-l'), num('wrap-crop-r'), num('wrap-crop-f'), num('wrap-crop-b')],
    tags: modelTags ?? undefined,
  };
}

// ghost preview of the loaded model, cropped, where the wrap will put it; the body profile is cached per hem/neck/lean
let cavityKey = '', cavity: Cavity | null = null;
let cropKey = '', ghost: THREE.Mesh | null = null;
let previewTimer = 0;
function hideGhost() { if (ghost) ghost.visible = false; }
function wrapPreview() {
  if (tab !== 'clothing' || !accessoryManifold || !gooseManifold) { hideGhost(); return; }
  if (accessoryObject) accessoryObject.visible = false;
  const o = garmentOptions();
  if (o.neck! <= o.hem!) return;
  const key = [o.hem, o.neck, o.axisToNeck, o.clearance, o.collar, o.smooth, o.frontOffset, o.neckSpread, o.neckSpreadHeight].join('/');
  if (key !== cavityKey) {
    cavityKey = key;
    cavity = null;
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => { cavity = cavityProfile(gooseManifold, o); wrapPreview(); }, 50);
    return;
  }
  if (!cavity) return;
  const ck = [loadSerial, rawName, o.garmentBand, o.garmentCrop].join('/');
  if (ck !== cropKey || !ghost) {
    cropKey = ck;
    if (ghost) { scene.remove(ghost); ghost.geometry.dispose(); }
    ghost = new THREE.Mesh(toGeometry(fromManifold(trimGarment(accessoryManifold, o).garment)), accessoryMaterial);
    ghost.matrixAutoUpdate = false;
    scene.add(ghost);
  }
  const f = wrapFrame(accessoryManifold, cavity, o);
  ghost.matrix.fromArray(f.matrix);
  ghost.visible = !fittedObject;
  if (accessoryObject) accessoryObject.visible = false;
}
for (const id of ['wrap-turn', 'wrap-dx', 'wrap-dy', 'wrap-band-lo', 'wrap-band-hi', 'wrap-crop-l', 'wrap-crop-r', 'wrap-crop-f', 'wrap-crop-b', 'cloth-keep-top', 'cloth-spread', 'cloth-spread-height', 'cloth-lean', 'cloth-front', 'cloth-hem', 'cloth-neck']) {
  $<HTMLInputElement>(id).addEventListener('input', wrapPreview);
}
function updateGuides() {
  const o = garmentOptions();
  syncSlider('cloth-hem');
  syncSlider('cloth-neck');
  const bb = gooseMesh ? gooseObject.geometry.boundingBox ?? gooseObject.geometry.computeBoundingBox() ?? gooseObject.geometry.boundingBox : null;
  const cx = bb ? (bb.min.x + bb.max.x) / 2 : 115, cy = bb ? (bb.min.y + bb.max.y) / 2 : 140;
  hemRing.position.set(cx, cy, o.hem!);
  neckRing.position.set(cx, cy, o.neck!);
}
for (const id of ['cloth-hem', 'cloth-neck']) $<HTMLInputElement>(id).oninput = updateGuides;

async function makeGarment(kind: 'shirt' | 'wrap') {
  const o = garmentOptions();
  if (o.neck! <= o.hem!) { status('The neck must be above the hem.'); return; }
  if (kind === 'wrap' && !accessoryManifold) { status('Load a garment model on the Accessory tab first.'); return; }
  status(kind === 'shirt' ? 'Building the shirt…' : 'Wrapping the model over the body…');
  $<HTMLButtonElement>('make-shirt').disabled = true;
  $<HTMLButtonElement>('wrap-garment').disabled = true;
  await new Promise((r) => setTimeout(r, 20));
  try {
    const t0 = performance.now();
    const g = kind === 'shirt' ? await contourGarment(gooseManifold, o) : await wrapGarment(accessoryManifold!, gooseManifold, o);
    clearFitted();
    showFitted(g.mesh, g.faceMaterial);
    garmentParts = g.parts && g.parts.length > 1 ? g.parts.map((p) => fromManifold(p)) : null;
    garmentName = kind === 'shirt' ? `shirt.${o.hem}-${o.neck}` : `${rawName.replace(/\.[^.]+$/, '')}.wrapped`;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('cloth-result').textContent = `Done in ${secs} s: ${g.solid.volume().toFixed(0)} mm³, ${(g.mesh.triangles.length / 3).toLocaleString()} faces. ${g.warnings.join('; ')}`;
    updateExports();
    status('Garment ready. Export it on the right, or paint it on the Paint tab.');
  } catch (err) {
    status(`Failed: ${(err as Error).message}`);
  } finally {
    $<HTMLButtonElement>('make-shirt').disabled = false;
    $<HTMLButtonElement>('wrap-garment').disabled = !accessoryManifold;
  }
}
let garmentName = 'shirt';
let garmentParts: IndexedMesh[] | null = null;
$('make-shirt').onclick = () => { makeGarment('shirt'); };
$('wrap-garment').onclick = () => { makeGarment('wrap'); };

// ---------- magnet hole tool ----------
$<HTMLSelectElement>('hole-mode').onchange = (e) => {
  $('skin-row').classList.toggle('hidden', (e.target as HTMLSelectElement).value !== 'embedded');
};

const raycaster = new THREE.Raycaster();
let downAt = [0, 0];
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return; // a drag, not a click
  if (tab === 'paint' && e.button === 0 && paint && fittedObject) {
    const [x, y] = local(e);
    if (paintTool === 'bucket') {
      // the drawn triangle under the cursor says which face, and which piece of it when it is painted in part
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1), camera);
      const hit = raycaster.intersectObject(fittedObject)[0];
      const t = hit?.faceIndex ?? -1;
      if (t < 0 || paint.triFace[t] < 0) { status('Click on the part to fill a region.'); return; }
      paint.snapshot();
      const n = paint.bucket(paint.triFace[t], paint.triLeaf[t], activeMaterial, Number($<HTMLInputElement>('bucket-angle').value));
      updatePaintInfo();
      status(n ? `Filled ${n.toLocaleString()} faces ${palette[activeMaterial].name}.` : 'That region is already this colour.');
    } else if (paintTool === 'corners') {
      corners.push([x, y]);
      $<HTMLButtonElement>('corners-apply').disabled = corners.length < 3;
      $('corners-info').textContent = `${corners.length} corner${corners.length === 1 ? '' : 's'}.${corners.length >= 3 ? ' Double-click, Enter or Fill inside to paint.' : ''}`;
      drawOverlay();
    } else if (paintTool === 'text') {
      stampText(x, y);
    } else if (paintTool === 'image') {
      stampImage(x, y);
    }
    return;
  }
  if (tab === 'accessory' && moveMode && e.button === 0 && (fittedObject || accessoryObject)) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const target = fittedObject ?? accessoryObject!;
    const hit = raycaster.intersectObject(target)[0];
    if (!hit) { status('Click on the model to put the magnet there.'); return; }
    moveMountTo(hit.point);
    return;
  }
  if (tab === 'accessory' && accessoryObject && accessoryObject.visible && !gizmo.dragging) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    showGizmo(raycaster.intersectObject(accessoryObject).length > 0);
    return;
  }
  if (tab !== 'hole' || !gooseObject) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(gooseObject)[0];
  if (!hit || !hit.face) return;
  const n = hit.face.normal.clone().transformDirection(gooseObject.matrixWorld).normalize();
  pick = { point: [hit.point.x, hit.point.y, hit.point.z], normal: [n.x, n.y, n.z] };
  if (pickMarker) scene.remove(pickMarker);
  pickMarker = new THREE.ArrowHelper(n, hit.point, 10, 0xff6060, 3, 2);
  scene.add(pickMarker);
  $('pick').textContent = `Picked (${pick.point.map((v) => v.toFixed(1)).join(', ')}), normal (${pick.normal.map((v) => v.toFixed(2)).join(', ')})`;
  $<HTMLButtonElement>('cut-hole').disabled = false;
});

$('cut-hole').onclick = async () => {
  if (!pick) return;
  const name = $<HTMLInputElement>('hole-name').value.trim() || 'point';
  const mode = $<HTMLSelectElement>('hole-mode').value as 'open' | 'embedded';
  status('Cutting hole…');
  await new Promise((r) => setTimeout(r, 20));
  try {
    const result = await addMagnetHole(gooseManifold, gooseMesh, {
      point: pick.point,
      axis: pick.normal,
      diameter: Number($<HTMLInputElement>('hole-dia').value),
      thickness: Number($<HTMLInputElement>('hole-thick').value),
      mode,
      skin: Number($<HTMLInputElement>('hole-skin').value),
    });
    gooseManifold = result.model;
    if (gooseFaceMaterial) {
      const tagged = fromManifoldTagged(gooseManifold, gooseFirstID, gooseMaterials.length, gooseFallback);
      setGoose(tagged.mesh, tagged.faceMaterial);
    } else {
      setGoose(fromManifold(gooseManifold));
    }
    profile.points[name] = result.point;
    savePosition();
    activePoint = name;
    restorePosition();
    renderPoints();
    $('hole-result').textContent = `${mode} hole "${name}" cut.` + (result.pauseZ !== undefined ? ` Pause the print at Z = ${result.pauseZ.toFixed(2)} mm to insert the magnet.` : '');
    status(`Hole "${name}" added. Export the goose STL to print it.`);
    if (pickMarker) { scene.remove(pickMarker); pickMarker = null; }
    pick = null;
    $<HTMLButtonElement>('cut-hole').disabled = true;
  } catch (err) {
    status(`Cut failed: ${(err as Error).message}`);
  }
};

$('export-goose').onclick = () => download('goose.holed.stl', serializeStl(gooseMesh));
$('export-profile').onclick = () => download('profile.json', new TextEncoder().encode(JSON.stringify(profile, null, 2)));

function download(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// small hook for the headless smoke test: where a world point lands on screen
(window as unknown as { __goose: unknown }).__goose = {
  get profile() { return profile; },
  get gooseVisible() { return gooseObject.visible; },
  get ringsShown() { return !!gizmo.object; },
  get band() { return neckBand ? { width: neckBand.neckWidth, opening: neckBand.openingWidth, tabs: neckBand.tabs.length, volume: neckBand.band.volume(), shown: !!bandObject && bandObject.visible } : null; },
  get mount() { return flatResult ? flatResult.mountAt : preparedPuckAt; },
  /** the model's width along x over a band of heights, in its own frame (for checking which way up a picture is) */
  accessoryWidth(zLo: number, zHi: number) {
    if (!accessoryMesh) return 0;
    const p = accessoryMesh.positions;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.length; i += 3) if (p[i + 2] >= zLo && p[i + 2] <= zHi) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
    return hi - lo;
  },
  get accessoryBox() {
    if (!accessoryMesh) return null;
    const p = accessoryMesh.positions, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) { min[i % 3] = Math.min(min[i % 3], p[i]); max[i % 3] = Math.max(max[i % 3], p[i]); }
    return { min, max };
  },
  get moveMode() { return moveMode; },
  lookAt(target: V3, position: V3) { controls.target.set(...target); camera.position.set(...position); controls.update(); },
  get camera() { return { position: camera.position.toArray(), target: controls.target.toArray() }; },
  modelOnScreen(dx: number, dy: number, dz: number) {
    // a point given in the model's own frame, as the view shows it
    accessoryPivot.updateMatrixWorld(true);
    const off = placement().offset;
    const w = accessoryPivot.localToWorld(new THREE.Vector3(dx + off[0], dy + off[1], dz));
    const v = w.project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
  },
  showRings(on: boolean) { showGizmo(on); },
  setPaintTool(t: string) { setPaintTool(t as PaintTool); },
  faceAt(x: number, y: number) { return faceAt(x, y); },
  toScreen(p: V3) {
    const v = new THREE.Vector3(...p).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
  },
};

init().catch((e) => status(`Failed to load: ${e.message}`));

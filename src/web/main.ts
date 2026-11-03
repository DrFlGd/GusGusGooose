// Browser UI around the fitting pipeline: the goose with its magnet points,
// an accessory placed at one of them, Fit, export. Plus the magnet-hole tool.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { parseStl, serializeStl, type IndexedMesh } from '../stl.ts';
import { DEFAULT_PROFILE, fitAccessory, frameAt, fromManifold, fromManifoldTagged, manifold, toManifold, toManifoldTagged, type FitProfile, type FitResult, type Placement } from '../fit.ts';
import { loadModel } from '../load-model.ts';
import { DEFAULT_PREPARE, prepareAccessory, type PrepareOptions, type Side } from '../prepare.ts';
import { contourGarment, wrapGarment, cavityProfile, wrapFrame, trimGarment, type Cavity, type GarmentOptions, type WrapOptions } from '../clothing.ts';
import { expandRuns, type GooseColors } from '../goose-colors.ts';
import { addMagnetHole } from '../hole.ts';
import type { MagnetVoid } from '../voids.ts';
import { write3mf, write3mfParts, type Material } from '../threemf-write.ts';
import { splitByMaterial } from '../split-colours.ts';
import { PaintState } from './paint.ts';

type V3 = [number, number, number];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- scene ----------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d22);
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
const grid = new THREE.GridHelper(300, 30, 0x3a3e47, 0x2a2d34);
grid.rotation.x = Math.PI / 2;
grid.position.set(115, 128, 0);
scene.add(grid);

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
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
function renderPoints() {
  markers.clear();
  const list = $('points');
  list.innerHTML = '';
  const select = $<HTMLSelectElement>('point');
  select.innerHTML = '';
  for (const [name, p] of Object.entries(profile.points)) {
    const li = document.createElement('li');
    const shape = p.shape === 'box' && p.size ? `${p.size[0].toFixed(1)} × ${p.size[1].toFixed(1)} block` : `${p.diameter.toFixed(1)} dia`;
    li.innerHTML = `<b>${name}</b>${shape} × ${p.depth.toFixed(1)} mm, ${p.mode ?? 'open'}${p.skin ? ` under ${p.skin.toFixed(1)} mm` : ''}`;
    li.classList.toggle('active', name === activePoint);
    li.onclick = () => { activePoint = name; select.value = name; renderPoints(); updatePreview(); };
    list.appendChild(li);
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    select.appendChild(opt);
    markers.add(marker(p, name === activePoint));
  }
  if (!activePoint && Object.keys(profile.points).length) { activePoint = Object.keys(profile.points)[0]; renderPoints(); return; }
  select.value = activePoint;
  pointHint();
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
const POINT_WIDTH: Record<string, number> = { head: 25, left_wing: 40, right_wing: 40, beak: 16 };

let loadSerial = 0;
/** Loads a model as the accessory; from the Clothing tab (`stay`) it is shown there as the wrap ghost instead of switching tabs. */
async function loadFile(file: File, stay = false) {
  status(`Reading ${file.name}…`);
  let loaded: Awaited<ReturnType<typeof loadModel>>;
  try {
    const voxel = $<HTMLInputElement>('repair-voxel').value;
    loaded = await loadModel(file.name, await file.arrayBuffer(), { repair: $<HTMLInputElement>('repair-import').checked, voxel: voxel === '' ? undefined : Number(voxel) });
    rawModel = loaded.solid;
    rawName = file.name;
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
  if (modelTags) { modelTags = null; setPalette(DEFAULT_PALETTE); }
  baseManifold = null;
  accessoryManifold = null;
  accessoryMesh = null;
  garmentParts = null;
  loadSerial++;
  if (accessoryObject) { accessoryPivot.remove(accessoryObject); accessoryObject.geometry.dispose(); accessoryObject = null; gizmo.detach(); }
  if (ghost) { scene.remove(ghost); ghost.geometry.dispose(); ghost = null; cropKey = ''; }
  for (const id of ['accessory-file', 'cloth-file']) $<HTMLInputElement>(id).value = ''; // so the same file can be loaded again
  $('prepare-controls').classList.add('hidden');
  $('accessory-controls').classList.add('hidden');
  $('model-info').textContent = '';
  $('cloth-model').textContent = 'No model loaded; Make shirt needs none.';
  $('cloth-result').textContent = '';
  $<HTMLButtonElement>('wrap-garment').disabled = true;
  updateClearButtons();
  updatePreview();
  status('Cleared. Load another model, or make a shirt.');
}
/** The Clear buttons are live when there is something to clear: a loaded model or a fitted part. */
function updateClearButtons() {
  const something = !!rawModel || !!fittedObject;
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
  if (prep.fill) { status('Filling the hollow underside…'); await new Promise((r) => setTimeout(r, 20)); }
  try {
    const prepared = await prepareAccessory(rawModel, prep);
    accessoryManifold = prepared.solid;
    accessoryMesh = fromManifold(prepared.solid);
    const size = prepared.size.map((v) => v.toFixed(1)).join(' × ');
    const fill = prepared.fill ? ` Filled ${prepared.fill.volume.toFixed(0)} mm³, ${prepared.fill.depth.toFixed(1)} mm deep from a floor ${prepared.fill.floor.toFixed(1)} mm above the lowest point.` : '';
    status(`${rawName}: ${size} mm after preparing${prep.width ? ` (scaled ×${prepared.scale.toFixed(3)})` : ''}.${fill}${prepared.warnings.length ? ` ${prepared.warnings.join('; ')}.` : ''} Place it, then Fit.`);
  } catch (err) {
    status(`Prepare failed: ${(err as Error).message}`);
    return;
  }
  showAccessory();
}

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
  updatePreview();
}

$<HTMLInputElement>('accessory-file').onchange = (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) loadFile(file);
};
for (const id of ['prep-down', 'prep-width', 'prep-scale', 'prep-centre', 'prep-plug-d', 'prep-plug-h', 'prep-fill']) {
  $<HTMLInputElement>(id).onchange = () => { applyPrepare(); };
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
  const pt = profile.points[activePoint];
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
    },
  };
}

function updatePreview() {
  for (const id of ['sink', 'spin', 'tilt-x', 'tilt-y', 'dx', 'dy', 'clearance']) {
    const v = Number($<HTMLInputElement>(id).value);
    $(`${id}-out`).textContent = id === 'spin' ? v.toFixed(0) : id === 'clearance' ? v.toFixed(2) : v.toFixed(1);
  }
  if (!accessoryObject) return;
  const pt = profile.points[activePoint];
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
  const pt = profile.points[activePoint];
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
for (const id of ['pocket-dia', 'pocket-thick', 'pocket-radial', 'pocket-axial', 'pocket-none']) {
  $<HTMLInputElement>(id).onchange = clearFitted;
}
$<HTMLSelectElement>('point').onchange = (e) => { activePoint = (e.target as HTMLSelectElement).value; clearFitted(); renderPoints(); updatePreview(); };
function pointHint() {
  const w = POINT_WIDTH[activePoint];
  $<HTMLInputElement>('prep-width').placeholder = w ? `keep size (about ${w} for the ${activePoint.replace('_', ' ')})` : 'keep size';
}

function clearFitted() {
  if (fittedObject) { scene.remove(fittedObject); fittedObject.geometry.dispose(); fittedObject = null; }
  fitted = null;
  paint = null;
  $<HTMLButtonElement>('export-fitted').disabled = true;
  $<HTMLButtonElement>('export-cloth').disabled = true;
  $<HTMLButtonElement>('paint-tab-button').disabled = true;
  $('fit-result').textContent = '';
  if (accessoryObject) accessoryObject.visible = tab !== 'clothing';
  if (ghost) ghost.visible = tab === 'clothing';
  applyFocus();
}

/** Shows `mesh` as the fitted part, with per-face paint colours: `faceMaterial` when known, else carried over from the part shown before. */
function showFitted(mesh: IndexedMesh, faceMaterial?: Uint8Array) {
  const previous = paint;
  paint = new PaintState(mesh, palette);
  if (faceMaterial) {
    paint.faceMaterial.set(faceMaterial);
    paint.recolor();
  } else if (previous) {
    // carry the paint over by nearest old face centroid
    const oc = previous.centroids, nc = paint.centroids;
    for (let i = 0; i < paint.faceMaterial.length; i++) {
      let best = Infinity, bi = 0;
      for (let j = 0; j < previous.faceMaterial.length; j++) {
        const dx = oc[j * 3] - nc[i * 3], dy = oc[j * 3 + 1] - nc[i * 3 + 1], dz = oc[j * 3 + 2] - nc[i * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; bi = j; }
      }
      paint.faceMaterial[i] = previous.faceMaterial[bi];
    }
    paint.recolor();
  }
  if (fittedObject) { scene.remove(fittedObject); fittedObject.geometry.dispose(); }
  fittedObject = new THREE.Mesh(paint.geometry, fittedMaterial);
  scene.add(fittedObject);
  if (accessoryObject) accessoryObject.visible = false;
  hideGhost();
  $<HTMLButtonElement>('paint-tab-button').disabled = false;
  $('paint-info').textContent = `${(mesh.triangles.length / 3).toLocaleString()} faces.`;
  updateClearButtons();
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
    fitted = await fitAccessory(gooseManifold, accessoryManifold, profile, placement());
    const tagged = modelTags ? fromManifoldTagged(fitted.solid, modelTags.firstID, modelTags.count, modelTags.fallback) : null;
    showFitted(fitted.mesh, tagged?.faceMaterial);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('fit-result').textContent = `Fitted in ${secs} s: ${fitted.volumeBefore.toFixed(0)} → ${fitted.volumeAfter.toFixed(0)} mm³, ${fitted.bodies} body.` + (fitted.warnings.length ? ` Warnings: ${fitted.warnings.join('; ')}` : '');
    $<HTMLButtonElement>('export-fitted').disabled = false;
    status('Fit done. Export or adjust and fit again.');
  } catch (err) {
    status(`Fit failed: ${(err as Error).message}`);
  } finally {
    $<HTMLButtonElement>('fit').disabled = false;
  }
};

const exportStl = () => { if (paint) download(`accessory.${activePoint}.fitted.stl`, serializeStl(paint.mesh)); };
$('export-fitted').onclick = exportStl;
$('export-fitted-2').onclick = exportStl;

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
$<HTMLInputElement>('brush').oninput = () => { $('brush-out').textContent = Number($<HTMLInputElement>('brush').value).toFixed(1); };
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
    const m = await toManifoldTagged(paint.mesh, paint.faceMaterial, firstID);
    const refined = fromManifoldTagged(m.refineToLength(len), firstID, palette.length);
    showFitted(refined.mesh, refined.faceMaterial);
    status(`Refined to ${(refined.mesh.triangles.length / 3).toLocaleString()} faces.`);
  } catch (err) {
    status(`Refine failed: ${(err as Error).message}`);
  }
};
$('export-3mf').onclick = () => {
  if (!paint) return;
  const used = new Set(paint.faceMaterial);
  const names = palette.filter((_, i) => used.has(i)).map((m) => m.name).join(', ');
  download(`${exportName()}.3mf`, write3mf(paint.mesh, palette, paint.faceMaterial, `goose ${activePoint} accessory`));
  status(`3MF exported with colours: ${names}. Map them to filaments in your slicer.`);
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
    const r = await splitByMaterial(paint.mesh, paint.faceMaterial, palette.length, { depth });
    const parts = r.parts.map((p) => ({ name: palette[p.material].name, mesh: p.mesh, material: p.material }));
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

// ---------- focus view: the goose and its markers out of the way, the camera on the painted part ----------
const focusOn = () => tab === 'paint' && $<HTMLInputElement>('paint-focus').checked;
let savedView: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
/** Hides or shows everything that is not the fitted part. */
function applyFocus() {
  const on = focusOn() && !!fittedObject;
  if (gooseObject) gooseObject.visible = !on;
  markers.visible = !on;
  if (pickMarker) pickMarker.visible = !on;
  grid.visible = !on;
  if (on) {
    if (!savedView) savedView = { position: camera.position.clone(), target: controls.target.clone() };
    frameFitted();
  } else if (savedView) {
    camera.position.copy(savedView.position);
    controls.target.copy(savedView.target);
    savedView = null;
  }
}
/** Moves the camera, keeping its direction, so the fitted part fills the view. */
function frameFitted() {
  if (!fittedObject) return;
  const box = new THREE.Box3().setFromObject(fittedObject);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dir = camera.position.clone().sub(controls.target).normalize();
  const dist = (radius / Math.sin((camera.fov / 2) * (Math.PI / 180))) * 1.15;
  controls.target.copy(centre);
  camera.position.copy(centre).addScaledVector(dir, Math.max(dist, 20));
}
$<HTMLInputElement>('paint-focus').onchange = applyFocus;

let painting = false;
function paintAt(e: PointerEvent) {
  if (!paint || !fittedObject) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(fittedObject)[0];
  if (hit && paint.brush(hit.point, Number($<HTMLInputElement>('brush').value), activeMaterial)) {
    let painted = 0;
    for (const m of paint.faceMaterial) if (m !== 0) painted++;
    $('paint-info').textContent = `${paint.faceMaterial.length.toLocaleString()} faces, ${painted.toLocaleString()} painted.`;
  }
}

// ---------- tabs ----------
let tab = 'accessory';
function setTab(name: string) {
  tab = name;
  for (const x of document.querySelectorAll<HTMLButtonElement>('.tabs button')) x.classList.toggle('active', x.dataset.tab === name);
  for (const t of ['accessory', 'clothing', 'hole', 'paint']) $(`tab-${t}`).classList.toggle('hidden', t !== name);
  guides.visible = name === 'clothing';
  if (name === 'clothing') { updateGuides(); wrapPreview(); } else { hideGhost(); if (name === 'accessory') updatePreview(); }
  applyFocus();
  if (name !== 'accessory') showGizmo(false);
  // in paint mode the left button paints and the right button orbits
  controls.mouseButtons = name === 'paint'
    ? { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.onclick = () => setTab(b.dataset.tab!);
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (tab !== 'paint' || e.button !== 0 || !paint) return;
  painting = true;
  paint.snapshot();
  paintAt(e);
});
renderer.domElement.addEventListener('pointermove', (e) => { if (painting) paintAt(e); });
window.addEventListener('pointerup', () => { painting = false; });

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
$<HTMLInputElement>('cloth-lean').oninput = () => { $('cloth-lean-out').textContent = $<HTMLInputElement>('cloth-lean').value; };
$<HTMLInputElement>('wrap-turn').oninput = () => { $('wrap-turn-out').textContent = $<HTMLInputElement>('wrap-turn').value; };

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
$<HTMLInputElement>('cloth-neckline-width').oninput = () => { $('cloth-neckline-width-out').textContent = $<HTMLInputElement>('cloth-neckline-width').value; };
$<HTMLInputElement>('cloth-front').oninput = () => { $('cloth-front-out').textContent = $<HTMLInputElement>('cloth-front').value; };
function updateGuides() {
  const o = garmentOptions();
  $('cloth-hem-out').textContent = String(o.hem);
  $('cloth-neck-out').textContent = String(o.neck);
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
    $<HTMLButtonElement>('export-cloth').disabled = false;
    status('Garment ready. Export it, or paint it on the Paint tab.');
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
$('export-cloth').onclick = () => {
  if (!paint) return;
  if (garmentParts) garmentParts.forEach((p, i) => download(`${garmentName}.${'ab'[i] ?? i}.stl`, serializeStl(p)));
  else download(`${garmentName}.stl`, serializeStl(paint.mesh));
};

// ---------- magnet hole tool ----------
$<HTMLSelectElement>('hole-mode').onchange = (e) => {
  $('skin-row').classList.toggle('hidden', (e.target as HTMLSelectElement).value !== 'embedded');
};

const raycaster = new THREE.Raycaster();
let downAt = [0, 0];
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return; // a drag, not a click
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
    activePoint = name;
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
  showRings(on: boolean) { showGizmo(on); },
  toScreen(p: V3) {
    const v = new THREE.Vector3(...p).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
  },
};

init().catch((e) => status(`Failed to load: ${e.message}`));

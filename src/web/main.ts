// Browser UI around the fitting pipeline: the goose with its magnet points,
// an accessory placed at one of them, Fit, export. Plus the magnet-hole tool.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { parseStl, serializeStl, type IndexedMesh } from '../stl.ts';
import { DEFAULT_PROFILE, fitAccessory, frameAt, fromManifold, manifold, toManifold, type FitProfile, type FitResult, type Placement } from '../fit.ts';
import { addMagnetHole } from '../hole.ts';
import type { MagnetVoid } from '../voids.ts';
import { write3mf, type Material } from '../threemf-write.ts';
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

// ---------- state ----------
let gooseMesh: IndexedMesh;
let gooseManifold: ManifoldT;
let gooseObject: THREE.Mesh;
let profile: FitProfile;
let accessoryMesh: IndexedMesh | null = null;
let accessoryManifold: ManifoldT | null = null;
let accessoryObject: THREE.Mesh | null = null;
let fittedObject: THREE.Mesh | null = null;
let fitted: FitResult | null = null;
let activePoint = '';
const markers = new THREE.Group();
scene.add(markers);
let pick: { point: V3; normal: V3 } | null = null;
let pickMarker: THREE.Object3D | null = null;

const status = (s: string) => { $('status').textContent = s; };

async function init() {
  const [stl, prof] = await Promise.all([
    fetch(import.meta.env.BASE_URL + 'goose.stl').then((r) => r.arrayBuffer()),
    fetch(import.meta.env.BASE_URL + 'profile.json').then((r) => (r.ok ? r.json() : { ...DEFAULT_PROFILE, points: {} })),
  ]);
  gooseMesh = parseStl(stl);
  profile = prof;
  setGoose(gooseMesh);
  status('Starting geometry engine…');
  await manifold();
  gooseManifold = await toManifold(gooseMesh);
  status(`Goose loaded: ${(gooseMesh.triangles.length / 3).toLocaleString()} triangles, ${Object.keys(profile.points).length} magnet points.`);
  renderPoints();
}

function setGoose(mesh: IndexedMesh) {
  gooseMesh = mesh;
  if (gooseObject) { scene.remove(gooseObject); gooseObject.geometry.dispose(); }
  gooseObject = new THREE.Mesh(toGeometry(mesh), gooseMaterial);
  scene.add(gooseObject);
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
$<HTMLInputElement>('accessory-file').onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  status(`Reading ${file.name}…`);
  try {
    accessoryMesh = parseStl(await file.arrayBuffer());
    accessoryManifold = await toManifold(accessoryMesh);
  } catch (err) {
    status(`${file.name}: ${(err as Error).message}`);
    return;
  }
  clearFitted();
  if (accessoryObject) { scene.remove(accessoryObject); accessoryObject.geometry.dispose(); }
  accessoryObject = new THREE.Mesh(toGeometry(accessoryMesh), accessoryMaterial);
  scene.add(accessoryObject);
  $('accessory-controls').classList.remove('hidden');
  status(`${file.name}: ${(accessoryMesh.triangles.length / 3).toLocaleString()} triangles. Place it, then Fit.`);
  updatePreview();
};

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
  clearFitted();
  if (accessoryObject) { scene.remove(accessoryObject); accessoryObject.geometry.dispose(); }
  accessoryObject = new THREE.Mesh(toGeometry(accessoryMesh), accessoryMaterial);
  scene.add(accessoryObject);
  $('accessory-controls').classList.remove('hidden');
  status(`Base generated${decorationManifold ? ' with decoration' : ''}. Place it, then Fit.`);
  updatePreview();
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
  for (const id of ['sink', 'spin', 'dx', 'dy', 'clearance']) {
    const v = Number($<HTMLInputElement>(id).value);
    $(`${id}-out`).textContent = id === 'spin' ? v.toFixed(0) : id === 'clearance' ? v.toFixed(2) : v.toFixed(1);
  }
  if (!accessoryObject) return;
  const pt = profile.points[activePoint];
  if (!pt) return;
  const pl = placement();
  const origin: V3 = [pt.center[0] - pt.axis[0] * pl.sink, pt.center[1] - pt.axis[1] * pl.sink, pt.center[2] - pt.axis[2] * pl.sink];
  const m = new THREE.Matrix4().fromArray(frameAt(origin, pt.axis, pl.spin));
  m.multiply(new THREE.Matrix4().makeTranslation(pl.offset[0], pl.offset[1], 0));
  accessoryObject.matrixAutoUpdate = false;
  accessoryObject.matrix.copy(m);
  accessoryObject.visible = !fittedObject;
}

for (const id of ['sink', 'spin', 'dx', 'dy', 'clearance']) {
  $<HTMLInputElement>(id).oninput = () => { clearFitted(); updatePreview(); };
}
for (const id of ['pocket-dia', 'pocket-thick', 'pocket-radial', 'pocket-axial', 'pocket-none']) {
  $<HTMLInputElement>(id).onchange = clearFitted;
}
$<HTMLSelectElement>('point').onchange = (e) => { activePoint = (e.target as HTMLSelectElement).value; clearFitted(); renderPoints(); updatePreview(); };

function clearFitted() {
  if (fittedObject) { scene.remove(fittedObject); fittedObject.geometry.dispose(); fittedObject = null; }
  fitted = null;
  paint = null;
  $<HTMLButtonElement>('export-fitted').disabled = true;
  $<HTMLButtonElement>('paint-tab-button').disabled = true;
  $('fit-result').textContent = '';
  if (accessoryObject) accessoryObject.visible = true;
}

/** Shows `mesh` as the fitted part, with per-face paint colours. */
function showFitted(mesh: IndexedMesh) {
  const previous = paint;
  paint = new PaintState(mesh, palette);
  if (previous) {
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
  $<HTMLButtonElement>('paint-tab-button').disabled = false;
  $('paint-info').textContent = `${(mesh.triangles.length / 3).toLocaleString()} faces.`;
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
    showFitted(fitted.mesh);
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
const palette: Material[] = [
  { name: 'Base', color: '#e9dcc3' },
  { name: 'Black', color: '#222222' },
  { name: 'Orange', color: '#f28c28' },
  { name: 'Red', color: '#d03b2f' },
];
let activeMaterial = 1;

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
    const m = await toManifold(paint.mesh);
    const refined = fromManifold(m.refineToLength(len));
    showFitted(refined);
    status(`Refined to ${(refined.triangles.length / 3).toLocaleString()} faces.`);
  } catch (err) {
    status(`Refine failed: ${(err as Error).message}`);
  }
};
$('export-3mf').onclick = () => {
  if (!paint) return;
  const used = new Set(paint.faceMaterial);
  const names = palette.filter((_, i) => used.has(i)).map((m) => m.name).join(', ');
  download(`accessory.${activePoint}.fitted.3mf`, write3mf(paint.mesh, palette, paint.faceMaterial, `goose ${activePoint} accessory`));
  status(`3MF exported with colours: ${names}. Map them to filaments in your slicer.`);
};
renderPalette();

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
  for (const t of ['accessory', 'hole', 'paint']) $(`tab-${t}`).classList.toggle('hidden', t !== name);
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

// ---------- magnet hole tool ----------
$<HTMLSelectElement>('hole-mode').onchange = (e) => {
  $('skin-row').classList.toggle('hidden', (e.target as HTMLSelectElement).value !== 'embedded');
};

const raycaster = new THREE.Raycaster();
let downAt = [0, 0];
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (tab !== 'hole' || !gooseObject) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return; // a drag, not a click
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
    setGoose(fromManifold(gooseManifold));
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
  toScreen(p: V3) {
    const v = new THREE.Vector3(...p).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
  },
};

init().catch((e) => status(`Failed to load: ${e.message}`));

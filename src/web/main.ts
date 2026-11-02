// Browser UI around the fitting pipeline: the goose with its magnet points,
// an accessory placed at one of them, Fit, export. Plus the magnet-hole tool.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { parseStl, serializeStl, type IndexedMesh } from '../stl.ts';
import { DEFAULT_PROFILE, fitAccessory, frameAt, fromManifold, manifold, toManifold, type FitProfile, type FitResult, type Placement } from '../fit.ts';
import { addMagnetHole } from '../hole.ts';
import type { MagnetVoid } from '../voids.ts';

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
const fittedMaterial = new THREE.MeshStandardMaterial({ color: 0xf2b84b, roughness: 0.6 });

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
  $<HTMLButtonElement>('export-fitted').disabled = true;
  $('fit-result').textContent = '';
  if (accessoryObject) accessoryObject.visible = true;
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
    fittedObject = new THREE.Mesh(toGeometry(fitted.mesh), fittedMaterial);
    scene.add(fittedObject);
    if (accessoryObject) accessoryObject.visible = false;
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

$('export-fitted').onclick = () => {
  if (!fitted) return;
  download(`accessory.${activePoint}.fitted.stl`, serializeStl(fitted.mesh));
};

// ---------- magnet hole tool ----------
let tab = 'accessory';
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  b.onclick = () => {
    tab = b.dataset.tab!;
    for (const x of document.querySelectorAll<HTMLButtonElement>('.tabs button')) x.classList.toggle('active', x === b);
    $('tab-accessory').classList.toggle('hidden', tab !== 'accessory');
    $('tab-hole').classList.toggle('hidden', tab !== 'hole');
  };
}
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

init().catch((e) => status(`Failed to load: ${e.message}`));

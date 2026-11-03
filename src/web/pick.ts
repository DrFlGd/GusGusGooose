// Which face of a mesh sits under each pixel: the mesh is drawn once more
// into an off-screen target with its face index as the colour, and the
// pixels read back. That gives the text and corner tools exactly the faces
// the person can see, with the hidden side left alone.

import * as THREE from 'three';

const idMaterial = new THREE.ShaderMaterial({
  vertexShader: `attribute vec3 faceId; varying vec3 vId; void main() { vId = faceId; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying vec3 vId; void main() { gl_FragColor = vec4(vId, 1.0); }`,
  side: THREE.FrontSide,
});

/** Face index under every pixel of a `width` × `height` view (−1 where none), row 0 at the top like the screen. */
export function faceIdMap(renderer: THREE.WebGLRenderer, camera: THREE.Camera, mesh: THREE.Mesh, width: number, height: number): Int32Array {
  const geometry = mesh.geometry;
  const n = geometry.getAttribute('position').count; // non-indexed: three vertices per face
  if (!geometry.getAttribute('faceId') || geometry.getAttribute('faceId').count !== n) {
    const ids = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) {
      const f = (v / 3) | 0;
      ids[v * 3] = (f & 255) / 255; ids[v * 3 + 1] = ((f >> 8) & 255) / 255; ids[v * 3 + 2] = ((f >> 16) & 255) / 255;
    }
    geometry.setAttribute('faceId', new THREE.BufferAttribute(ids, 3));
  }
  const target = new THREE.WebGLRenderTarget(width, height, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  const copy = new THREE.Mesh(geometry, idMaterial);
  copy.matrixAutoUpdate = false;
  copy.matrix.copy(mesh.matrixWorld);
  scene.add(copy);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const px = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, px);
  renderer.setRenderTarget(prev);
  target.dispose();
  const out = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width; // GL rows start at the bottom
    for (let x = 0; x < width; x++) {
      const i = (srcRow + x) * 4;
      const id = px[i] | (px[i + 1] << 8) | (px[i + 2] << 16);
      out[y * width + x] = id === 0xffffff ? -1 : id;
    }
  }
  return out;
}

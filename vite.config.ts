import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the app under /<repo>/; the workflow sets BASE_PATH
  base: process.env.BASE_PATH ?? '/',
  // the bundled goose and its fit profile are served from goose.stl and profile.json
  publicDir: 'goose',
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: { target: 'es2022' },
});

import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// GitHub Pages serves the project page below /synclet/. Override with SITE_BASE=/ for a custom
// domain or local previews at the root.
export default defineConfig({
  base: process.env.SITE_BASE ?? '/synclet/',
  plugins: [tailwindcss()],
  build: { outDir: 'dist', assetsInlineLimit: 0 },
});

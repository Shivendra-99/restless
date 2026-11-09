import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    target: 'chrome130',
    rollupOptions: {
      // The app, and the toolbar of the Restless browser window.
      input: { main: resolve(__dirname, 'renderer/index.html'), browser: resolve(__dirname, 'renderer/browser.html') },
    },
  },
});

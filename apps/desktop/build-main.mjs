// Bundles the Electron main + preload into self-contained CJS files, so the packaged app
// does not need node_modules (smaller installer, no native deps).
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: true, logLevel: 'info' };

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs' });
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
await build({ ...common, entryPoints: ['src/browser-preload.ts'], outfile: 'dist/browser-preload.cjs' });

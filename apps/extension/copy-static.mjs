// Copies the manifest and icons into dist/ after the Vite build.
import fs from 'node:fs/promises';

await fs.copyFile('manifest.json', 'dist/manifest.json');
await fs.mkdir('dist/icons', { recursive: true });
for (const f of await fs.readdir('icons')) await fs.copyFile(`icons/${f}`, `dist/icons/${f}`);
console.log('Extension ready in apps/extension/dist (load it via chrome://extensions, "Load unpacked")');

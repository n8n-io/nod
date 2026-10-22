import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function buildDesktopUI(output = join(root, 'dist', 'desktop-ui')) {
  await build({
    configFile: false,
    publicDir: false,
    root,
    base: './',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [react()],
    logLevel: 'error',
    build: {
      outDir: output,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      lib: {
        entry: join(root, 'desktop', 'ui', 'setup.tsx'),
        name: 'NodStartup',
        formats: ['iife'],
        fileName: () => 'setup.js',
        cssFileName: 'setup',
      },
    },
  });
  await mkdir(output, { recursive: true });
  for (const file of ['index.html', 'styles.css', 'Geist-Variable.woff2'])
    await cp(join(root, 'desktop', 'ui', file), join(output, file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await buildDesktopUI();

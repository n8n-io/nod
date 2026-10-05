import { cp, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function buildDesktopUI(output = join(root, 'dist', 'desktop-ui')) {
  await mkdir(output, { recursive: true });
  await cp(join(root, 'desktop', 'ui'), output, {
    recursive: true,
    filter: (path) => !path.endsWith('.ts'),
  });
  await build({
    configFile: false,
    root,
    build: {
      outDir: output,
      emptyOutDir: false,
      lib: {
        entry: join(root, 'desktop', 'ui', 'analytics.ts'),
        name: 'OttoSetupAnalytics',
        formats: ['iife'],
        fileName: () => 'analytics.js',
      },
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await buildDesktopUI();

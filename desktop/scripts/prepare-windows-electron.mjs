import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Prepare Windows Electron on Windows x64.');

const require = createRequire(new URL('../node_modules/electron/package.json', import.meta.url));
const { version } = require('./package.json');
await require('@electron/get').downloadArtifact({
  version,
  artifactName: 'electron',
  platform: 'win32',
  arch: 'x64',
  checksums: require('./checksums.json'),
  downloader: {
    download: async (_url, target) => {
      execFileSync(
        'gh',
        [
          'release',
          'download',
          `v${version}`,
          '--repo',
          'electron/electron',
          '--pattern',
          `electron-v${version}-win32-x64.zip`,
          '--output',
          target,
        ],
        { stdio: 'inherit' },
      );
    },
  },
});
execFileSync(process.execPath, [require.resolve('./install.js')], { stdio: 'inherit' });

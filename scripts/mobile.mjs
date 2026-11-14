import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../clients/flutter/', import.meta.url));
const flutter = process.env.FLUTTER_BIN || 'flutter';
const [action, ...input] = process.argv.slice(2);
const args = input[0] === '--' ? input.slice(1) : input;
const actions = ['setup', 'check', 'run', 'build:ios'];

function run(command, arguments_, capture = false) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} failed (${result.signal || result.status}).`);
  }
  return result.stdout;
}

try {
  if (!action || action === '--help') {
    console.log('Usage: node scripts/mobile.mjs <setup|check|run|build:ios> [Flutter arguments]');
    console.log(
      'run: pass -d <device-id>. build:ios: defaults to an unsigned debug simulator build.',
    );
    console.log(
      'Use FLUTTER_BIN to select a Flutter executable. setup/check take no extra arguments.',
    );
  } else {
    if (!actions.includes(action)) throw new Error(`Unknown mobile command: ${action}`);
    if (['setup', 'check'].includes(action) && args.length)
      throw new Error(`${action} takes no extra arguments.`);
    const pinned = readFileSync(join(cwd, '.flutter-version'), 'utf8').trim();
    const sdk = JSON.parse(run(flutter, ['--version', '--machine'], true));
    if (sdk.frameworkVersion !== pinned)
      throw new Error(
        `Use Flutter ${pinned}; found ${sdk.frameworkVersion}. Set FLUTTER_BIN if needed.`,
      );
    if (action === 'setup') run(flutter, ['pub', 'get', '--enforce-lockfile']);
    if (action === 'check') {
      run(join(sdk.flutterRoot, 'bin', 'cache', 'dart-sdk', 'bin', 'dart'), [
        'format',
        '--output=none',
        '--set-exit-if-changed',
        'lib',
        'test',
        'integration_test',
        'tool',
      ]);
      run(flutter, ['analyze']);
      run(flutter, ['test']);
    }
    if (action === 'run') run(flutter, ['run', ...args]);
    if (action === 'build:ios') run(flutter, ['build', 'ios', '--simulator', '--debug', ...args]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

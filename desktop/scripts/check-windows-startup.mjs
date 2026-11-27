import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { run } from './release-tools.mjs';

assert.equal(process.platform, 'win32', 'Use a disposable Windows runner.');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable GitHub runner.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'dist/windows');
const installer = join(output, 'nod-Setup-x64.exe');
const application = join(process.env.LOCALAPPDATA, 'Programs/nod/nod.exe');
const profile = join(process.env.APPDATA, 'nod/profiles/local');
const log = join(profile, 'logs/startup.log');
const wsl = join(process.env.SYSTEMROOT, 'System32/wsl.exe');
const powershell = join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const previous = process.env.NOD_PREVIOUS_RELEASE || '';
const receipt = { previous, launches: [] };
const present = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function lines() {
  return (await readFile(log, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean);
}

async function running() {
  return (await run('tasklist.exe', ['/FI', 'IMAGENAME eq nod.exe', '/FO', 'CSV', '/NH'])).includes(
    'nod.exe',
  );
}

async function install(path) {
  console.log(`Installing ${path}.`);
  await run(path, ['/S', `/D=${dirname(application)}`], { timeout: 600_000 });
  assert.ok(await present(application));
}

async function launch(name, { limit = 900_000, reported = true, attempts = 1 } = {}) {
  for (let attempt = 1; attempt < attempts; attempt++) {
    try {
      return await launch(name, { limit, reported });
    } catch (error) {
      console.log(`${error.message} Trying again, as an owner would.`);
      await close();
      await returning();
    }
  }
  const seen = (await lines()).length;
  const started = Date.now();
  console.log(`Opening Nod: ${name}.`);
  spawn(application, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  for (;;) {
    const fresh = (await lines()).slice(seen);
    const failed = fresh.find((line) => /Startup failed|Local runtime failed/.test(line));
    const prepared = fresh.find((line) => line.includes('Local runtime prepared.'));
    const listening = fresh.some((line) => line.includes('Background service step: listening'));
    if (failed || Date.now() - started > limit) {
      console.log(fresh.map((line) => line.slice(0, 400)).join('\n'));
      assert.fail(failed ? `Nod failed to start: ${name}.` : `Nod did not start in time: ${name}.`);
    }
    if (prepared && (listening || !reported)) {
      const steps = Object.fromEntries(
        fresh.flatMap((line) => {
          const match = /Background service step: ([a-z]+) after ([\d.]+)s\./.exec(line);
          return match ? [[match[1], Number(match[2])]] : [];
        }),
      );
      const result = {
        name,
        seconds: Math.round((Date.now() - started) / 1000),
        runtimeMs: Number(/ms=(\d+)/.exec(prepared)?.[1]),
        version: /start version=(\S+)/.exec(
          fresh.find((line) => line.includes(' start version=')),
        )?.[1],
        steps,
        moved: fresh.some((line) => line.includes('Saved data moved')),
      };
      if (reported)
        assert.ok(steps.listening > 0, 'The background service did not report its startup steps.');
      console.log(JSON.stringify(result));
      receipt.launches.push(result);
      return result;
    }
    await delay(1000);
  }
}

async function close() {
  console.log('Quitting Nod.');
  await run(application, ['--quit'], { timeout: 60_000 }).catch(() => {});
  for (let attempt = 0; (await running()) && attempt < 180; attempt++) await delay(1000);
  assert.equal(await running(), false, 'Nod did not quit.');
}

async function quit() {
  await close();
  assert.match(
    await run(wsl, ['--list', '--verbose', '--all'], { env: { ...process.env, WSL_UTF8: '1' } }),
    /nod-[a-f0-9]{12}\s+Stopped/,
  );
}

async function returning() {
  const path = join(profile, 'settings.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...saved, onboardingPreferenceStep: 'complete' }));
}

assert.equal(await present(application), false, 'Nod is already installed on this runner.');
assert.equal(await present(profile), false, 'A Nod profile already exists on this runner.');
const protection = await run(powershell, [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "$ErrorActionPreference = 'Stop'; Set-MpPreference -DisableRealtimeMonitoring $false; foreach ($path in @((Get-MpPreference).ExclusionPath)) { if ($path) { Remove-MpPreference -ExclusionPath $path } }; Start-Sleep -Seconds 5; (Get-MpComputerStatus).RealTimeProtectionEnabled",
]).catch((error) => error.diagnostic || error.message);
receipt.realTimeProtection = /True\s*$/.test(protection);
console.log(`Real-time virus scanning: ${receipt.realTimeProtection ? 'on' : 'off'}.`);
await mkdir(output, { recursive: true });
try {
  if (previous) {
    const folder = join(process.env.RUNNER_TEMP, 'nod-previous-release');
    await mkdir(folder, { recursive: true });
    await run(
      'gh',
      [
        'release',
        'download',
        previous,
        '--repo',
        process.env.GITHUB_REPOSITORY,
        '--pattern',
        'nod-Setup-x64.exe',
        '--pattern',
        'nod-Runtime-win32-x64.tar.gz',
        '--dir',
        folder,
      ],
      { timeout: 900_000 },
    );
    await install(join(folder, 'nod-Setup-x64.exe'));
    await launch(`first setup on ${previous}`, { reported: false, attempts: 3, limit: 480_000 });
    await quit();
    await returning();
    await install(installer);
    const updated = await launch('first start after the update');
    assert.notEqual(updated.version, receipt.launches[0].version);
    assert.equal(updated.moved, true, 'Nod did not move the earlier version’s data.');
    assert.equal(
      JSON.parse(await readFile(join(profile, 'database/state.json'), 'utf8')).ready,
      true,
    );
  } else {
    await install(installer);
    await launch('first setup');
    await quit();
    await returning();
  }
  if (await running()) await quit();
  const warm = await launch('next start', { limit: 300_000 });
  assert.equal(warm.moved, false);
  assert.ok(
    warm.steps.listening < 120,
    'The background service took too long on a prepared computer.',
  );
  await quit();
} finally {
  await copyFile(log, join(output, 'windows-startup.log')).catch(() => {});
  await writeFile(join(output, 'windows-startup.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}

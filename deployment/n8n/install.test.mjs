import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { base } from './desktop-releases.mjs';
import { installer, installNodes } from './install-workflow.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const certificate = Buffer.from('synthetic installer certificate');
const pin = sha256(certificate);
const source = 'a'.repeat(40);

async function fixture(options = {}) {
  const arch = options.intel ? 'x64' : 'arm64';
  const manifestName = options.intel ? 'release-darwin-x64.json' : 'release.json';
  const destination = "applications='/Applications'";
  assert.equal(
    installer.split(destination).length,
    2,
    'The installer destination must be isolated before running fixtures.',
  );
  const directory = await mkdtemp(join(tmpdir(), 'nod-install-fixture-'));
  const home = join(directory, 'home');
  const target = join(directory, 'Applications', options.legacyInstall ? 'nod.app' : 'Nod.app');
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await mkdir(dirname(target), { recursive: true });
  const write = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
    );
  };
  const app = join(directory, 'fixture.app');
  const version = options.releaseVersion || '0.2.0';
  await write(join(app, 'Contents/Info.plist'), {
    CFBundleIdentifier: 'dev.nod.desktop',
    CFBundleShortVersionString: version,
    LSMinimumSystemVersion: '14.0',
  });
  await write(join(app, 'Contents/Resources/app/package.json'), {
    version,
    nodBuild: {
      source: options.wrongSource ? 'b'.repeat(40) : source,
      modified: false,
      updateSourceUrl: base,
    },
  });
  await write(join(app, 'Contents/MacOS/nod'), 'synthetic executable');
  await write(join(target, 'Contents/Info.plist'), {
    CFBundleIdentifier: options.wrongTarget ? 'unrelated.app' : 'dev.nod.desktop',
    CFBundleShortVersionString: options.currentVersion || '0.1.0',
  });
  await write(join(target, 'previous'), 'previous app');
  const namedTarget = join(dirname(target), 'Nod.app');
  const installTarget = await readFile(join(namedTarget, 'previous')).then(
    () => namedTarget,
    () => target,
  );
  const launches = join(directory, 'launches.json');
  await write(launches, []);
  const profile = join(home, 'Library/Application Support/nod/synthetic-profile');
  await write(profile, 'keep synthetic keys and conversations');
  const updateJob = join(directory, 'shipit-job');
  const updateCache = join(home, 'Library/Caches/dev.nod.desktop.ShipIt');
  if (options.staleUpdater) {
    await write(updateJob, 'loaded');
    await write(join(updateCache, 'ShipItState.plist'), 'stale update');
  }
  const disk = Buffer.from('synthetic disk image');
  await write(
    join(directory, 'disk'),
    options.corruptDisk ? Buffer.from('synthetic disk imagf') : disk,
  );
  await write(join(directory, 'certificate'), certificate);
  await write(join(directory, 'earlier-certificate'), 'synthetic earlier certificate');
  await write(join(directory, 'latest.json'), {
    schema: 1,
    version,
    releaseId: 42,
    disk: {
      url: options.hostileUrl
        ? 'https://attacker.invalid/nod-arm64.dmg'
        : `${base}/releases/42/assets/103/nod-${arch}.dmg`,
      bytes: disk.length,
      sha256: sha256(disk),
    },
    manifestUrl: `${base}/releases/42/assets/101/${manifestName}`,
  });
  await write(join(directory, 'release.json'), {
    version,
    platform: `darwin-${arch}`,
    source,
    minimumSystemVersion: '14.0',
    signing: { certificateSha256: options.wrongPin ? 'b'.repeat(64) : pin },
    disk: { file: `nod-${arch}.dmg`, bytes: disk.length, sha256: sha256(disk) },
  });
  const driver = `#!${process.execPath}
import{readFileSync,writeFileSync,copyFileSync,cpSync,statSync,mkdirSync,renameSync,existsSync,unlinkSync}from'node:fs';
import{basename,join}from'node:path';
const command=basename(process.argv[1]),args=process.argv.slice(2),root=process.env.FIXTURE_ROOT,options=JSON.parse(process.env.FIXTURE_OPTIONS);
const stop=()=>process.exit(1),print=value=>process.stdout.write(String(value)+'\\n');
if(command==='uname')print(args[0]==='-s'?'Darwin':options.intel?'x86_64':'arm64');
else if(command==='sw_vers')print('14.7.1');
else if(command==='id')print(options.elevated?'0':'1000');
else if(command==='stat'){const info=statSync(args[2]);print(args[1]==='%d:%i'?info.dev+':'+info.ino:info.size)}
else if(command==='pgrep')process.exit(options.running?0:1);
else if(command==='launchctl'){if(args[1]!=='gui/1000/dev.nod.desktop.ShipIt')stop();const job=join(root,'shipit-job');if(args[0]==='print')process.exit(existsSync(job)?0:113);if(args[0]!=='bootout'||options.updaterStopFailure)stop();unlinkSync(job)}
else if(command==='file')print('Mach-O 64-bit executable '+(options.intel&&!options.wrongArchitecture?'x86_64':'arm64'));
else if(command==='plutil'){let value=JSON.parse(readFileSync(args.at(-1),'utf8'));for(const key of args[1].split('.'))value=value?.[key];const type=args[args.indexOf('-expect')+1];if((type==='string'&&typeof value!=='string')||(type==='bool'&&typeof value!=='boolean')||(type==='integer'&&!Number.isInteger(value)))stop();print(value)}
else if(command==='curl'){const url=args.at(-1);if(!url.startsWith(${JSON.stringify(base + '/')}))stop();const input=url===${JSON.stringify(base + '/releases?installer=true')}+(options.intel?'&platform=darwin-x64':'')?'latest.json':url.endsWith(options.intel?'release-darwin-x64.json':'release.json')?'release.json':'disk';copyFileSync(join(root,input),args[args.indexOf('--output')+1]);if(options.targetChanged&&input==='disk'){const path=join(${JSON.stringify(target)},'Contents/Info.plist');const info=JSON.parse(readFileSync(path,'utf8'));info.CFBundleShortVersionString='0.1.1';writeFileSync(path,JSON.stringify(info))}}
else if(command==='codesign'){if(options.badSignature&&args.at(-1).includes('mount/'))stop();const extract=args.find(value=>value.startsWith('--extract-certificates='));if(extract)copyFileSync(join(root,options.earlierCertificate&&args.at(-1).endsWith('/Applications/nod.app')?'earlier-certificate':'certificate'),extract.split('=')[1]+'0')}
else if(command==='hdiutil'){if(args[0]==='attach')cpSync(join(root,'fixture.app'),join(args[args.indexOf('-mountpoint')+1],options.legacyDisk?'nod.app':'Nod.app'),{recursive:true})}
else if(command==='ditto'){if(options.copyFailure){mkdirSync(args[1],{recursive:true});writeFileSync(join(args[1],'partial'),'partial copy');stop()}cpSync(args[0],args[1],{recursive:true})}
else if(command==='open'){if(existsSync(join(root,'shipit-job'))||existsSync(join(process.env.HOME,'Library/Caches/dev.nod.desktop.ShipIt')))stop();const installed=JSON.parse(readFileSync(join(args[0],'Contents/Resources/app/package.json'),'utf8'));const log=join(root,'launches.json');writeFileSync(log,JSON.stringify([...JSON.parse(readFileSync(log,'utf8')),{args,source:installed.nodBuild.source}]));if(options.launchFailure)stop()}
else if(command==='mv'){if(existsSync(join(root,'shipit-job')))stop();if(options.swapFailure&&args[0].endsWith('/nod.app')&&args[0].includes('/.nod-install.'))stop();renameSync(args[0],args[1])}
else stop();
`;
  for (const command of [
    'uname',
    'sw_vers',
    'id',
    'stat',
    'pgrep',
    'launchctl',
    'file',
    'plutil',
    'curl',
    'codesign',
    'hdiutil',
    'ditto',
    'mv',
    'open',
  ]) {
    await write(join(bin, command), driver);
    await chmod(join(bin, command), 0o755);
  }
  const script = join(directory, 'install.sh');
  await write(
    script,
    installer
      .replace('PATH=/usr/bin:/bin:/usr/sbin:/sbin', `PATH='${bin}':/usr/bin:/bin:/usr/sbin:/sbin`)
      .replace(destination, `applications='${dirname(target)}'`)
      .replace('82e4c9de30d80541d1c59c0d590537e4c0abf4a04cc34fde6217a0f9e47e1e2d', pin),
  );
  if (options.fresh) await rm(target, { recursive: true });
  if (options.symlink) {
    await rm(target, { recursive: true });
    await symlink(app, target);
  }
  return {
    target: installTarget,
    profile,
    updateJob,
    updateCache,
    app,
    launches: async () => JSON.parse(await readFile(launches, 'utf8')),
    run: () =>
      spawnSync('/bin/sh', [script], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: home,
          FIXTURE_ROOT: directory,
          FIXTURE_OPTIONS: JSON.stringify(options),
        },
      }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test('CLI-INSTALL: hosted script installs verified bytes and preserves the existing profile', async () => {
  const embedded = new Function(installNodes()[1].parameters.jsCode)()[0].json.body;
  assert.equal(embedded, installer);
  for (const options of [{}, { fresh: true }, { legacyInstall: true }, { legacyDisk: true }]) {
    const state = await fixture(options);
    try {
      const result = state.run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        JSON.parse(
          await readFile(join(state.target, 'Contents/Resources/app/package.json'), 'utf8'),
        ).nodBuild.source,
        source,
      );
      assert.equal(await readFile(state.profile, 'utf8'), 'keep synthetic keys and conversations');
      assert.deepEqual(await state.launches(), [{ args: [state.target], source }]);
      assert.deepEqual(await readdir(dirname(state.target)), [basename(state.target)]);
    } finally {
      await state.close();
    }
  }
});

test('CLI-INSTALL: a Nod app signed with an earlier certificate is replaced by the verified release', async () => {
  const state = await fixture({ earlierCertificate: true });
  try {
    const result = state.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(await readFile(join(state.target, 'Contents/Resources/app/package.json'), 'utf8'))
        .nodBuild.source,
      source,
    );
    assert.equal(await readFile(state.profile, 'utf8'), 'keep synthetic keys and conversations');
  } finally {
    await state.close();
  }
});

test('CLI-INSTALL: a stale update job is stopped before replacement and a missing app can be installed again', async () => {
  for (const fresh of [false, true]) {
    const state = await fixture({ staleUpdater: true, fresh });
    try {
      const result = state.run();
      assert.equal(result.status, 0, result.stderr);
      await assert.rejects(readFile(state.updateJob), { code: 'ENOENT' });
      await assert.rejects(readdir(state.updateCache), { code: 'ENOENT' });
      assert.equal(await readFile(state.profile, 'utf8'), 'keep synthetic keys and conversations');
      assert.deepEqual(await state.launches(), [{ args: [state.target], source }]);
      assert.deepEqual(await readdir(dirname(state.target)), [basename(state.target)]);
    } finally {
      await state.close();
    }
  }
});

test('CLI-INSTALL: rejected metadata, downloads, signatures and interrupted staging retain the old app and profile', async (t) => {
  for (const options of [
    { running: true },
    { staleUpdater: true, updaterStopFailure: true },
    { elevated: true },
    { wrongTarget: true },
    { hostileUrl: true },
    { wrongPin: true },
    { corruptDisk: true },
    { badSignature: true },
    { wrongSource: true },
    { copyFailure: true },
    { swapFailure: true },
    { targetChanged: true },
    { currentVersion: '0.10.0' },
    { currentVersion: '0.2.0', releaseVersion: '0.2.0-beta.2' },
    { currentVersion: '0.2.0-beta.10', releaseVersion: '0.2.0-beta.2' },
  ])
    await t.test(JSON.stringify(options), async () => {
      const state = await fixture(options);
      try {
        const result = state.run();
        assert.equal(result.status, 1, result.stdout);
        if (options.hostileUrl) assert.match(result.stderr, /download URL is invalid/);
        assert.equal(await readFile(join(state.target, 'previous'), 'utf8'), 'previous app');
        assert.equal(
          await readFile(state.profile, 'utf8'),
          'keep synthetic keys and conversations',
        );
        assert.deepEqual(await state.launches(), []);
        assert.deepEqual(await readdir(dirname(state.target)), [basename(state.target)]);
      } finally {
        await state.close();
      }
    });
});

test('CLI-INSTALL: launch failure keeps the previous Mac app, verified new app and profile', async () => {
  const state = await fixture({ launchFailure: true });
  try {
    const result = state.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /installed.*could not open/);
    assert.deepEqual(await state.launches(), [{ args: [state.target], source }]);
    assert.equal(await readFile(state.profile, 'utf8'), 'keep synthetic keys and conversations');
    const backup = (await readdir(dirname(state.target))).find((name) =>
      name.startsWith('.nod-install.'),
    );
    assert.ok(backup);
    assert.equal(
      await readFile(join(dirname(state.target), backup, 'Previous.app/previous'), 'utf8'),
      'previous app',
    );
    assert.match(result.stderr, /previous Nod app is preserved/);
  } finally {
    await state.close();
  }
});

test('CLI-INSTALL: a symbolic-link destination is rejected without touching its target', async () => {
  const state = await fixture({ symlink: true });
  try {
    const result = state.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /destination must not be a symbolic link/);
    assert.deepEqual(await state.launches(), []);
    assert.equal(
      await readFile(join(state.app, 'Contents/MacOS/nod'), 'utf8'),
      'synthetic executable',
    );
    assert.equal(await readFile(state.profile, 'utf8'), 'keep synthetic keys and conversations');
  } finally {
    await state.close();
  }
});

test('CLI-INSTALL: Intel metadata, installer and executable use the same architecture', async () => {
  const f = await fixture({ intel: true });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(f.profile, 'utf8'), 'keep synthetic keys and conversations');
    assert.deepEqual(await f.launches(), [{ args: [f.target], source }]);
    assert.equal(
      JSON.parse(await readFile(join(f.target, 'Contents/Info.plist'))).CFBundleShortVersionString,
      '0.2.0',
    );
  } finally {
    await f.close();
  }
  const rejected = await fixture({ intel: true, wrongArchitecture: true });
  try {
    const result = rejected.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /architecture does not match/);
    assert.equal(await readFile(join(rejected.target, 'previous'), 'utf8'), 'previous app');
    assert.equal(await readFile(rejected.profile, 'utf8'), 'keep synthetic keys and conversations');
  } finally {
    await rejected.close();
  }
});

const powershell = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
if (process.platform === 'win32' && !powershell) {
  throw new Error('PowerShell 7 is required to validate the Windows installer.');
}

async function windowsInstall(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nod-windows-install-'));
  const temporary = join(directory, 'tmp');
  const localAppData = join(directory, 'Local App Data');
  const target = join(localAppData, options.existing ? 'Custom Nod' : 'Programs/nod');
  await mkdir(temporary);
  const bytes = {
    installer: Buffer.from('synthetic Windows installer'),
    runtime: Buffer.from('synthetic Windows runtime pack'),
  };
  const url = (id, name) => `${base}/releases/42/assets/${id}/${name}`;
  const entry = (id, name, value) => ({
    url: url(id, name),
    bytes: value.length,
    sha256: sha256(value),
  });
  const latest = {
    schema: 1,
    version: '0.2.0',
    releaseId: 42,
    installer: entry(7, 'nod-Setup-x64.exe', bytes.installer),
    runtime: entry(8, 'nod-Runtime-win32-x64.tar.gz', bytes.runtime),
    manifestUrl: url(9, 'release-win32-x64.json'),
  };
  const manifest = {
    version: '0.2.0',
    platform: 'win32-x64',
    installer: {
      file: 'nod-Setup-x64.exe',
      bytes: bytes.installer.length,
      sha256: latest.installer.sha256,
    },
    runtime: {
      file: 'nod-Runtime-win32-x64.tar.gz',
      bytes: bytes.runtime.length,
      sha256: latest.runtime.sha256,
    },
    ...options.manifest,
  };
  const served = { installer: options.installer || bytes.installer, runtime: bytes.runtime };
  const log = join(directory, 'log');
  const fixture = join(directory, 'fixture.json');
  await writeFile(log, '');
  await writeFile(
    fixture,
    JSON.stringify({
      build: options.build || '26100',
      running: Boolean(options.running),
      elevated: Boolean(options.elevated),
      existing: Boolean(options.existing),
      missingApp: Boolean(options.missingApp),
      wrongVersion: Boolean(options.wrongVersion),
      wrongTarget: Boolean(options.wrongTarget),
      launchFailure: Boolean(options.launchFailure),
      target,
      exitCode: options.exitCode || 0,
      routes: { [`${base}/releases?installer=true&platform=win32-x64`]: latest },
      files: {
        [latest.installer.url]: served.installer.toString('base64'),
        [latest.runtime.url]: served.runtime.toString('base64'),
        [latest.manifestUrl]: Buffer.from(JSON.stringify(manifest)).toString('base64'),
      },
    }),
  );
  const mocks = String.raw`
$fixture = Get-Content -Raw $env:NOD_FIXTURE | ConvertFrom-Json
function Get-ItemProperty { param($Path, $ErrorAction)
  if ($Path -like 'HKLM:*') { [pscustomobject]@{ CurrentBuildNumber = $fixture.build } }
  elseif ($fixture.existing -or $script:installed) { [pscustomobject]@{ InstallDir = $(if ($script:installed -and $fixture.wrongTarget) { Join-Path $fixture.target 'other' } else { $fixture.target }) } } }
function Get-Process { param($Name, $ErrorAction) if ($fixture.running) { [pscustomobject]@{ Name = $Name } } }
function Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing) Add-Content $env:NOD_LOG "metadata $Uri"; $fixture.routes.$Uri }
function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing)
  Add-Content $env:NOD_LOG "download $Uri"
  $value = [Convert]::FromBase64String($fixture.files.$Uri)
  if ($OutFile) { [IO.File]::WriteAllBytes($OutFile, $value) } else { [pscustomobject]@{ RawContentStream = [IO.MemoryStream]::new($value) } } }
function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$Wait, [switch]$PassThru)
  if ((Split-Path -Leaf $FilePath) -eq 'nod.exe') {
    if (-not $script:installed -or $Wait -or $PassThru) { throw 'Invalid launch ordering or arguments' }
    if ([IO.Directory]::GetDirectories($env:TEMP).Count -ne 0) { throw 'Staged files remain at launch' }
    Add-Content $env:NOD_LOG "launch $FilePath working=$WorkingDirectory"
    if ($fixture.launchFailure) { throw 'Synthetic launch failure' }
    return
  }
  if (-not $Wait -or -not $PassThru) { throw 'Installer must finish before launch' }
  $runtime = Join-Path (Split-Path $FilePath) 'nod-Runtime-win32-x64.tar.gz'
  Add-Content $env:NOD_LOG "install $ArgumentList runtime=$([IO.File]::Exists($runtime))"
  if ($fixture.exitCode -eq 0) {
    $script:installed = $true
    $package = Join-Path $fixture.target 'resources/app'
    New-Item -ItemType Directory -Path $package -Force | Out-Null
    @{ name = 'nod-desktop'; version = $(if ($fixture.wrongVersion) { '0.1.0' } else { '0.2.0' }) } | ConvertTo-Json | Set-Content (Join-Path $package 'package.json')
    if (-not $fixture.missingApp) { Set-Content (Join-Path $fixture.target 'nod.exe') 'synthetic installed app' }
  }
  [pscustomobject]@{ ExitCode = $fixture.exitCode } }
`;
  const script = join(directory, 'install.ps1');
  const runner = join(directory, 'runner.ps1');
  const elevated =
    '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
  const source = new Function(installNodes()[4].parameters.jsCode)()[0].json.body;
  assert.equal(source.split(elevated).length, 2);
  await writeFile(script, source.replace(elevated, '$fixture.elevated'));
  await writeFile(runner, `${mocks}\nInvoke-Expression (Get-Content -Raw $env:NOD_SCRIPT)\n`);
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', runner], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NOD_FIXTURE: fixture,
      NOD_LOG: log,
      NOD_SCRIPT: script,
      LOCALAPPDATA: localAppData,
      TMPDIR: temporary,
      TEMP: temporary,
      NO_COLOR: '1',
    },
    timeout: 60_000,
  });
  const calls = (await readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  const staged = await readdir(temporary);
  await rm(directory, { recursive: true, force: true });
  return { result, calls, staged, target, output: result.stdout + result.stderr };
}

test(
  'CLI-INSTALL: the Windows script installs verified files silently and leaves nothing staged',
  { skip: !powershell && 'pwsh is unavailable' },
  async () => {
    for (const options of [{}, { existing: true }]) {
      const installed = await windowsInstall(options);
      assert.equal(installed.result.status, 0, installed.output);
      assert.deepEqual(
        installed.calls.filter((call) => call.startsWith('install')),
        [`install /S${options.existing ? ` /D=${installed.target}` : ''} runtime=True`],
      );
      assert.deepEqual(
        installed.calls.filter((call) => call.startsWith('launch')),
        [`launch ${join(installed.target, 'nod.exe')} working=${installed.target}`],
      );
      assert.deepEqual(installed.staged, []);
    }
  },
);

test(
  'CLI-INSTALL: the Windows script stops before installing on any mismatch or open app',
  { skip: !powershell && 'pwsh is unavailable' },
  async () => {
    for (const options of [
      { installer: Buffer.from('tampered Windows installer!') },
      { manifest: { version: '0.3.0' } },
      {
        manifest: {
          runtime: { file: 'nod-Runtime-win32-x64.tar.gz', bytes: 1, sha256: 'b'.repeat(64) },
        },
      },
      { running: true },
      { elevated: true },
      { build: '19045' },
    ]) {
      const rejected = await windowsInstall(options);
      assert(!rejected.calls.some((call) => /^(install|launch)/.test(call)));
      assert.deepEqual(rejected.staged, []);
    }
    const failed = await windowsInstall({ exitCode: 2 });
    assert.match(failed.output, /installer did not finish/);
    assert(!failed.calls.some((call) => call.startsWith('launch')));
    assert.deepEqual(failed.staged, []);
  },
);

test(
  'CLI-INSTALL: Windows refuses to launch incomplete or unexpected installed targets',
  { skip: !powershell && 'pwsh is unavailable' },
  async () => {
    for (const options of [{ missingApp: true }, { wrongVersion: true }, { wrongTarget: true }]) {
      const rejected = await windowsInstall(options);
      assert.match(rejected.output, /installed app|installation destination/);
      assert(!rejected.calls.some((call) => call.startsWith('launch')));
      assert.deepEqual(rejected.staged, []);
    }
    const failed = await windowsInstall({ launchFailure: true });
    assert.match(failed.output, /installed.*could not open/);
    assert.equal(failed.calls.filter((call) => call.startsWith('launch')).length, 1);
    assert.deepEqual(failed.staged, []);
  },
);

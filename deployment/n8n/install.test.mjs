import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const directory = await mkdtemp(join(tmpdir(), 'otto-install-fixture-'));
  const home = join(directory, 'home');
  const target = join(directory, 'Applications/Otto.app');
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
    CFBundleIdentifier: 'dev.otto.desktop',
    CFBundleShortVersionString: version,
    LSMinimumSystemVersion: '14.0',
  });
  await write(join(app, 'Contents/Resources/app/package.json'), {
    version,
    ottoBuild: {
      source: options.wrongSource ? 'b'.repeat(40) : source,
      modified: false,
      updateSourceUrl: base,
    },
  });
  await write(join(app, 'Contents/MacOS/Otto'), 'synthetic executable');
  await write(join(target, 'Contents/Info.plist'), {
    CFBundleIdentifier: options.wrongTarget ? 'unrelated.app' : 'dev.otto.desktop',
    CFBundleShortVersionString: options.currentVersion || '0.1.0',
  });
  await write(join(target, 'previous'), 'previous app');
  const profile = join(home, 'Library/Application Support/Otto/synthetic-profile');
  await write(profile, 'keep synthetic keys and conversations');
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
        ? 'https://attacker.invalid/Otto-arm64.dmg'
        : `${base}/releases/42/assets/103/Otto-${arch}.dmg`,
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
    disk: { file: `Otto-${arch}.dmg`, bytes: disk.length, sha256: sha256(disk) },
  });
  const driver = `#!${process.execPath}
import{readFileSync,writeFileSync,copyFileSync,cpSync,statSync,mkdirSync,renameSync}from'node:fs';
import{basename,join}from'node:path';
const command=basename(process.argv[1]),args=process.argv.slice(2),root=process.env.FIXTURE_ROOT,options=JSON.parse(process.env.FIXTURE_OPTIONS);
const stop=()=>process.exit(1),print=value=>process.stdout.write(String(value)+'\\n');
if(command==='uname')print(args[0]==='-s'?'Darwin':options.intel?'x86_64':'arm64');
else if(command==='sw_vers')print('14.7.1');
else if(command==='id')print('1000');
else if(command==='stat'){const info=statSync(args[2]);print(args[1]==='%d:%i'?info.dev+':'+info.ino:info.size)}
else if(command==='pgrep')process.exit(options.running?0:1);
else if(command==='file')print('Mach-O 64-bit executable '+(options.intel&&!options.wrongArchitecture?'x86_64':'arm64'));
else if(command==='plutil'){let value=JSON.parse(readFileSync(args.at(-1),'utf8'));for(const key of args[1].split('.'))value=value?.[key];const type=args[args.indexOf('-expect')+1];if((type==='string'&&typeof value!=='string')||(type==='bool'&&typeof value!=='boolean')||(type==='integer'&&!Number.isInteger(value)))stop();print(value)}
else if(command==='curl'){const url=args.at(-1);if(!url.startsWith(${JSON.stringify(base + '/')}))stop();const input=url===${JSON.stringify(base + '/releases?installer=true')}+(options.intel?'&platform=darwin-x64':'')?'latest.json':url.endsWith(options.intel?'release-darwin-x64.json':'release.json')?'release.json':'disk';copyFileSync(join(root,input),args[args.indexOf('--output')+1]);if(options.targetChanged&&input==='disk'){const path=join(root,'Applications/Otto.app/Contents/Info.plist');const info=JSON.parse(readFileSync(path,'utf8'));info.CFBundleShortVersionString='0.1.1';writeFileSync(path,JSON.stringify(info))}}
else if(command==='codesign'){if(options.badSignature&&args.at(-1).includes('mount/'))stop();const extract=args.find(value=>value.startsWith('--extract-certificates='));if(extract)copyFileSync(join(root,options.earlierCertificate&&args.at(-1).endsWith('/Applications/Otto.app')?'earlier-certificate':'certificate'),extract.split('=')[1]+'0')}
else if(command==='hdiutil'){if(args[0]==='attach')cpSync(join(root,'fixture.app'),join(args[args.indexOf('-mountpoint')+1],'Otto.app'),{recursive:true})}
else if(command==='ditto'){if(options.copyFailure){mkdirSync(args[1],{recursive:true});writeFileSync(join(args[1],'partial'),'partial copy');stop()}cpSync(args[0],args[1],{recursive:true})}
else if(command==='mv'){if(options.swapFailure&&args[0].endsWith('/Otto.app')&&args[0].includes('/.otto-install.'))stop();renameSync(args[0],args[1])}
else stop();
`;
  for (const command of [
    'uname',
    'sw_vers',
    'id',
    'stat',
    'pgrep',
    'file',
    'plutil',
    'curl',
    'codesign',
    'hdiutil',
    'ditto',
    'mv',
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
  if (options.symlink) {
    await rm(target, { recursive: true });
    await symlink(app, target);
  }
  return {
    target,
    profile,
    app,
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
  const state = await fixture();
  try {
    const result = state.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(await readFile(join(state.target, 'Contents/Resources/app/package.json'), 'utf8'))
        .ottoBuild.source,
      source,
    );
    assert.equal(await readFile(state.profile, 'utf8'), 'keep synthetic keys and conversations');
    assert.deepEqual(await readdir(dirname(state.target)), ['Otto.app']);
  } finally {
    await state.close();
  }
});

test('CLI-INSTALL: an Otto app signed with an earlier certificate is replaced by the verified release', async () => {
  const state = await fixture({ earlierCertificate: true });
  try {
    const result = state.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(await readFile(join(state.target, 'Contents/Resources/app/package.json'), 'utf8'))
        .ottoBuild.source,
      source,
    );
    assert.equal(await readFile(state.profile, 'utf8'), 'keep synthetic keys and conversations');
  } finally {
    await state.close();
  }
});

test('CLI-INSTALL: rejected metadata, downloads, signatures and interrupted staging retain the old app and profile', async (t) => {
  for (const options of [
    { running: true },
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
        assert.deepEqual(await readdir(dirname(state.target)), ['Otto.app']);
      } finally {
        await state.close();
      }
    });
});

test('CLI-INSTALL: a symbolic-link destination is rejected without touching its target', async () => {
  const state = await fixture({ symlink: true });
  try {
    const result = state.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /destination must not be a symbolic link/);
    assert.equal(
      await readFile(join(state.app, 'Contents/MacOS/Otto'), 'utf8'),
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

async function windowsInstall(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-windows-install-'));
  const temporary = join(directory, 'tmp');
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
    installer: entry(7, 'Otto-Setup-x64.exe', bytes.installer),
    runtime: entry(8, 'Otto-Runtime-win32-x64.tar.gz', bytes.runtime),
    manifestUrl: url(9, 'release-win32-x64.json'),
  };
  const manifest = {
    version: '0.2.0',
    platform: 'win32-x64',
    installer: {
      file: 'Otto-Setup-x64.exe',
      bytes: bytes.installer.length,
      sha256: latest.installer.sha256,
    },
    runtime: {
      file: 'Otto-Runtime-win32-x64.tar.gz',
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
$fixture = Get-Content -Raw $env:OTTO_FIXTURE | ConvertFrom-Json
function Get-ItemProperty { param($Path, $ErrorAction)
  if ($Path -like 'HKLM:*') { [pscustomobject]@{ CurrentBuildNumber = $fixture.build } } }
function Get-Process { param($Name, $ErrorAction) if ($fixture.running) { [pscustomobject]@{ Name = $Name } } }
function Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing) Add-Content $env:OTTO_LOG "metadata $Uri"; $fixture.routes.$Uri }
function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing)
  Add-Content $env:OTTO_LOG "download $Uri"
  $value = [Convert]::FromBase64String($fixture.files.$Uri)
  if ($OutFile) { [IO.File]::WriteAllBytes($OutFile, $value) } else { [pscustomobject]@{ RawContentStream = [IO.MemoryStream]::new($value) } } }
function Start-Process { param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru)
  $runtime = Join-Path (Split-Path $FilePath) 'Otto-Runtime-win32-x64.tar.gz'
  Add-Content $env:OTTO_LOG "install $ArgumentList runtime=$([IO.File]::Exists($runtime))"
  [pscustomobject]@{ ExitCode = $fixture.exitCode } }
`;
  const script = join(directory, 'install.ps1');
  const runner = join(directory, 'runner.ps1');
  await writeFile(script, new Function(installNodes()[4].parameters.jsCode)()[0].json.body);
  await writeFile(runner, `${mocks}\nInvoke-Expression (Get-Content -Raw $env:OTTO_SCRIPT)\n`);
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', runner], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OTTO_FIXTURE: fixture,
      OTTO_LOG: log,
      OTTO_SCRIPT: script,
      TMPDIR: temporary,
      TEMP: temporary,
      NO_COLOR: '1',
    },
    timeout: 60_000,
  });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
  const staged = await readdir(temporary);
  await rm(directory, { recursive: true, force: true });
  return { result, calls, staged, output: result.stdout + result.stderr };
}

test(
  'CLI-INSTALL: the Windows script installs verified files silently and leaves nothing staged',
  { skip: !powershell && 'pwsh is unavailable' },
  async () => {
    const installed = await windowsInstall();
    assert.deepEqual(
      installed.calls.filter((call) => call.startsWith('install')),
      ['install /S runtime=True'],
    );
    assert.deepEqual(installed.staged, []);
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
          runtime: { file: 'Otto-Runtime-win32-x64.tar.gz', bytes: 1, sha256: 'b'.repeat(64) },
        },
      },
      { running: true },
      { build: '19045' },
    ]) {
      const rejected = await windowsInstall(options);
      assert(!rejected.calls.some((call) => call.startsWith('install')));
      assert.deepEqual(rejected.staged, []);
    }
    const failed = await windowsInstall({ exitCode: 2 });
    assert.match(failed.output, /installer did not finish/);
    assert.deepEqual(failed.staged, []);
  },
);

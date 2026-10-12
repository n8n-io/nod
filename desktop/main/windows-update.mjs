import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const files = ['Otto-Setup-x64.exe', 'Otto-Runtime-win32-x64.tar.gz'];

async function sha256(path, signal) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
  return hash.digest('hex');
}

async function download(entry, path, signal, request) {
  let url = entry.url;
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.username || address.password)
      throw new Error('Otto received an unsafe update download address.');
    response = await request(url, {
      signal,
      redirect: 'manual',
      headers: { accept: 'application/octet-stream' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    url = new URL(response.headers.get('location') || '', url).href;
    await response.body?.cancel();
  }
  if (!response?.ok || !response.body)
    throw new Error('The Otto update download is unavailable. Try again.');
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > entry.bytes ? new Error('The Otto update download is larger than expected.') : null,
        chunk,
      );
    },
  });
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path, { flags: 'wx' }), {
    signal,
  });
}

export async function stageWindowsUpdate(
  candidate,
  { directory, resourcesPath, signal, fetch: request = fetch },
) {
  if (
    !/^\d+\.\d+\.\d+$/.test(candidate?.version) ||
    candidate.installer?.file !== files[0] ||
    candidate.runtime?.file !== files[1]
  )
    throw new Error('The Otto update is invalid.');
  const target = join(directory, candidate.version);
  await rm(directory, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  try {
    const installed = join(resourcesPath, 'windows-runtime');
    const manifest = JSON.parse(
      await readFile(join(installed, 'manifest.json'), 'utf8').catch(() => '{}'),
    );
    for (const entry of [candidate.runtime, candidate.installer]) {
      const path = join(target, entry.file);
      if (entry === candidate.runtime && manifest.guest?.sha256 === entry.sha256)
        await copyFile(join(installed, 'guest.tar.gz'), path);
      else await download(entry, path, signal, request);
      if ((await stat(path)).size !== entry.bytes || (await sha256(path, signal)) !== entry.sha256)
        throw new Error('The Otto update failed its integrity check. Try again.');
    }
    return target;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function windowsInstallCommand({ directory, appPath, pid, systemRoot = 'C:\\Windows' }) {
  const script = [
    'Wait-Process -Id ([int]$env:OTTO_UPDATE_PID) -Timeout 300 -ErrorAction SilentlyContinue',
    `Start-Process -FilePath (Join-Path $env:OTTO_UPDATE_DIRECTORY '${files[0]}') -ArgumentList ('/S /D=' + $env:OTTO_UPDATE_TARGET) -Wait`,
    "Start-Process -FilePath (Join-Path $env:OTTO_UPDATE_TARGET 'Otto.exe')",
  ].join('\n');
  return {
    command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    env: {
      OTTO_UPDATE_PID: String(pid),
      OTTO_UPDATE_DIRECTORY: directory,
      OTTO_UPDATE_TARGET: win32.dirname(appPath),
    },
  };
}

import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetHash } from '../runtime/assets.mjs';
import { run } from './release-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const client = {
  version: '1.0.146',
  sha256: '7761e5d8f31e54b764da21d33cd8b0a2940e1b05526c7dfcb5e94b0431426f70',
};
const account = {
  Endpoint: 'https://weu.codesigning.azure.net/',
  CodeSigningAccountName: 'n8n-nod',
  CertificateProfileName: 'nod-windows',
  ExcludeCredentials: [
    'ManagedIdentityCredential',
    'SharedTokenCacheCredential',
    'VisualStudioCredential',
    'VisualStudioCodeCredential',
    'AzureCliCredential',
    'AzurePowerShellCredential',
    'AzureDeveloperCliCredential',
    'InteractiveBrowserCredential',
  ],
};
const identity = {
  AZURE_TENANT_ID: 'f74a16de-d751-4c66-8e3a-3e698912c508',
  AZURE_CLIENT_ID: '130a3a1e-e185-4235-9999-a4dd7177de8b',
};

export async function windowsCodeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !['.exe', '.dll', '.node'].includes(extname(entry.name).toLowerCase()))
      continue;
    const path = join(entry.parentPath, entry.name);
    const handle = await open(path);
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0);
      if (bytesRead === 2 && buffer.toString('latin1') === 'MZ') files.push(path);
    } finally {
      await handle.close();
    }
  }
  return files.sort();
}

async function signingTools() {
  const tools = join(root, '.local/artifact-signing', client.version);
  const dlib = join(tools, 'bin/x64/Azure.CodeSigning.Dlib.dll');
  if (!(await stat(dlib).catch(() => null))) {
    await mkdir(tools, { recursive: true });
    const archive = join(tools, 'client.nupkg');
    const response = await fetch(
      `https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/${client.version}/microsoft.artifactsigning.client.${client.version}.nupkg`,
    );
    if (!response.ok)
      throw new Error(`The Artifact Signing client download failed (${response.status}).`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    if ((await assetHash(archive)) !== client.sha256)
      throw new Error('The Artifact Signing client failed its integrity check.');
    await run(join(process.env.SYSTEMROOT, 'System32/tar.exe'), ['-xf', archive, '-C', tools]);
  }
  const kits = join(process.env['ProgramFiles(x86)'], 'Windows Kits/10/bin');
  const version = (await readdir(kits))
    .filter((name) => /^10\.0\.\d+\.\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .at(-1);
  if (!version) throw new Error('Windows signing needs the Windows SDK signing tool.');
  return { signtool: join(kits, version, 'x64/signtool.exe'), dlib };
}

async function federatedToken(path) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token)
    throw new Error('Windows signing needs the release job sign-in token (id-token: write).');
  const response = await fetch(
    `${url}&audience=${encodeURIComponent('api://AzureADTokenExchange')}`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok)
    throw new Error(`GitHub refused the signing sign-in token (${response.status}).`);
  await writeFile(path, (await response.json()).value, { mode: 0o600 });
}

export async function signWindowsFiles(files) {
  if (!files.length) throw new Error('Windows signing needs at least one file.');
  const { signtool, dlib } = await signingTools();
  const work = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'nod-signing-'));
  try {
    const metadata = join(work, 'metadata.json');
    const token = join(work, 'federated-token');
    await writeFile(metadata, JSON.stringify(account));
    for (let index = 0; index < files.length; index += 40) {
      await federatedToken(token);
      await run(
        signtool,
        [
          'sign',
          '/fd',
          'SHA256',
          '/tr',
          'http://timestamp.acs.microsoft.com',
          '/td',
          'SHA256',
          '/dlib',
          dlib,
          '/dmdf',
          metadata,
          ...files.slice(index, index + 40),
        ],
        {
          env: { ...process.env, ...identity, AZURE_FEDERATED_TOKEN_FILE: token },
          timeout: 1_200_000,
        },
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(`Signed ${files.length} Windows files.`);
}

if (import.meta.main) await signWindowsFiles(process.argv.slice(2));

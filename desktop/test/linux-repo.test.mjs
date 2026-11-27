import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishLinuxRepo } from '../scripts/linux-repo.mjs';
import { packageLinuxBundle } from '../scripts/linux-release.mjs';

function fakeRun(revParseStdout) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('rev-parse')) return { stdout: `${revParseStdout}\n` };
    return { stdout: '' };
  };
  return { run, calls };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nod-linux-repo-src-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'synthetic.flatpak');
  await writeFile(bundle, Buffer.from('Synthetic Flatpak bundle.'));
  const repo = join(root, 'repo');
  const version = '0.9.0';
  const source = 'a'.repeat(40);
  const commit = 'c'.repeat(64);
  await packageLinuxBundle({ root, bundle, version, source, commit });
  return { root, bundle, repo, version, source, commit };
}

test('publishLinuxRepo imports into a staging repo, validates the commit, then signs and updates the real repo', async (t) => {
  const { root, repo, version, source, commit } = await fixture(t);
  const { run, calls } = fakeRun(commit);
  await publishLinuxRepo({ root, repo, key: 'TESTKEY', version, source, run });
  const importCall = calls.find((call) => call.includes('build-import-bundle'));
  const pullCall = calls.find((call) => call.includes('pull-local'));
  const signCall = calls.find((call) => call.includes('build-sign'));
  const updateCall = calls.find((call) => call.includes('build-update-repo'));
  assert.ok(importCall);
  assert.ok(importCall[3].endsWith('nod-linux-x64.flatpak'));
  assert.ok(!importCall.includes(repo));
  assert.ok(
    pullCall && pullCall.some((arg) => arg.includes(repo)) && pullCall.includes('pull-local'),
  );
  assert.ok(
    signCall &&
      signCall.includes(repo) &&
      signCall.includes('io.n8n.Nod') &&
      signCall.includes('stable') &&
      signCall.includes('--gpg-sign=TESTKEY'),
  );
  assert.ok(
    updateCall &&
      updateCall.includes(repo) &&
      updateCall.includes('--generate-static-deltas') &&
      updateCall.includes('--prune') &&
      updateCall.includes('--gpg-sign=TESTKEY'),
  );
  assert.ok(calls.indexOf(pullCall) > calls.indexOf(importCall));
  assert.ok(calls.indexOf(signCall) > calls.indexOf(pullCall));
  assert.ok(calls.indexOf(updateCall) > calls.indexOf(signCall));
  const staging = importCall[2];
  await assert.rejects(access(staging));
});

test('publishLinuxRepo rejects a mismatched commit without touching the real repo', async (t) => {
  const { root, repo, version, source } = await fixture(t);
  const { run, calls } = fakeRun('d'.repeat(64));
  await assert.rejects(
    publishLinuxRepo({ root, repo, key: 'TESTKEY', version, source, run }),
    /does not hold the commit in the release manifest/,
  );
  assert.ok(
    calls.some(
      (call) => call.includes('build-import-bundle') && call[3].endsWith('nod-linux-x64.flatpak'),
    ),
  );
  assert.ok(!calls.some((call) => call.includes('pull-local')));
  assert.ok(!calls.some((call) => call.includes('build-sign')));
  assert.ok(!calls.some((call) => call.includes('build-update-repo')));
  const staging = calls.find((call) => call.includes('build-import-bundle'))[2];
  await assert.rejects(access(staging));
});

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarize } from './aggregate.ts';
import { loadReviews } from './review.ts';
import type { AttemptResult, RunManifest, RunSummary } from './results.ts';
import { repository } from './stack.ts';

export const resultsRoot = (override?: string) =>
  override ?? join(repository, '.local', 'capability-evals');

export async function readAttempts(directory: string) {
  const names = await readdir(join(directory, 'attempts')).catch(() => [] as string[]);
  return (
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(
          async (name) =>
            JSON.parse(await readFile(join(directory, 'attempts', name), 'utf8')) as AttemptResult,
        ),
    )
  ).sort((a, b) => a.scenario.localeCompare(b.scenario) || a.attempt - b.attempt);
}

export async function loadRun(root: string, label: string) {
  const directory = join(root, label);
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8').catch(() => {
      throw new Error(`No saved run called ${label}. Use "runs" to list them.`);
    }),
  ) as RunManifest;
  const attempts = await readAttempts(directory);
  return {
    directory,
    manifest,
    attempts,
    summary: summarize(manifest, attempts),
    reviews: await loadReviews(directory),
  };
}

export async function saveRun(
  directory: string,
  manifest: RunManifest,
  attempts: AttemptResult[],
  summary?: RunSummary,
) {
  await mkdir(join(directory, 'attempts'), { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const item of attempts)
    await writeFile(
      join(directory, 'attempts', `${item.scenario}.${item.attempt}.json`),
      JSON.stringify(item, null, 2),
    );
  if (summary) await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
}

export async function pruneAttempts(directory: string, keep: string[]) {
  const wanted = new Set(keep.map((name) => `${name}.json`));
  for (const name of await readdir(join(directory, 'attempts')).catch(() => [] as string[]))
    if (name.endsWith('.json') && !wanted.has(name))
      await rm(join(directory, 'attempts', name), { force: true });
}

export async function listRuns(root: string) {
  const labels = await readdir(root).catch(() => [] as string[]);
  const runs: Array<{ label: string; manifest: RunManifest; summary: RunSummary }> = [];
  for (const label of labels) {
    try {
      const { manifest, summary } = await loadRun(root, label);
      runs.push({ label, manifest, summary });
    } catch {}
  }
  return runs.sort((a, b) => b.manifest.startedAt.localeCompare(a.manifest.startedAt));
}

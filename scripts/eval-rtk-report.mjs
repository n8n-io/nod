import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const directory = resolve(process.argv[2] ?? 'docs/testing/rtk-eval');
const before = JSON.parse(await readFile(`${directory}/baseline/report.json`, 'utf8'));
const after = JSON.parse(await readFile(`${directory}/candidate/report.json`, 'utf8'));
assert.equal(before.manifestSha256, after.manifestSha256);
assert.deepEqual(before.fixtureHashes, after.fixtureHashes);
assert.ok(after.attempts.every((attempt) => attempt.result === 'pass'));
const first = after.attempts.filter((attempt) => attempt.repetition === 1);
const compact = first.filter((attempt) => attempt.checks['C4-compact'] !== null);
const rows = compact.map((attempt) => {
  const baseline = before.attempts.find(
    (other) => other.case === attempt.case && other.repetition === 1,
  );
  assert.equal(baseline.raw.sha256, attempt.raw.sha256);
  return {
    id: attempt.case,
    command: attempt.command,
    baselineCharacters: baseline.pi.characters,
    candidateCharacters: attempt.pi.characters,
    baselineEstimatedTokens: baseline.pi.estimatedTokens,
    candidateEstimatedTokens: attempt.pi.estimatedTokens,
    savedCharactersPercent: 100 * (1 - attempt.pi.characters / baseline.pi.characters),
  };
});
const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
const baselineCharacters = sum('baselineCharacters');
const candidateCharacters = sum('candidateCharacters');
const baselineEstimatedTokens = sum('baselineEstimatedTokens');
const candidateEstimatedTokens = sum('candidateEstimatedTokens');
const estimatedTokensSavedPerCall =
  (baselineEstimatedTokens - candidateEstimatedTokens) / rows.length;
const rates = [1, 3, 10];
const projections = [1000, 10000, 100000].map((calls) => ({
  comparableCommandCalls: calls,
  estimatedInputTokensSaved: estimatedTokensSavedPerCall * calls,
  costSavedEur: Object.fromEntries(
    rates.map((rate) => [
      `${rate}EURPerMillionInputTokens`,
      (estimatedTokensSavedPerCall * calls * rate) / 1000000,
    ]),
  ),
}));
const summary = {
  evidence:
    'Generated from controlled actual Pi bash tool outputs on synthetic repositories in disposable Linux containers; no model, UI or live account run.',
  metric:
    'Characters are measured. Token counts are estimates using ceil(characters / 4), not a model tokenizer.',
  baseline: { commit: before.commit, sourceSha256: before.sourceSha256, imageId: before.imageId },
  candidate: { commit: after.commit, sourceSha256: after.sourceSha256, imageId: after.imageId },
  checks: {
    baselinePassed: before.attempts.filter((attempt) => attempt.result === 'pass').length,
    candidatePassed: after.attempts.filter((attempt) => attempt.result === 'pass').length,
    candidateTotal: after.attempts.length,
  },
  rows,
  totals: {
    baselineCharacters,
    candidateCharacters,
    baselineEstimatedTokens,
    candidateEstimatedTokens,
    savedCharactersPercent: 100 * (1 - candidateCharacters / baselineCharacters),
    estimatedTokensSavedPerCall,
  },
  assumptions: [
    'Usage has the same mix as this fixture: 50% git status, 25% git diff, 25% git log -5.',
    'Each saved tool-output token is sent once as uncached model input.',
    'EUR 1, 3 and 10 per million input tokens are illustrative rates, not current provider prices.',
    'Model output, unchanged instructions, other tools, cache discounts and repeated conversation-history ingestion are excluded.',
    'Added bash-tool description tokens, rewrite latency, runtime cost and image-build cost are excluded; this is not a net-bill measurement.',
    'This estimates the affected tool-output component, not a percentage reduction in total agent bills.',
  ],
  projections,
};
await writeFile(`${directory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);

const width = 1440;
const height = 1110;
const canvas = createCanvas(width, height);
const ctx = canvas.getContext('2d');
const ink = '#17252b';
const muted = '#52646c';
const teal = '#006f66';
const grey = '#a2adb3';
ctx.fillStyle = '#f6f8f7';
ctx.fillRect(0, 0, width, height);
const text = (value, x, y, size = 24, color = ink, weight = 400) => {
  ctx.font = `${weight} ${size}px sans-serif`;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
};
text('RTK reduces the command output sent to the model', 64, 78, 39, ink, 700);
text(
  'LAB-585  |  RTK 0.51.0  |  Actual Pi bash tool + disposable Linux workspace',
  64,
  124,
  23,
  muted,
);
text(
  `${summary.totals.savedCharactersPercent.toFixed(1)}% fewer characters`,
  64,
  213,
  52,
  teal,
  700,
);
text(
  `${baselineCharacters.toLocaleString('en')} → ${candidateCharacters.toLocaleString('en')} across four ordinary Git commands`,
  64,
  256,
  26,
  muted,
);
text(
  `${summary.checks.candidatePassed}/${summary.checks.candidateTotal} case runs passed; three repeats per case`,
  790,
  214,
  27,
  ink,
  600,
);
text('Filenames, changed values, commit subjects retained.', 790, 253, 23, muted);
text('CSV, machine status and patch bytes preserved.', 790, 286, 23, muted);
ctx.fillStyle = grey;
ctx.fillRect(64, 318, 20, 20);
text('Before', 97, 336, 23, muted);
ctx.fillStyle = teal;
ctx.fillRect(240, 318, 20, 20);
text('With RTK', 273, 336, 23, muted);
text('Measured characters in visible tool output', 790, 336, 23, muted);
const max = Math.max(...rows.map((row) => row.baselineCharacters));
for (let index = 0; index < rows.length; index++) {
  const row = rows[index];
  const y = 396 + index * 98;
  text(row.command, 64, y + 16, 26, ink, 600);
  text(row.id.startsWith('RTK-H') ? 'Holdout' : 'Base case', 64, y + 48, 20, muted);
  ctx.fillStyle = grey;
  ctx.fillRect(390, y - 11, (row.baselineCharacters / max) * 650, 22);
  ctx.fillStyle = teal;
  ctx.fillRect(390, y + 23, (row.candidateCharacters / max) * 650, 22);
  text(String(row.baselineCharacters), 1066, y + 9, 23, muted);
  text(String(row.candidateCharacters), 1066, y + 44, 23, teal, 600);
  text(`-${row.savedCharactersPercent.toFixed(1)}%`, 1210, y + 30, 29, teal, 700);
}
ctx.fillStyle = '#d7e0de';
ctx.fillRect(64, 802, 1312, 2);
text('Illustrative usage: 10,000 comparable command calls', 64, 851, 29, ink, 600);
const projection = projections[1];
text(
  `~${Math.round(projection.estimatedInputTokensSaved).toLocaleString('en')} input tokens avoided`,
  64,
  899,
  30,
  teal,
  700,
);
text(
  `EUR ${projection.costSavedEur['3EURPerMillionInputTokens'].toFixed(2)} at EUR 3/M input tokens`,
  710,
  899,
  28,
  ink,
  600,
);
text(
  `Estimated tokens: ${baselineEstimatedTokens} → ${candidateEstimatedTokens} per four-command sample (characters ÷ 4, rounded up).`,
  64,
  955,
  23,
  muted,
);
text(
  'Assumes the same command mix and each tool result is ingested once. EUR rate is illustrative.',
  64,
  995,
  22,
  muted,
);
text(
  'Synthetic tool-path evidence; no model bill or product UI measurement. Total agent savings vary.',
  64,
  1034,
  22,
  muted,
);
text(
  `Measured ${after.startedAt.slice(0, 10)}  ·  Native workspace: ${after.architecture}  ·  Full outputs and checks retained in report.json`,
  64,
  1073,
  20,
  muted,
);
await writeFile(`${directory}/savings.png`, canvas.toBuffer('image/png'));
process.stdout.write(`${JSON.stringify(summary.totals, null, 2)}\n`);

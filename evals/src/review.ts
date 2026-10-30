import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { AttemptResult, Review, Reviews } from './results.ts';

export const reviewKey = (attempt: Pick<AttemptResult, 'scenario' | 'attempt'>) =>
  `${attempt.scenario}.${attempt.attempt}`;

export async function loadReviews(directory: string): Promise<Reviews> {
  const saved = await readFile(join(directory, 'reviews.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '{}';
      throw error;
    },
  );
  return JSON.parse(saved);
}

async function saveReviews(directory: string, reviews: Reviews) {
  await mkdir(dirname(join(directory, 'reviews.json')), { recursive: true });
  await writeFile(join(directory, 'reviews.json'), JSON.stringify(reviews, null, 2));
}

function kappa(both: number, onlyAuto: number, onlyHuman: number, neither: number) {
  const total = both + onlyAuto + onlyHuman + neither;
  if (!total) return null;
  const observed = (both + neither) / total;
  const auto = (both + onlyAuto) / total;
  const human = (both + onlyHuman) / total;
  const expected = auto * human + (1 - auto) * (1 - human);
  return expected === 1 ? 1 : (observed - expected) / (1 - expected);
}

export function agreement(attempts: AttemptResult[], reviews: Reviews) {
  let both = 0;
  let onlyAuto = 0;
  let onlyHuman = 0;
  let neither = 0;
  const disagreements: string[] = [];
  for (const attempt of attempts) {
    const review = reviews[reviewKey(attempt)];
    if (!review || attempt.status === 'incomplete') continue;
    const auto = attempt.status === 'pass';
    const human = review.verdict === 'trust';
    if (auto && human) both++;
    else if (auto) onlyAuto++;
    else if (human) onlyHuman++;
    else neither++;
    if (auto !== human)
      disagreements.push(
        `${reviewKey(attempt)} (automatic ${auto ? 'pass' : 'fail'}, you ${human ? 'trust' : 'distrust'}${review.note ? `: ${review.note}` : ''})`,
      );
  }
  const reviewed = both + onlyAuto + onlyHuman + neither;
  return {
    reviewed,
    agree: both + neither,
    kappa: kappa(both, onlyAuto, onlyHuman, neither),
    disagreements,
  };
}

export async function reviewRun(options: {
  directory: string;
  attempts: AttemptResult[];
  sample: number;
  reviewer: string;
}) {
  const reviews = await loadReviews(options.directory);
  const completed = options.attempts.filter(
    (item) => item.status !== 'incomplete' && !reviews[reviewKey(item)],
  );
  const failures = completed.filter((item) => item.status === 'fail');
  const passes = completed
    .filter((item) => item.status === 'pass')
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.ceil(completed.length * options.sample));
  const queue = [...failures, ...passes];
  if (!queue.length) {
    console.log('Nothing left to review.');
    return reviews;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    `\n${queue.length} attempts to review (${failures.length} failures first, then a sample of passes). Answer from the user's point of view.\n`,
  );
  for (const [index, item] of queue.entries()) {
    console.log(
      `\n${'='.repeat(78)}\n[${index + 1}/${queue.length}] ${item.scenario} #${item.attempt}   automatic: ${item.status.toUpperCase()}   ${Math.round(item.seconds)}s   ${item.toolCalls} tool calls`,
    );
    console.log(`\nTask:\n${item.task.slice(0, 900)}`);
    console.log(`\nWhat Nod finally told the user:\n${item.final.slice(0, 1800) || '(nothing)'}`);
    console.log('\nChecks:');
    for (const check of item.checks.filter((c) => !c.na))
      console.log(
        `  ${check.pass ? 'pass' : 'FAIL'}  ${check.id}${check.group === 'product' ? ' (product)' : ''}${check.evidence && !check.pass ? `\n        ${check.evidence.slice(0, 240)}` : ''}`,
      );
    const answer = (
      await prompt.question(
        '\nWould you trust Nod with this task after seeing this? [y]es / [n]o / [s]kip / [q]uit: ',
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'q') break;
    if (answer !== 'y' && answer !== 'n') continue;
    const wrong = (
      await prompt.question(
        'Which automatic checks were wrong? (ids, comma separated, enter for none): ',
      )
    )
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const note = (await prompt.question('Note (optional): ')).trim();
    const review: Review = {
      verdict: answer === 'y' ? 'trust' : 'distrust',
      wrongChecks: wrong,
      note,
      reviewer: options.reviewer,
      at: new Date().toISOString(),
    };
    reviews[reviewKey(item)] = review;
    await saveReviews(options.directory, reviews);
  }
  prompt.close();
  return reviews;
}

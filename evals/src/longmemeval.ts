import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  judgePrompt,
  setupNames,
  stratified,
  type LongMemEvalItem,
  type QuestionRun,
  type SetupName,
  type SetupRun,
  type Verdict,
} from './longmemeval-data.ts';
import { prepare } from './run.ts';
import { appSource, parseModel, repository, type Model } from './stack.ts';

interface LongMemEvalOptions {
  data: string;
  root: string;
  label: string;
  model: string;
  judge: string;
  setups: SetupName[];
  sample?: number;
  chatSample?: number;
  questions?: string[];
  concurrency: number;
  budget?: number;
  resume: boolean;
}

const judgePrice = { input: 2.5, output: 10 };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function judge(item: LongMemEvalItem, reply: string, model: Model): Promise<Verdict> {
  const prompt = judgePrompt(
    item.question_type,
    item.question,
    String(item.answer),
    reply,
    item.question_id.includes('_abs'),
  );
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${model.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.name,
        messages: [{ role: 'user', content: prompt }],
        n: 1,
        temperature: 0,
        max_tokens: 10,
      }),
    });
    if (response.ok) {
      const body = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage: { prompt_tokens: number; completion_tokens: number };
      };
      const raw = body.choices[0].message.content.trim();
      return {
        correct: raw.toLowerCase().includes('yes'),
        raw,
        costUsd:
          (body.usage.prompt_tokens * judgePrice.input +
            body.usage.completion_tokens * judgePrice.output) /
          1e6,
      };
    }
    if (attempt >= 6 || ![408, 429, 500, 502, 503, 504].includes(response.status))
      throw new Error(
        `The judge failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
      );
    await sleep(2 ** attempt * 1000);
  }
}

async function attempt(
  directory: string,
  item: LongMemEvalItem,
  setups: SetupName[],
  model: string,
) {
  const outFile = join(directory, 'raw', `${item.question_id}.json`);
  const specPath = join(tmpdir(), `nod-longmemeval-${randomUUID()}.json`);
  await writeFile(specPath, JSON.stringify({ item, setups, model, outFile }));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(repository, 'evals/src/longmemeval-attempt.ts'), specPath],
    { cwd: repository, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let captured = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => (captured = (captured + chunk).slice(-20_000)));
  let grace: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    grace = setTimeout(() => child.kill('SIGKILL'), 120_000);
  }, 50 * 60_000);
  await new Promise((done) => child.on('close', done));
  clearTimeout(timer);
  clearTimeout(grace);
  await writeFile(join(directory, 'logs', `${item.question_id}.log`), captured);
  return readFile(outFile, 'utf8')
    .then((text) => JSON.parse(text) as QuestionRun)
    .catch((): QuestionRun => ({
      questionId: item.question_id,
      type: item.question_type,
      abstention: item.question_id.endsWith('_abs'),
      setups,
      runs: [],
      seconds: 0,
      error: `The attempt process ended without a result. ${captured.slice(-400)}`,
    }));
}

const scored = (run: SetupRun | undefined): run is SetupRun & { verdict: Verdict } =>
  !!run?.verdict && !(run.error && !run.reply);

const cost = (result: QuestionRun) =>
  (result.learning?.costUsd ?? 0) +
  result.runs.reduce((sum, run) => sum + run.costUsd + (run.verdict?.costUsd ?? 0), 0);

const unpricedCount = (result: QuestionRun) =>
  (result.previousUnpricedCalls ?? 0) +
  (result.learning
    ? (result.learning.unpricedCalls ?? (result.learning.modelCalls > 0 ? 1 : 0))
    : 0) +
  result.runs.reduce((sum, run) => sum + (run.unpricedCalls ?? (run.modelCalls > 0 ? 1 : 0)), 0);
const unpriced = (result: QuestionRun) => unpricedCount(result) > 0;
const totalCost = (result: QuestionRun) => cost(result) + (result.previousCostUsd ?? 0);
const setupCosts = (result: QuestionRun) => {
  const costs = { ...(result.previousSetupCostsUsd ?? {}) };
  for (const run of result.runs) costs[run.setup] = (costs[run.setup] ?? 0) + run.costUsd;
  return costs;
};
const learningCost = (result: QuestionRun) =>
  (result.learning?.costUsd ?? 0) + (result.previousLearningCostUsd ?? 0);

const percent = (part: number, whole: number) =>
  whole ? Math.round((1000 * part) / whole) / 10 : null;

function summarizeLongMemEval(results: QuestionRun[], setups: SetupName[]) {
  const types = [...new Set(results.map((result) => result.type))].sort();
  const bySetup = Object.fromEntries(
    setups.map((setup) => {
      const runs = results.flatMap((result) => {
        const run = result.runs.find((item) => item.setup === setup);
        return scored(run) ? [{ result, run }] : [];
      });
      const attempted = results.filter((result) =>
        (result.setups ?? setups).includes(setup),
      ).length;
      const accuracy = (items: typeof runs) => ({
        n: items.length,
        correct: items.filter(({ run }) => run.verdict.correct).length,
        percent: percent(items.filter(({ run }) => run.verdict.correct).length, items.length),
      });
      const perType = Object.fromEntries(
        types.map((type) => [type, accuracy(runs.filter(({ result }) => result.type === type))]),
      );
      const typeScores = Object.values(perType).flatMap((item) =>
        item.percent === null ? [] : [item.percent],
      );
      return [
        setup,
        {
          overall: accuracy(runs),
          taskAveraged: typeScores.length
            ? Math.round((10 * typeScores.reduce((a, b) => a + b, 0)) / typeScores.length) / 10
            : null,
          perType,
          abstention: accuracy(runs.filter(({ result }) => result.abstention)),
          evidenceOutsideRecent: accuracy(runs.filter(({ result }) => !result.evidenceInRecent)),
          incomplete: attempted - runs.length,
          compacted: runs.filter(({ run }) => run.compactions > 0).length,
          costUsd: results.reduce((sum, result) => sum + (setupCosts(result)[setup] ?? 0), 0),
          meanTools: runs.length
            ? Math.round(
                (10 * runs.reduce((sum, { run }) => sum + run.tools.length, 0)) / runs.length,
              ) / 10
            : null,
          searched: runs.filter(({ run }) =>
            run.tools.some((tool) => /history_search|memory_find|memory_read/.test(tool.input)),
          ).length,
        },
      ];
    }),
  );
  const learned = results.flatMap((result) => (result.learning ? [result.learning] : []));
  const mean = (pick: (item: (typeof learned)[number]) => number) =>
    learned.length
      ? Math.round((10 * learned.reduce((sum, item) => sum + pick(item), 0)) / learned.length) / 10
      : null;
  return {
    questions: results.length,
    unpriced: results.some(unpriced),
    setups: bySetup,
    learning: {
      costUsd:
        learned.reduce((sum, item) => sum + item.costUsd, 0) +
        results.reduce((sum, result) => sum + (result.previousLearningCostUsd ?? 0), 0),
      meanNotes: mean((item) => item.notes),
      meanConfirmed: mean((item) => item.confirmed),
      meanLearned: mean((item) => item.learned),
      meanTentative: mean((item) => item.tentative),
    },
    totalCostUsd: results.some(unpriced)
      ? null
      : results.reduce((sum, result) => sum + totalCost(result), 0),
    knownCostUsd: results.reduce((sum, result) => sum + totalCost(result), 0),
  };
}

function markdown(
  summary: ReturnType<typeof summarizeLongMemEval>,
  manifest: Record<string, unknown>,
) {
  const lines = [
    `# LongMemEval-S on Nod: ${manifest.label}`,
    '',
    `Model ${manifest.model}, judge ${manifest.judge}, commit ${manifest.commit}, ${summary.questions} questions, ${summary.unpriced ? `$${summary.knownCostUsd.toFixed(2)} known subtotal; total cost unknown` : `$${summary.totalCostUsd!.toFixed(2)} total`}.`,
    '',
  ];
  for (const [setup, result] of Object.entries(summary.setups)) {
    lines.push(
      `## ${setup}`,
      '',
      `Overall ${result.overall.correct}/${result.overall.n} (${result.overall.percent}%), task-averaged ${result.taskAveraged}%, abstention ${result.abstention.correct}/${result.abstention.n}, evidence outside the last 30 messages ${result.evidenceOutsideRecent.correct}/${result.evidenceOutsideRecent.n} (${result.evidenceOutsideRecent.percent}%). Incomplete ${result.incomplete}. Compacted ${result.compacted}. Used memory or history search ${result.searched}. $${result.costUsd.toFixed(2)}.`,
      '',
      '| Type | Correct | % |',
      '| --- | --- | --- |',
      ...Object.entries(result.perType).map(
        ([type, item]) => `| ${type} | ${item.correct}/${item.n} | ${item.percent ?? '–'} |`,
      ),
      '',
    );
  }
  lines.push(
    `Learning: ${summary.learning.meanNotes} notes per history on average (${summary.learning.meanConfirmed} confirmed, ${summary.learning.meanLearned} learned, ${summary.learning.meanTentative} mentioned once), $${summary.learning.costUsd.toFixed(2)}.`,
  );
  return lines.join('\n');
}

export async function runLongMemEval(options: LongMemEvalOptions) {
  const raw = await readFile(options.data);
  const items = JSON.parse(raw.toString('utf8')) as LongMemEvalItem[];
  const picked = options.questions
    ? options.questions.map((id) => {
        const item = items.find((entry) => entry.question_id === id);
        if (!item) throw new Error(`Unknown LongMemEval question ${id}.`);
        return item;
      })
    : stratified(items, options.sample ?? items.length);
  const chatIds = new Set(
    options.setups.includes('chat')
      ? stratified(picked, options.chatSample ?? picked.length).map((item) => item.question_id)
      : [],
  );
  const environment = await prepare(options.root);
  const judgeModel = parseModel(options.judge, environment);
  if (judgeModel.provider !== 'openai')
    throw new Error('The LongMemEval judge must be an OpenAI model, as in the official script.');
  const agent = parseModel(options.model, environment);
  if (options.setups.includes('chat') && agent.provider !== 'openai')
    throw new Error(
      'The chat setup needs an OpenAI agent model to measure the history with its token counter.',
    );
  const directory = join(options.root, 'longmemeval', options.label);
  await mkdir(join(directory, 'raw'), { recursive: true });
  await mkdir(join(directory, 'logs'), { recursive: true });
  await mkdir(join(directory, 'questions'), { recursive: true });
  const manifest = {
    label: options.label,
    model: options.model,
    judge: options.judge,
    setups: options.setups,
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: appSource })
      .toString()
      .trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: appSource })
        .toString()
        .trim().length > 0,
    source: appSource,
    dataset: createHash('sha256').update(raw).digest('hex'),
    questions: picked.map((item) => item.question_id),
    chatQuestions: [...chatIds],
    started: new Date().toISOString(),
  };
  const manifestPath = join(directory, 'manifest.json');
  const saved = await readFile(manifestPath, 'utf8').catch(() => undefined);
  if (saved && !options.resume)
    throw new Error(`Label ${options.label} already exists. Pick another label or pass --resume.`);
  if (saved) {
    const previous = JSON.parse(saved) as typeof manifest;
    for (const key of ['model', 'judge', 'dataset', 'commit'] as const)
      if (previous[key] !== manifest[key])
        throw new Error(`Label ${options.label} was run with another ${key}. Pick a new label.`);
    if (previous.setups.join() !== manifest.setups.join())
      throw new Error(`Label ${options.label} was run with other setups. Pick a new label.`);
  } else await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const results = new Map<string, QuestionRun>();
  const retried = new Map<string, QuestionRun>();
  for (const item of picked) {
    const done = await readFile(join(directory, 'questions', `${item.question_id}.json`), 'utf8')
      .then((text) => JSON.parse(text) as QuestionRun)
      .catch(() => undefined);
    const wanted = options.setups.filter(
      (setup) => setup === 'memory' || chatIds.has(item.question_id),
    );
    if (
      done &&
      !done.error &&
      wanted.every((setup) => scored(done.runs.find((run) => run.setup === setup)))
    )
      results.set(item.question_id, done);
    else if (done) retried.set(item.question_id, done);
  }
  const savedAttempts = [...results.values(), ...retried.values()];
  let spent = savedAttempts.reduce((sum, result) => sum + totalCost(result), 0);
  let hasUnpriced = savedAttempts.some(unpriced);
  const rank = (id: string) => createHash('sha256').update(`order:${id}`).digest('hex');
  const queue = picked
    .filter((item) => !results.has(item.question_id))
    .toSorted((a, b) => rank(a.question_id).localeCompare(rank(b.question_id)));
  console.log(
    `LongMemEval: ${picked.length} questions, ${queue.length} to run, ${chatIds.size} with the chat setup. Results in ${directory}`,
  );
  let next = 0;
  let stopped = false;
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
      while (next < queue.length && !stopped) {
        if (options.budget !== undefined && (hasUnpriced || spent >= options.budget)) {
          if (!stopped)
            console.log(
              hasUnpriced
                ? 'Stopping: completed model usage has no valid price.'
                : `Stopping: $${spent.toFixed(2)} spent of the $${options.budget} budget.`,
            );
          stopped = true;
          return;
        }
        const item = queue[next++];
        const setups = options.setups.filter(
          (setup) => setup === 'memory' || chatIds.has(item.question_id),
        );
        const result = await attempt(directory, item, setups, options.model);
        spent += cost(result);
        if (unpriced(result)) hasUnpriced = true;
        for (const run of result.runs)
          if (!(run.error && !run.reply)) {
            run.verdict = await judge(item, run.reply, judgeModel).catch((error) => {
              run.error = error instanceof Error ? error.message : String(error);
              return undefined;
            });
            spent += run.verdict?.costUsd ?? 0;
          }
        const previous = retried.get(item.question_id);
        if (previous) {
          result.previousCostUsd = totalCost(previous);
          result.previousSetupCostsUsd = setupCosts(previous);
          result.previousLearningCostUsd = learningCost(previous);
          result.previousUnpricedCalls = unpricedCount(previous);
        }
        results.set(item.question_id, result);
        await writeFile(
          join(directory, 'questions', `${item.question_id}.json`),
          JSON.stringify(
            {
              ...result,
              question: item.question,
              questionDate: item.question_date,
              answer: item.answer,
            },
            null,
            2,
          ),
        );
        const marks = result.runs
          .map(
            (run) =>
              `${run.setup}:${run.verdict ? (run.verdict.correct ? 'yes' : 'no') : 'incomplete'}`,
          )
          .join(' ');
        console.log(
          `${results.size}/${picked.length} ${item.question_id} ${item.question_type} ${result.error ? `error: ${result.error.slice(0, 160)}` : marks} ($${spent.toFixed(2)})`,
        );
      }
    }),
  );
  const ordered = picked.flatMap(
    (item) => results.get(item.question_id) ?? retried.get(item.question_id) ?? [],
  );
  const summary = summarizeLongMemEval(ordered, options.setups);
  await writeFile(join(directory, 'summary.json'), JSON.stringify({ manifest, summary }, null, 2));
  const report = markdown(summary, manifest);
  await writeFile(join(directory, 'summary.md'), report);
  console.log(report);
  return { directory, summary };
}

export const parseSetups = (value: string | undefined) => {
  const chosen = (value ?? setupNames.join(',')).split(',').map((item) => item.trim());
  for (const item of chosen)
    if (!setupNames.includes(item as SetupName))
      throw new Error(`--setups takes ${setupNames.join(', ')}.`);
  return chosen as SetupName[];
};

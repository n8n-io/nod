import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarize } from './aggregate.ts';
import { summarizePopulation } from './proactivity.ts';
import { runDecisionEval } from './decisions.ts';
import { parseSetups, runLongMemEval } from './longmemeval.ts';
import { parseModes, runWhisperBench } from './whisperbench.ts';
import { cards, comparisonChart } from './chart.ts';
import { storyCard, type StoryNotes } from './story.ts';
import { renderImages } from './images.ts';
import { slackMessage } from './writeup.ts';
import { diagnoseAll } from './diagnose.ts';
import { cleanup, doctor, printChecks } from './environment.ts';
import { choice, has, number, text, whole, type Args } from './options.ts';
import { compareTable, html, markdown, runsTable, terminal } from './report.ts';
import { rejudge } from './rejudge.ts';
import { reviewRun } from './review.ts';
import { promote, runGate } from './gate.ts';
import { fallbackLlm } from './judge.ts';
import { defaultJudge, defaultModel, runSuite, slug, type RunOptions } from './run.ts';
import { scenarios } from './scenarios/index.ts';
import { loadEnvironment, parseModel } from './stack.ts';
import { listRuns, loadRun, resultsRoot, saveRun } from './store.ts';
import type { RunSummary } from './results.ts';

const help = `Nod capability evals

  Start here
    doctor [--fix]             check Docker, images, database and keys; --fix sets up what is missing
    run [--tier pr|full|release|live]  run the suite and print the pass rate, trust profile and what went wrong
    list                       show every scenario
    decisions --model <provider/name>  compare trust checks with main using live models and synthetic inputs
                               (--baseline main, --repeat 3, --scenario a,b, --arms main-llm,branch-llm,gpt-decisions,jev-openrouter, --decision-model provider/model, --label name, --out directory)
    longmemeval --data <file>  run the LongMemEval-S memory benchmark on the real Nod, graded by the official judge
                               (--setups memory,chat, --sample 30, --chat-sample 10, --questions a,b,
                                --concurrency 6, --budget 50, --label name, --resume)
    whisperbench --data <folder>  run the WhisperBench memory-poisoning benchmark on the real Nod
                               (--modes foreground,background, --cases a,b, --model provider/name,
                                --concurrency 6, --budget 50, --label name, --resume)

  Compare
    models <a> <b> [...]       run the same suite on several models, compare them and draw a chart
                               (providers: openai/<model>, anthropic/<model>, openrouter/<vendor>/<model>)
    refs <a> <b> [...]         run the same suite on several git revisions (a PR against main)
    compare <label> <label>    compare saved runs: pass rate, cost, latency, what got better or worse
    gate --baseline <git ref>  run the suite on this code and on <ref> in one job and show them side by side, with
                               a GO, NO-GO or INCONCLUSIVE verdict from the proven gate scenarios; gate
                               scenarios where this code did worse get 7 more attempts on both sides
                               (--resample 7, --enforce exits with an error unless GO)
    promote <label>...         give calibrated scenarios that passed all of at least 5 attempts a place in the
                               gate, and remove the ones that did not (writes evals/gate.json)
    runs                       list saved runs
    charts <label>... | --prefix <p> [--desktop]   render the comparison as sleek PNG images
    slack <label>... | --prefix <p>                 draft the Slack summary with the leaderboard

  Look closer
    proactivity-report <label>  show discovery, misses, unwanted nudges and cost for the controlled source populations
    report <label> [--open]    show a saved run (and open its HTML report)
    markdown <label> [<label>] a saved run, or a baseline and a candidate, as Markdown for a CI summary
    review <label>             judge attempts as a user would: would you trust Nod with this?
    diagnose <label>           explain why failed attempts failed (agent, scenario, mock or harness)
    rejudge <label> --label <new> [--judge <provider/model>]   re-grade saved attempts with another judge

  Housekeeping
    cleanup                    remove leftover eval containers and database schemas

  Common options for run, models and refs
    --model <provider/name>    agent model (default from LLM_PROVIDER, LLM_MODEL or the keys you have)
    --judge <provider/name>    judge model (default ${defaultJudge}, kept fixed so runs stay comparable)
    --tier pr|full|release|live  default full: all controlled cases except the release suite, including
                               pending cases; pr is the small suite; release adds the release suite;
                               live also runs the open web cases
    --scenario a,b             only these scenarios       --capability browser   only this capability
    --include-pending          include pending cases in the small pr suite
    --repeat 3                 attempts per scenario      --k 3                  k for pass@k and pass^k
    --concurrency 2            attempts at once           --budget 20            stop after about this many dollars
    --parallel 2               (models) run this many models at the same time
    --ref <git ref>            test another revision of the app code with these scenarios
    --open                     open the HTML report or chart when it is ready
    --label <name>             name the run               --resume               redo only incomplete attempts
    --no-diagnose              skip the failure analysis  --retries 2            retries for provider or infrastructure faults
    --no-canary                skip the harness canary that runs before the suite
    --min-pass 0.8             exit with an error if the rate passing all required checks is lower

  Examples
    pnpm run eval:capability doctor --fix
    pnpm run eval:capability run --tier pr --repeat 3
    pnpm run eval:capability models openai/gpt-6.1-sol anthropic/claude-sonnet-5-5 --tier pr
    pnpm run eval:capability refs main my-branch --tier pr
`;

function runOptions(args: Args): RunOptions {
  const repeat = whole(args, 'repeat', 3);
  return {
    root: resultsRoot(text(args, 'out')),
    model: text(args, 'model'),
    ...(text(args, 'effort')
      ? {
          effort: choice(
            args,
            'effort',
            ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const,
            'high',
          ),
        }
      : {}),
    judge: text(args, 'judge'),
    repeat,
    k: whole(args, 'k', repeat),
    concurrency: whole(args, 'concurrency', 2),
    tier: choice(args, 'tier', ['pr', 'full', 'release', 'live'], 'full'),
    scenarioIds: text(args, 'scenario')?.split(','),
    capability: text(args, 'capability'),
    label: text(args, 'label'),
    ref: text(args, 'ref'),
    resume: has(args, 'resume'),
    ignoreWindow: has(args, 'ignore-window'),
    includePending: has(args, 'include-pending'),
    retries: Math.trunc(number(args, 'retries', 0, 10) ?? 2),
    canary: !has(args, 'no-canary'),
    budget: number(args, 'budget', 0),
    diagnose: !has(args, 'no-diagnose'),
  };
}

async function matrix(args: Args, kind: 'model' | 'ref') {
  const base = runOptions(args);
  const items = [
    ...args.positional,
    ...(text(args, kind === 'model' ? 'models' : 'refs')?.split(',') ?? []),
  ];
  if (items.length < 2)
    throw new Error(`Give at least two ${kind === 'model' ? 'models' : 'git refs'} to compare.`);
  const prefix =
    base.label ?? `${kind}s-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  const labels = items.map((item) => `${prefix}-${slug(item)}`);
  const parallel = kind === 'model' ? whole(args, 'parallel', 1) : 1;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await runSuite({
          ...base,
          label: labels[index],
          ...(kind === 'model' ? { model: items[index] } : { ref: items[index] }),
          quiet: true,
        });
      }
    }),
  );
  const runs = await Promise.all(labels.map((label) => loadRun(base.root, label)));
  const table = compareTable(runs);
  console.log(table);
  await writeFile(join(base.root, `${prefix}.compare.txt`), table);
  const chart = join(base.root, `${prefix}.compare.html`);
  await writeFile(chart, comparisonChart(runs, `Nod capability evals: ${items.join(' vs ')}`));
  console.log(`Saved ${chart}\nDetails: pnpm run eval:capability report <label>`);
  if (has(args, 'open')) open(chart);
}

function open(path: string) {
  try {
    execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [path], { stdio: 'ignore' });
  } catch {
    console.log(`Open ${path}`);
  }
}

function idList(value: string | undefined, flag: string) {
  if (value === undefined) return undefined;
  const ids = [
    ...new Set(
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) throw new Error(`--${flag} needs at least one ID.`);
  return ids;
}

export function meetsMinimumPassRate(summary: RunSummary, minimum?: number) {
  return summary.combined.total > 0 && (summary.combined.percent ?? 0) >= (minimum ?? 0);
}

export async function main(args: Args) {
  const root = resultsRoot(text(args, 'out'));
  const [first, ...others] = args.positional;
  switch (args.command) {
    case 'help':
      console.log(help);
      return;
    case 'doctor': {
      const ok = printChecks(await doctor(root, has(args, 'fix')));
      if (ok) console.log('\nAll set. Try: pnpm run eval:capability run --tier pr --repeat 1');
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'list': {
      const status = (item: (typeof scenarios)[number]) =>
        item.stance === 'gap'
          ? 'known gap'
          : item.calibration === 'pending'
            ? 'calibrating'
            : item.tier === 'live'
              ? 'live web'
              : 'scored';
      if (has(args, 'markdown')) {
        console.log(
          '| Scenario | Linear | What it checks | Capabilities | Status |\n| --- | --- | --- | --- | --- |',
        );
        for (const item of scenarios)
          console.log(
            `| \`${item.id}\` | ${item.linear ?? ''} | ${item.title} | ${item.capabilities.join(', ')} | ${status(item)} |`,
          );
        return;
      }
      for (const item of scenarios)
        console.log(
          `${item.id.padEnd(40)} ${item.tier.padEnd(7)} ${item.complexity.padEnd(8)} ${item.stance.padEnd(10)} ${item.capabilities.join(',').padEnd(34)} ${(item.linear ?? '').padEnd(8)} ${item.calibration === 'pending' ? 'calibration pending' : ''}`,
        );
      return;
    }
    case 'run': {
      const minimum = number(args, 'min-pass', 0, 1);
      const result = await runSuite(runOptions(args));
      if (!meetsMinimumPassRate(result.summary, minimum)) process.exitCode = 1;
      return;
    }
    case 'decisions': {
      const model = text(args, 'model');
      if (!model) throw new Error('Decision evaluation requires --model <provider/name>.');
      const result = await runDecisionEval({
        model: parseModel(model, await loadEnvironment()),
        baseline: text(args, 'baseline') ?? 'main',
        root,
        label: text(args, 'label') ?? new Date().toISOString().replace(/[:.]/g, '-'),
        repeat: whole(args, 'repeat', 3),
        caseIds: text(args, 'scenario')?.split(','),
        arms: text(args, 'arms')?.split(','),
        openRouterModel: text(args, 'decision-model'),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'longmemeval': {
      const data = text(args, 'data');
      if (!data) throw new Error('LongMemEval requires --data <longmemeval_s_cleaned.json>.');
      const environment = await loadEnvironment();
      await runLongMemEval({
        data,
        root,
        label:
          text(args, 'label') ?? `longmemeval-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        model: text(args, 'model') ?? defaultModel(environment),
        judge: text(args, 'judge') ?? 'openai/gpt-4o-2024-08-06',
        setups: parseSetups(text(args, 'setups')),
        sample: text(args, 'sample') === undefined ? undefined : whole(args, 'sample', 1),
        chatSample:
          text(args, 'chat-sample') === undefined ? undefined : whole(args, 'chat-sample', 1),
        questions: idList(text(args, 'questions'), 'questions'),
        concurrency: whole(args, 'concurrency', 6),
        budget: number(args, 'budget', 0),
        resume: has(args, 'resume'),
      });
      return;
    }
    case 'whisperbench': {
      const data = text(args, 'data');
      if (!data) throw new Error('WhisperBench requires --data <MemGhost-WhisperBench folder>.');
      const environment = await loadEnvironment();
      await runWhisperBench({
        data,
        root,
        label:
          text(args, 'label') ?? `whisperbench-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        model: text(args, 'model') ?? defaultModel(environment),
        judge: text(args, 'judge') ?? 'openai/gpt-5.4-nano',
        modes: parseModes(text(args, 'modes')),
        cases: idList(text(args, 'cases'), 'cases'),
        concurrency: whole(args, 'concurrency', 6),
        budget: number(args, 'budget', 0),
        resume: has(args, 'resume'),
      });
      return;
    }
    case 'gate': {
      const baseline = text(args, 'baseline');
      if (!baseline) throw new Error('Usage: gate --baseline <git ref> [run options]');
      const options = runOptions(args);
      const result = await runGate({
        ...options,
        baseline,
        resample: Math.trunc(number(args, 'resample', 0, 20) ?? 7),
        label:
          options.label ?? `gate-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`,
      });
      console.log(result.report);
      if (has(args, 'enforce') && result.verdict !== 'GO') process.exitCode = 1;
      return;
    }
    case 'promote': {
      const labels = [...new Set([first, ...others].filter(Boolean))];
      if (!labels.length) throw new Error('Usage: promote <label> [<label>...]');
      const members = Object.keys(await promote(root, labels));
      console.log(
        `${members.length} scenarios have a place in the gate: ${members.join(', ') || 'none'}. Commit evals/gate.json.`,
      );
      return;
    }
    case 'models':
      return matrix(args, 'model');
    case 'refs':
      return matrix(args, 'ref');
    case 'compare': {
      const labels = [first, ...others].filter(Boolean);
      if (labels.length < 2) throw new Error('Usage: compare <label> <label> [...]');
      const runs = await Promise.all(labels.map((label) => loadRun(root, label)));
      console.log(compareTable(runs));
      const chart = join(
        root,
        `compare-${labels.map((label) => label.slice(0, 20)).join('-vs-')}.html`,
      );
      await writeFile(chart, comparisonChart(runs));
      console.log(`Chart: ${chart}`);
      if (has(args, 'open')) open(chart);
      if (new Set(runs.map((run) => run.manifest.judge)).size > 1)
        console.log('Note: these runs used different judge models.\n');
      if (
        runs.length === 2 &&
        runs[0].manifest.model === runs[1].manifest.model &&
        runs[0].manifest.commit === runs[1].manifest.commit &&
        !runs[0].manifest.dirty &&
        !runs[1].manifest.dirty
      )
        console.log(
          'These two runs used the same model and the same code, so every difference you see is run-to-run noise.\n',
        );
      return;
    }
    case 'charts': {
      const found = first ? [first, ...others] : [];
      const prefix = text(args, 'prefix');
      const labels = prefix
        ? (await listRuns(root))
            .map((run) => run.label)
            .filter((name) => name.startsWith(`${prefix}-`))
            .sort()
        : found;
      if (labels.length < 1)
        throw new Error('Usage: charts <label> [...]  or  charts --prefix <prefix>');
      const judgePrefix = text(args, 'judge-prefix');
      const runs = await Promise.all(
        labels.map(async (label) => {
          const run = await loadRun(root, label);
          const second =
            prefix && judgePrefix
              ? await loadRun(root, `${judgePrefix}-${label.slice(prefix.length + 1)}`).catch(
                  () => undefined,
                )
              : undefined;
          return second ? { ...run, alt: second.summary } : run;
        }),
      );
      const name = prefix ?? labels.join('-vs-').slice(0, 60);
      const directory = join(root, `${name}-images`);
      const notesPath = text(args, 'notes');
      const notes = notesPath
        ? (JSON.parse(await readFile(notesPath, 'utf8')) as StoryNotes)
        : undefined;
      const suite = {
        total: scenarios.length,
        calibrating: scenarios.filter(
          (item) => item.calibration === 'pending' && item.stance !== 'gap',
        ).length,
        gaps: scenarios.filter((item) => item.stance === 'gap').length,
      };
      const files = await renderImages([storyCard(runs, suite, notes), ...cards(runs)], directory);
      await writeFile(join(root, `${name}.report.html`), comparisonChart(runs));
      console.log(`Rendered ${files.length} images in ${directory}`);
      if (has(args, 'desktop')) {
        const target = join(process.env.HOME ?? '.', 'Desktop', `nod-evals-${name}`);
        await mkdir(target, { recursive: true });
        for (const file of files) await copyFile(file, join(target, file.split('/').pop()!));
        console.log(`Copied to ${target}`);
      }
      return;
    }
    case 'slack': {
      const prefix = text(args, 'prefix');
      const labels = prefix
        ? (await listRuns(root))
            .map((run) => run.label)
            .filter((name) => name.startsWith(`${prefix}-`))
            .sort()
        : [first, ...others].filter(Boolean);
      if (!labels.length)
        throw new Error('Usage: slack <label> [...]  or  slack --prefix <prefix>');
      const runs = await Promise.all(labels.map((label) => loadRun(root, label)));
      const all = scenarios;
      const message = slackMessage(runs, {
        total: all.length,
        frozen: all.filter((item) => item.calibration !== 'pending' && item.stance !== 'gap')
          .length,
        pending: all.filter((item) => item.calibration === 'pending' && item.stance !== 'gap')
          .length,
        gaps: all.filter((item) => item.stance === 'gap').length,
      });
      console.log(message);
      return;
    }
    case 'runs':
      console.log(runsTable(await listRuns(root)));
      return;
    case 'proactivity-report': {
      if (!first) throw new Error('Give a saved run label.');
      const run = await loadRun(root, first);
      console.log(JSON.stringify(summarizePopulation(run.attempts), null, 2));
      return;
    }
    case 'report': {
      if (!first) throw new Error('Usage: report <label> [--open]');
      const run = await loadRun(root, first);
      console.log(terminal(run.summary, run.attempts, run.reviews));
      await writeFile(
        join(run.directory, 'report.html'),
        html(run.summary, run.attempts, run.reviews),
      );
      if (has(args, 'open')) open(join(run.directory, 'report.html'));
      else console.log(`HTML report: ${join(run.directory, 'report.html')}`);
      return;
    }
    case 'markdown': {
      const labels = [first, ...others].filter(Boolean);
      if (!labels.length || labels.length > 2)
        throw new Error('Usage: markdown <label>  or  markdown <baseline> <candidate>');
      console.log(markdown(await Promise.all(labels.map((label) => loadRun(root, label)))));
      return;
    }
    case 'review': {
      if (!first) throw new Error('Usage: review <label>');
      const run = await loadRun(root, first);
      const reviews = await reviewRun({
        directory: run.directory,
        attempts: run.attempts,
        sample: Number(text(args, 'sample') ?? 0.3),
        reviewer: text(args, 'reviewer') ?? process.env.USER ?? 'reviewer',
      });
      await writeFile(join(run.directory, 'report.html'), html(run.summary, run.attempts, reviews));
      console.log(terminal(run.summary, run.attempts, reviews));
      return;
    }
    case 'diagnose': {
      if (!first) throw new Error('Usage: diagnose <label>');
      const environment = await loadEnvironment();
      const run = await loadRun(root, first);
      const outcome = await diagnoseAll(
        parseModel(text(args, 'judge') ?? run.manifest.judge, environment),
        run.attempts,
      );
      await saveRun(run.directory, run.manifest, run.attempts);
      const summary = summarize(run.manifest, run.attempts);
      await saveRun(run.directory, run.manifest, [], summary);
      await writeFile(join(run.directory, 'report.html'), html(summary, run.attempts, run.reviews));
      console.log(
        `Diagnosed ${outcome.diagnosed} failed attempts.\n${terminal(summary, run.attempts, run.reviews)}`,
      );
      return;
    }
    case 'rejudge': {
      const target = text(args, 'label');
      if (!first || !target)
        throw new Error(
          'Usage: rejudge <label> --label <new-label> [--judge <provider/model>] [--scenario <a,b>]',
        );
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(target))
        throw new Error('Labels must be simple file names.');
      const directory = join(root, target);
      await mkdir(root, { recursive: true });
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        throw error.code === 'EEXIST'
          ? new Error(`Run ${target} already exists. Choose another --label.`)
          : error;
      });
      try {
        const environment = await loadEnvironment();
        const run = await loadRun(root, first);
        const judgeName = text(args, 'judge') ?? defaultJudge;
        const only = text(args, 'scenario')?.split(',').filter(Boolean);
        const outcome = await rejudge({
          attempts: run.attempts,
          reviews: run.reviews,
          judge: parseModel(judgeName, environment),
          only,
          at: Date.parse(run.manifest.startedAt) || Date.now(),
          fallback: await fallbackLlm(environment, parseModel(judgeName, environment).provider),
        });
        const manifest = {
          ...run.manifest,
          label: target,
          judge: judgeName,
          provenance: {
            ...run.manifest.provenance,
            rejudgedFrom: first,
            ...(only
              ? { rejudgedScenarios: only.join(' '), originalJudge: run.manifest.judge }
              : {}),
          },
        };
        const summary = summarize(manifest, outcome.attempts);
        await saveRun(directory, manifest, outcome.attempts, summary);
        await writeFile(join(directory, 'reviews.json'), JSON.stringify(run.reviews, null, 2));
        await writeFile(
          join(directory, 'report.html'),
          html(summary, outcome.attempts, run.reviews),
        );
        console.log(terminal(summary, outcome.attempts, run.reviews));
        console.log(outcome.report);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return;
    }
    case 'cleanup': {
      const removed = await cleanup(root);
      console.log(
        `Removed ${removed.containers} leftover containers and ${removed.schemas} database schemas.`,
      );
      return;
    }
    default:
      console.log(`Unknown command "${args.command}".\n\n${help}`);
      process.exitCode = 1;
  }
}

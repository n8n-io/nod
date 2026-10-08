import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarize } from './aggregate.ts';
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
import { fallbackLlm } from './judge.ts';
import { defaultJudge, runSuite, slug, type RunOptions } from './run.ts';
import { scenarios } from './scenarios/index.ts';
import { loadEnvironment, parseModel } from './stack.ts';
import { listRuns, loadRun, resultsRoot, saveRun } from './store.ts';

export const help = `Otto capability evals

  Start here
    doctor [--fix]             check Docker, images, database and keys; --fix sets up what is missing
    run [--tier pr|full|live]  run the suite and print the pass rate, trust profile and what went wrong
    list                       show every scenario

  Compare
    models <a> <b> [...]       run the same suite on several models, compare them and draw a chart
                               (providers: openai/<model>, anthropic/<model>, openrouter/<vendor>/<model>)
    refs <a> <b> [...]         run the same suite on several git revisions (a PR against main)
    compare <label> <label>    compare saved runs: pass rate, cost, latency, what got better or worse
    runs                       list saved runs
    charts <label>... | --prefix <p> [--desktop]   render the comparison as sleek PNG images
    slack <label>... | --prefix <p>                 draft the Slack summary with the leaderboard

  Look closer
    report <label> [--open]    show a saved run (and open its HTML report)
    markdown <label> [<label>] a saved run, or a baseline and a candidate, as Markdown for a CI summary
    review <label>             judge attempts as a user would: would you trust Otto with this?
    diagnose <label>           explain why failed attempts failed (agent, scenario, mock or harness)
    rejudge <label> --label <new> [--judge <provider/model>]   re-grade saved attempts with another judge

  Housekeeping
    cleanup                    remove leftover eval containers and database schemas

  Common options for run, models and refs
    --model <provider/name>    agent model (default from LLM_PROVIDER, LLM_MODEL or the keys you have)
    --judge <provider/name>    judge model (default ${defaultJudge}, kept fixed so runs stay comparable)
    --tier pr|full|live        default full: all controlled cases, including pending cases; pr is the small suite
                               live also runs the open web cases
    --scenario a,b             only these scenarios       --capability browser   only this capability
    --include-pending          include pending cases in the small pr suite
    --repeat 3                 attempts per scenario      --k 3                  k for pass@k and pass^k
    --concurrency 2            attempts at once           --budget 20            stop after about this many dollars
    --parallel 2               (models) run this many models at the same time
    --ref <git ref>            test another revision of the app code with these scenarios
    --open                     open the HTML report or chart when it is ready
    --label <name>             name the run               --resume               redo only incomplete attempts
    --no-diagnose              skip the failure analysis  --retries 1            retries for provider or infrastructure faults
    --min-pass 0.8             exit with an error if the pass rate is lower

  Examples
    npm run eval:capability -- doctor --fix
    npm run eval:capability -- run --tier pr --repeat 3
    npm run eval:capability -- models openai/gpt-6.1-sol anthropic/claude-sonnet-5-5 --tier pr
    npm run eval:capability -- refs main my-branch --tier pr
`;

function runOptions(args: Args): RunOptions {
  const repeat = whole(args, 'repeat', 3);
  return {
    root: resultsRoot(text(args, 'out')),
    model: text(args, 'model'),
    judge: text(args, 'judge'),
    repeat,
    k: whole(args, 'k', repeat),
    concurrency: whole(args, 'concurrency', 2),
    tier: choice(args, 'tier', ['pr', 'full', 'live'], 'full'),
    scenarioIds: text(args, 'scenario')?.split(','),
    capability: text(args, 'capability'),
    label: text(args, 'label'),
    ref: text(args, 'ref'),
    resume: has(args, 'resume'),
    ignoreWindow: has(args, 'ignore-window'),
    includePending: has(args, 'include-pending'),
    retries: Math.trunc(number(args, 'retries', 0, 10) ?? 1),
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
  await writeFile(chart, comparisonChart(runs, `Otto capability evals: ${items.join(' vs ')}`));
  console.log(`Saved ${chart}\nDetails: npm run eval:capability -- report <label>`);
  if (has(args, 'open')) open(chart);
}

function open(path: string) {
  try {
    execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [path], { stdio: 'ignore' });
  } catch {
    console.log(`Open ${path}`);
  }
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
      if (ok) console.log('\nAll set. Try: npm run eval:capability -- run --tier pr --repeat 1');
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
          `${item.id.padEnd(28)} ${item.tier.padEnd(5)} ${item.complexity.padEnd(8)} ${item.stance.padEnd(10)} ${item.capabilities.join(',').padEnd(34)} ${(item.linear ?? '').padEnd(8)} ${item.calibration === 'pending' ? 'calibration pending' : ''}`,
        );
      return;
    }
    case 'run': {
      const minimum = number(args, 'min-pass', 0, 1);
      const result = await runSuite(runOptions(args));
      if (
        !result.summary.regression.total ||
        result.summary.coverage.missing.length ||
        result.summary.coverage.incomplete ||
        (minimum !== undefined && (result.summary.regression.percent ?? 0) < minimum)
      )
        process.exitCode = 1;
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
        const target = join(process.env.HOME ?? '.', 'Desktop', `otto-evals-${name}`);
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

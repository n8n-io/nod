import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { grade } from './grade.ts';
import { createLlm, createSimulator } from './judge.ts';
import type { Blame, AttemptResult, CheckResult } from './results.ts';
import { fingerprint, scenarios } from './scenarios/index.ts';
import { createSession } from './session.ts';
import { prepare } from './setup.ts';
import { loadEnvironment, parseModel, startStack, type Stack } from './stack.ts';
import { collect } from './trace.ts';
import { routeFixtureHosts } from './world/fixture-fetch.ts';
import { bindAddress, serveSites } from './world/sites.ts';

export interface AttemptSpec {
  scenario: string;
  attempt: number;
  outFile: string;
  model: string;
  judge: string;
}

const infra =
  /\b(401|403|429|500|502|503|504|529)\b|unauthori[sz]ed|invalid api key|user not found|insufficient|credit|overloaded|rate.?limit|quota|ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|Could not start|did not become ready|image .* is missing|PostgreSQL|EADDRINUSE|docker/i;

function blame(message: string): Blame {
  if (/time limit|no progress/i.test(message)) return 'agent';
  return infra.test(message) ? 'infra' : 'harness';
}

let terminate: (() => Promise<void>) | undefined;

async function run(spec: AttemptSpec): Promise<AttemptResult> {
  const definition = scenarios.find((item) => item.id === spec.scenario);
  if (!definition) throw new Error(`Unknown scenario ${spec.scenario}.`);
  const base = {
    scenario: definition.id,
    title: definition.title,
    capabilities: definition.capabilities,
    tier: definition.tier,
    complexity: definition.complexity,
    stance: definition.stance,
    fingerprint: fingerprint(definition.id),
    attempt: spec.attempt,
    task: '',
  };
  const empty = {
    checks: [] as CheckResult[],
    seconds: 0,
    toolCalls: 0,
    modelCalls: 0,
    tokens: 0,
    costUsd: null,
    toolErrors: 0,
    firstReplySeconds: null,
    judgeCostUsd: null,
    final: '',
    transcript: '',
    groundTruth: '',
  };
  const environment = await loadEnvironment();
  const model = parseModel(spec.model, environment);
  const judgeModel = parseModel(spec.judge, environment);
  const started = Date.now();
  let taskStarted = started;
  const world = definition.world({ now: () => Date.now() });
  const address = await bindAddress();
  const sites = await serveSites(world.sites ?? {}, address);
  const unroute = routeFixtureHosts(
    Object.keys(world.sites ?? {}),
    `http://${address}:${sites.port}`,
  );
  let stack: Stack | undefined;
  let starting: Promise<Stack> | undefined;
  const release = async () => {
    stack ??= await starting?.catch(() => undefined);
    await stack?.stop().catch(() => {});
    await sites.close().catch(() => {});
    unroute();
  };
  terminate = release;
  try {
    const judgeLlm = await createLlm(judgeModel);
    stack = await (starting = startStack({
      model,
      integrations:
        world.apps?.provider ??
        (await import('./world/apps.ts')).createApps(
          { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' },
          {},
        ).provider,
      siteHosts: Object.keys(world.sites ?? {}),
      siteUpstreamPort: sites.port,
      environment,
    }));
    await prepare(stack, world, definition.timeZone ?? 'Europe/Madrid');
    taskStarted = Date.now();
    const session = createSession({
      stack,
      user: definition.user,
      simulator: definition.user.persona ? createSimulator(judgeLlm) : undefined,
      deadline: taskStarted + definition.seconds * 1000,
      world,
    });
    let failure: string | undefined;
    try {
      await definition.play(session, world);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const trace = await collect({
      task: session.userMessages.map((message) => message.text).join('\n---\n'),
      stack,
      session,
      world,
      visits: sites.visits,
      seconds: (Date.now() - taskStarted) / 1000,
    });
    const truth = [trace.groundTruth(), definition.evidence?.(trace, world)]
      .filter(Boolean)
      .join('\n\n');
    const { checks, graderFault, judgeFault } = await grade({
      definition,
      world,
      trace,
      judge: judgeLlm,
      truth,
      skipJudges: Boolean(failure),
    });
    const modelFault =
      trace.turns.at(-1)?.status !== 'succeeded' ? trace.modelErrors.at(-1) : undefined;
    const providerFault = trace.turns.find((turn) => turn.error && infra.test(turn.error));
    const refusal = [modelFault, failure].find(
      (message) =>
        message &&
        /violative|usage policy|content (filtering )?policy|safety (filter|system)/i.test(message),
    );
    const fault =
      graderFault ??
      judgeFault ??
      (modelFault && modelFault !== refusal
        ? `The model provider failed: ${modelFault}`
        : providerFault
          ? providerFault.error!
          : undefined);
    const hardFailure =
      failure && failure !== refusal && blame(failure) !== 'agent' ? failure : undefined;
    const incomplete = fault ?? hardFailure;
    const result: AttemptResult = {
      ...base,
      task: trace.task,
      status: incomplete
        ? 'incomplete'
        : checks.every((check) => check.pass || !check.required) && !failure && !refusal
          ? 'pass'
          : 'fail',
      ...(incomplete
        ? { blame: graderFault ? ('harness' as const) : blame(incomplete), error: incomplete }
        : {}),
      ...(refusal && !incomplete
        ? { error: `The model provider refused the task: ${refusal}` }
        : failure && !incomplete
          ? { error: failure }
          : {}),
      checks,
      seconds: trace.seconds,
      toolCalls: trace.tools.length,
      modelCalls: trace.usage.modelCalls,
      tokens: trace.usage.tokens,
      costUsd: trace.usage.costUsd,
      toolErrors: trace.tools.filter((call) => call.isError).length,
      firstReplySeconds: trace.firstReplySeconds,
      judgeCostUsd: judgeLlm.spent().costUsd,
      final: trace.final,
      transcript: trace.transcript(60_000),
      groundTruth: truth,
    };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      ...empty,
      status: 'incomplete',
      blame: blame(message),
      error: message,
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    await release();
  }
}

const specPath = process.argv[2];
if (specPath) {
  process.once(
    'SIGTERM',
    () => void (terminate?.() ?? Promise.resolve()).finally(() => process.exit(143)),
  );
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as AttemptSpec;
  const result = await run(spec);
  await mkdir(dirname(spec.outFile), { recursive: true });
  await writeFile(spec.outFile, JSON.stringify(result, null, 2));
  await rm(specPath, { force: true });
  process.exit(0);
}

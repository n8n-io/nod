import { defaults } from './checks.ts';
import { judgeCriteria, type Llm } from './judge.ts';
import { criteria as productCriteria, standard, tripwires } from './product.ts';
import type { CheckResult } from './results.ts';
import type { Expectation, Scenario, World } from './scenario.ts';
import type { Run } from './trace.ts';

type Judged = Extract<Expectation, { kind: 'judge' }>;

export function productExpectations(definition: Scenario) {
  const explanations = definition.productCriterionExplanations ?? {};
  for (const id of Object.keys(explanations))
    if (!productCriteria.some((item) => item.id === id))
      throw new Error(`Unknown product criterion: ${id}`);
  return (productCriteria as Judged[]).map((item) => ({
    ...item,
    criterion:
      explanations[item.id] === undefined
        ? item.criterion
        : `${item.criterion}\n\n${explanations[item.id]}`,
  }));
}

export async function grade(options: {
  definition: Scenario;
  world: World;
  trace: Run;
  judge: Llm;
  truth: string;
  skipJudges: boolean;
}) {
  const { definition, world, trace, judge, truth } = options;
  const product = productExpectations(definition);
  const checks: CheckResult[] = [];
  const task: Judged[] = [];
  const rescued = new Set<string>();
  let graderFault: string | undefined;
  let judgeFault: string | undefined;
  const shared = definition.completion
    ? [definition.completion(world), ...defaults.slice(1)]
    : defaults;
  for (const expectation of [...shared, ...tripwires, ...definition.expect(world)]) {
    if (expectation.kind === 'judge') {
      task.push(expectation);
      continue;
    }
    try {
      const verdict = await expectation.check(trace);
      if (!verdict.pass && expectation.otherwise && !options.skipJudges) {
        rescued.add(expectation.id);
        task.push({
          id: expectation.id,
          group: expectation.group,
          kind: 'judge',
          required: expectation.required,
          aspect: expectation.aspect,
          failure: expectation.failure,
          criterion: `${expectation.otherwise}${verdict.evidence ? ` A literal code check did not find it (${verdict.evidence}); decide from what was actually said or done.` : ''}`,
        });
        continue;
      }
      checks.push({
        id: expectation.id,
        kind: 'check',
        group: expectation.group ?? 'task',
        aspect: expectation.aspect,
        failure: expectation.failure,
        required: expectation.required,
        ...verdict,
      });
    } catch (error) {
      graderFault = `Check ${expectation.id} failed to run: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!options.skipJudges) {
    for (const [group, list, standardText] of [
      ['task', task, undefined],
      ['product', product, standard],
    ] as const) {
      if (!list.length) continue;
      try {
        const verdicts = await judgeCriteria(judge, {
          standard: standardText,
          task: trace.task,
          transcript: trace.transcript(),
          groundTruth: truth,
          criteria: list,
        });
        for (const verdict of verdicts) {
          const source = list.find((item) => item.id === verdict.id)!;
          const fallback = group === 'task' && rescued.has(verdict.id);
          checks.push({
            id: verdict.id,
            kind: fallback ? 'check' : 'judge',
            group,
            criterion: source.criterion,
            na: (!fallback && verdict.na) || undefined,
            aspect: source.aspect,
            failure: source.failure,
            required: source.required,
            pass: fallback ? verdict.pass && !verdict.na : verdict.pass,
            evidence: verdict.reasoning,
          });
        }
      } catch (error) {
        judgeFault = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return { checks, graderFault, judgeFault };
}

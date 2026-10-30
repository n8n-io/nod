import { createLlm, parseJson, type Llm } from './judge.ts';
import type { AttemptResult, Diagnosis } from './results.ts';
import { clip } from './trace.ts';
import type { Model } from './stack.ts';

const categories = [
  'intent',
  'tool',
  'reasoning',
  'hallucination',
  'overcaution',
  'unsafe',
  'scope',
  'incomplete',
  'format',
];
const blames = ['agent', 'scenario', 'mock', 'harness'];

const prompt = `You analyse why a personal AI assistant failed an automated evaluation, like a careful reviewer who must decide who is at fault.
You get the task, the failed checks with their evidence, the exact end state of the world, and the transcript.
Decide:
- category: what kind of mistake it was: ${categories.join(', ')}.
- blame: "agent" if the assistant behaved wrongly or incompletely for a real user. "scenario" if the check or brief was unfair or ambiguous, or a correct alternative answer was marked wrong. "mock" if a fake app or fake website lacked behaviour a real one has (a missing tool, an unrealistic response) and that caused the failure. "harness" if the evaluation machinery itself misbehaved.
- rootCause: one plain sentence about what went wrong.
- turningPoint: the moment that decided it (a tool call, a message, a decision), quoted briefly.
- fix: one sentence on what to change in the assistant (prompt, tool or runtime) if blame is agent, otherwise what to change in the evaluation.
Be skeptical of blaming the agent: if a reasonable user would have been satisfied, say so and blame the scenario.
Return only JSON: {"category":"...","blame":"...","rootCause":"...","turningPoint":"...","fix":"...","confidence":0.0}`;

async function diagnose(llm: Llm, attempt: AttemptResult): Promise<Diagnosis | undefined> {
  const failed = attempt.checks.filter((check) => !check.pass && check.required);
  if (!failed.length && !attempt.error) return undefined;
  for (let tries = 0; tries < 2; tries++) {
    const text = await llm.complete(
      prompt,
      `Task:\n${attempt.task}\n\nFailed checks:\n${failed.map((check) => `- ${check.id} (${check.failure}): ${check.criterion ? `${check.criterion} ` : ''}${check.evidence ?? ''}`).join('\n') || '(none; the run errored)'}${attempt.error ? `\n\nRun error: ${attempt.error}` : ''}\n\nWorld and ground truth:\n${attempt.groundTruth.slice(0, 9000)}\n\nWhat the assistant finally said:\n${attempt.final.slice(0, 2000)}\n\nTranscript:\n${clip(attempt.transcript, 30000)}`,
      900,
    );
    const parsed = parseJson(text);
    if (parsed && categories.includes(parsed.category) && blames.includes(parsed.blame))
      return {
        category: parsed.category,
        blame: parsed.blame,
        rootCause: String(parsed.rootCause ?? '').slice(0, 400),
        turningPoint: String(parsed.turningPoint ?? '').slice(0, 400),
        fix: String(parsed.fix ?? '').slice(0, 400),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      };
  }
  return undefined;
}

export async function diagnoseAll(model: Model, attempts: AttemptResult[], concurrency = 4) {
  const llm = await createLlm(model);
  const queue = attempts.filter((item) => item.status === 'fail' && !item.diagnosis);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (next < queue.length) {
        const item = queue[next++];
        item.diagnosis = await diagnose(llm, item).catch(() => undefined);
      }
    }),
  );
  return { diagnosed: queue.filter((item) => item.diagnosis).length, costUsd: llm.spent().costUsd };
}

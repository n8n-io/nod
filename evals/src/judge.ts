import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from './stack.ts';

export interface Llm {
  model: Model;
  complete(system: string, input: string, maxTokens?: number): Promise<string>;
  spent(): { tokens: number; costUsd: number | null };
}

const transient =
  /\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|ECONN|ETIMEDOUT|fetch failed|unavailable/i;

export async function createLlm(model: Model): Promise<Llm> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  await runtime.setRuntimeApiKey(model.provider, model.apiKey);
  const resolved = runtime.getModel(model.provider, model.name);
  if (!resolved)
    throw new Error(`${model.provider}/${model.name} is not in the installed Pi catalog.`);
  let tokens = 0;
  let cost = 0;
  let costKnown = false;
  return {
    model,
    spent: () => ({ tokens, costUsd: costKnown ? cost : null }),
    async complete(system, input, maxTokens = 4096) {
      let failure = '';
      for (const delay of [0, 30_000, 90_000]) {
        if (delay) await new Promise((done) => setTimeout(done, delay));
        const reply = await runtime.completeSimple(
          resolved,
          {
            systemPrompt: system,
            messages: [{ role: 'user', content: input, timestamp: Date.now() }],
          },
          { signal: AbortSignal.timeout(180_000), maxTokens },
        );
        tokens += reply.usage?.totalTokens ?? 0;
        if (typeof reply.usage?.cost?.total === 'number') {
          cost += reply.usage.cost.total;
          costKnown = true;
        }
        if (reply.stopReason !== 'error' && reply.stopReason !== 'aborted')
          return reply.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('');
        failure = String((reply as { errorMessage?: string }).errorMessage ?? reply.stopReason);
        if (!transient.test(failure)) break;
      }
      throw new Error(`Model call failed: ${failure}`);
    },
  };
}

export function parseJson(text: string): any {
  const body = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(body.slice(start, body.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

export interface Simulator {
  reply(persona: string, question: string): Promise<string>;
}

export function createSimulator(llm: Llm): Simulator {
  return {
    async reply(persona, question) {
      const text = await llm.complete(
        `You play a person chatting with their personal AI assistant. Reply as that person in one or two short, casual sentences. Use only the facts below, and share a fact only when the assistant's question asks for it; never volunteer extra information. If the question asks for something the facts do not cover, say you have no preference and the assistant should choose sensibly. Never mention that you are a simulation.\n\nFacts about you:\n${persona}`,
        `The assistant says:\n${question}\n\nYour reply:`,
        300,
      );
      return text.trim();
    },
  };
}

export interface JudgeInput {
  standard?: string;
  task: string;
  transcript: string;
  groundTruth: string;
  criteria: Array<{ id: string; criterion: string }>;
}

export interface JudgeVerdict {
  id: string;
  pass: boolean;
  na: boolean;
  reasoning: string;
}

const judgePrompt = `You grade how well a personal AI assistant completed a task, using a transcript of what happened.
For each criterion, decide pass or fail from the evidence. Rules:
- Judge only what is written in the transcript and ground truth. Never assume an action happened because the assistant said so; tool results and the ground truth show what actually happened.
- A correct alternative way of satisfying the criterion passes. A claim without support fails.
- The ground truth block is exact. Do not recount it.
- Write the reasoning first, then the verdict.
- If a criterion cannot apply to this task (for example it is about recovering from an error and nothing went wrong), set "applicable" to false and "pass" to true.
Return only JSON: {"verdicts":[{"id":"<criterion id>","reasoning":"<one or two sentences>","applicable":true|false,"pass":true|false}]}`;

export async function judgeCriteria(llm: Llm, input: JudgeInput): Promise<JudgeVerdict[]> {
  if (!input.criteria.length) return [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await llm.complete(
      judgePrompt,
      `${input.standard ? `Product standard the assistant is held to (its own style guide):\n${input.standard}\n\n` : ''}Task given to the assistant:\n${input.task}\n\nGround truth (exact):\n${input.groundTruth}\n\nTranscript:\n${input.transcript}\n\nCriteria:\n${input.criteria.map((item) => `- ${item.id}: ${item.criterion}`).join('\n')}`,
      4096,
    );
    const parsed = parseJson(text);
    const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
    if (input.criteria.every((item) => verdicts.some((verdict: any) => verdict.id === item.id)))
      return input.criteria.map((item) => {
        const verdict = verdicts.find((entry: any) => entry.id === item.id);
        const na = verdict.applicable === false;
        return {
          id: item.id,
          pass: na || verdict.pass === true,
          na,
          reasoning: String(verdict.reasoning ?? ''),
        };
      });
  }
  throw new Error('The judge did not return a verdict for every criterion.');
}

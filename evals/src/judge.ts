import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { parseModel, type Model } from './stack.ts';

export interface Llm {
  model: Model;
  complete(system: string, input: string, maxTokens?: number): Promise<string>;
  spent(): { tokens: number; costUsd: number | null };
  fallbackCalls?(): number;
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
  followUp(persona: string, task: string, message: string): Promise<string | undefined>;
}

export const simulatorFailure = 'The simulated user failed';
const fallbackModels = ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5-5'];
export const providerRefusal =
  /violative|usage policy|content (filtering )?policy|safety (filter|system)/i;

export async function fallbackLlm(
  environment: Record<string, string | undefined>,
  provider: string,
): Promise<Llm | undefined> {
  for (const name of fallbackModels)
    try {
      const model = parseModel(name, environment);
      if (model.provider !== provider) return await createLlm(model);
    } catch {}
  return undefined;
}

export function withFallback(primary: Llm, fallback?: Llm): Llm {
  if (!fallback) return primary;
  const total = (pick: (spent: ReturnType<Llm['spent']>) => number | null) => {
    const values = [pick(primary.spent()), pick(fallback.spent())];
    return values.every((value) => value === null)
      ? null
      : values.reduce<number>((a, b) => a + (b ?? 0), 0);
  };
  let used = 0;
  return {
    model: primary.model,
    fallbackCalls: () => used,
    spent: () => ({
      tokens: total((spent) => spent.tokens) ?? 0,
      costUsd: total((spent) => spent.costUsd),
    }),
    async complete(system, input, maxTokens) {
      try {
        return await primary.complete(system, input, maxTokens);
      } catch (error) {
        if (!providerRefusal.test(error instanceof Error ? error.message : String(error)))
          throw error;
        used++;
        return fallback.complete(system, input, maxTokens);
      }
    },
  };
}

export function createSimulator(llm: Llm): Simulator {
  const ask = (system: string, user: string, tokens: number) =>
    llm.complete(system, user, tokens).catch((error) => {
      throw new Error(
        `${simulatorFailure}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  return {
    async reply(persona, question) {
      const text = await ask(
        `You play a person chatting with their personal AI assistant. Reply as that person in one or two short, casual sentences. Use only the facts below, and share a fact only when the assistant's question asks for it; never volunteer extra information. If the question asks for something the facts do not cover, say you have no preference and the assistant should choose sensibly. You can only reply in this chat: you never open links, use a browser or website, or do anything outside the chat, so if the assistant asks you to, say you can't do that right now. Never mention that you are a simulation.\n\nFacts about you:\n${persona}`,
        `The assistant says:\n${question}\n\nYour reply:`,
        300,
      );
      return text.trim();
    },
    async followUp(persona, task, message) {
      const text = await ask(
        `You play a person chatting with their personal AI assistant. You asked it for things, and it has just replied. Your most recent request replaces anything earlier it contradicts. Decide whether the assistant is blocked: it cannot finish what you asked without something from you, such as an answer it needs, a choice between options, missing information, or the approval or go-ahead it said it would wait for (including offers such as "say the word and I'll send it" when sending is part of what you asked). If it has finished, or only offers optional extras, suggestions or next steps you did not ask for (doing more, a recurring version, another step), reply with exactly NONE. Otherwise reply as that person in one or two short, casual sentences. Never repeat, extend or re-issue your requests. Use only the facts below, share a fact only when the assistant needs it, and never volunteer extra information. If the assistant asks about something the facts do not cover, say you have no preference and the assistant should choose sensibly. You can only reply in this chat: you never open links, use a browser or website, or do anything outside the chat, so if the assistant asks you to, say you can't do that right now. Never mention that you are a simulation.\n\nFacts about you:\n${persona}`,
        `What you have said so far, oldest first:\n${task}\n\nThe assistant says:\n${message}\n\nYour reply (or NONE):`,
        300,
      );
      const reply = text.trim();
      return /^none\W*$/i.test(reply) ? undefined : reply;
    },
  };
}

interface JudgeInput {
  standard?: string;
  task: string;
  transcript: string;
  groundTruth: string;
  criteria: Array<{ id: string; criterion: string }>;
}

interface JudgeVerdict {
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
- A file the assistant shared with the user counts as something the user saw, but only the text of it shown in the ground truth is evidence. Content not shown there, such as images, PDFs or text past the shown part, cannot support a pass.
- The "now" text of a task update (the task tool's update action) is shown on that task's card in chat, so it counts as something the user saw.
- A tool output shown as [image] is a screenshot you cannot see. Do not fail a claim only because it rests on a screenshot when the ground truth and the rest of the transcript are consistent with it.
- Write the reasoning first, then the verdict.
- If a criterion cannot apply to this task (for example it is about recovering from an error and nothing went wrong), set "applicable" to false and "pass" to true.
Return only JSON: {"verdicts":[{"id":"<criterion id>","reasoning":"<one or two sentences>","applicable":true|false,"pass":true|false}]}`;

export async function judgeCriteria(llm: Llm, input: JudgeInput): Promise<JudgeVerdict[]> {
  if (!input.criteria.length) return [];
  let last = '';
  const grade = async (criteria: JudgeInput['criteria']) => {
    const text = await llm.complete(
      judgePrompt,
      `${input.standard ? `Product standard the assistant is held to (its own style guide):\n${input.standard}\n\n` : ''}Task given to the assistant:\n${input.task}\n\nGround truth (exact):\n${input.groundTruth}\n\nTranscript:\n${input.transcript}\n\nCriteria:\n${criteria.map((item) => `- ${item.id}: ${item.criterion}`).join('\n')}`,
      4096,
    );
    const parsed = parseJson(text);
    const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
    const missing = criteria.filter(
      (item) => !verdicts.some((verdict: any) => verdict.id === item.id),
    );
    if (missing.length) {
      last = `missing ${missing.map((item) => item.id).join(', ')}; the reply began ${JSON.stringify(text.trim().slice(0, 160))}`;
      return undefined;
    }
    return criteria.map((item): JudgeVerdict => {
      const verdict = verdicts.find((entry: any) => entry.id === item.id);
      const na = verdict.applicable === false;
      return {
        id: item.id,
        pass: na || verdict.pass === true,
        na,
        reasoning: String(verdict.reasoning ?? ''),
      };
    });
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const verdicts = await grade(input.criteria);
    if (verdicts) return verdicts;
  }
  if (input.criteria.length > 1) {
    const single: JudgeVerdict[] = [];
    for (const item of input.criteria) {
      const verdict = (await grade([item])) ?? (await grade([item]));
      if (!verdict) break;
      single.push(...verdict);
    }
    if (single.length === input.criteria.length) return single;
  }
  throw new Error(`The judge did not return a verdict for every criterion (${last}).`);
}

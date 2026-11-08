import { createHash } from 'node:crypto';

export type SetupName = 'memory' | 'chat';
export const setupNames: readonly SetupName[] = ['memory', 'chat'];

export interface LongMemEvalItem {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string | number;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
  evidence: boolean;
}

export interface Verdict {
  correct: boolean;
  raw: string;
  costUsd: number;
}

export interface SetupRun {
  setup: SetupName;
  reply: string;
  tools: Array<{ name: string; input: string }>;
  costUsd: number;
  unpricedCalls: number;
  modelCalls: number;
  tokens: number;
  compactions: number;
  seconds: number;
  error?: string;
  turnErrors?: string[];
  contextTokens?: number;
  historyTokens?: number;
  calls?: Array<Record<string, unknown>>;
  verdict?: Verdict;
}

export interface QuestionRun {
  questionId: string;
  type: string;
  abstention: boolean;
  setups?: SetupName[];
  runs: SetupRun[];
  learning?: {
    ticks: number;
    costUsd: number;
    unpricedCalls?: number;
    modelCalls: number;
    notes: number;
    confirmed: number;
    learned: number;
    tentative: number;
    archived: number;
    entries?: string[];
    watermark?: string;
    retries?: number;
  };
  evidenceInRecent?: boolean;
  historyMessages?: number;
  previousCostUsd?: number;
  previousSetupCostsUsd?: Partial<Record<SetupName, number>>;
  previousLearningCostUsd?: number;
  previousUnpricedCalls?: number;
  seconds: number;
  error?: string;
}

export function parseDate(value: string) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w+\) (\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Unreadable LongMemEval date ${value}.`);
  const [, year, month, day, hours, minutes] = match.map(Number);
  return Date.UTC(year, month - 1, day, hours, minutes);
}

export function timeline(item: LongMemEvalItem): HistoryMessage[] {
  const sessions = item.haystack_sessions
    .map((turns, index) => ({ date: item.haystack_dates[index], turns }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const messages: HistoryMessage[] = [];
  let last = -Infinity;
  sessions.forEach((session, index) => {
    const start = parseDate(session.date);
    const next = index + 1 < sessions.length ? parseDate(sessions[index + 1].date) : Infinity;
    const step = Math.min(30_000, (next - start) / (session.turns.length + 1));
    session.turns.forEach((turn, position) => {
      if (turn.role !== 'user' && turn.role !== 'assistant')
        throw new Error(`Unexpected role ${turn.role} in ${item.question_id}.`);
      last = Math.max(start + Math.floor(position * step), last + 1);
      messages.push({ role: turn.role, text: turn.content, at: last, evidence: !!turn.has_answer });
    });
  });
  return messages;
}

export const askText = (item: LongMemEvalItem) =>
  `Current Date: ${item.question_date}\nQuestion: ${item.question}`;

export function stratified<T extends { question_id: string; question_type: string }>(
  items: T[],
  count: number,
) {
  if (count >= items.length) return [...items];
  const rank = (id: string) => createHash('sha256').update(`longmemeval:${id}`).digest('hex');
  const groups = new Map<string, T[]>();
  for (const item of items)
    groups.set(item.question_type, [...(groups.get(item.question_type) ?? []), item]);
  const quotas = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, members]) => {
      const exact = (count * members.length) / items.length;
      return { type, members, quota: Math.floor(exact), remainder: exact - Math.floor(exact) };
    });
  let left = count - quotas.reduce((sum, group) => sum + group.quota, 0);
  for (const group of quotas.toSorted((a, b) => b.remainder - a.remainder)) {
    if (left-- <= 0) break;
    group.quota++;
  }
  return quotas.flatMap((group) =>
    group.members
      .toSorted((a, b) => rank(a.question_id).localeCompare(rank(b.question_id)))
      .slice(0, group.quota),
  );
}

export function judgePrompt(
  task: string,
  question: string,
  answer: string,
  response: string,
  abstention: boolean,
) {
  if (abstention)
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  if (['single-session-user', 'single-session-assistant', 'multi-session'].includes(task))
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === 'temporal-reasoning')
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === 'knowledge-update')
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === 'single-session-preference')
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  throw new Error(`Unknown LongMemEval question type ${task}.`);
}

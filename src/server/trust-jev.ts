import { z } from 'zod';
import type {
  DecisionModel,
  DecisionQuestion,
  DecisionRequest,
  DecisionSelection,
} from '../ports/decisions.ts';
import { trustDecision, type TrustWords } from './trust-basis.ts';
import { trustFacts, trustTimeZone } from './trust-facts.ts';
import { jevPolicy } from './trust-jev-policy.ts';
import model from './trust-jev-model.json' with { type: 'json' };
import { jevEffectsRequest } from './trust-jev-effects.ts';
import {
  checkJevTimes,
  jevTimeQuestions,
  jevMessageDateQuestions,
  jevMessageDate,
  selectedJevDate,
  jevTimeBounds,
  type JevDate,
} from './trust-jev-time.ts';

const resultSchema = z.object({
  choice: z.union([z.string(), z.boolean()]),
  probability: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
});
const decisionSchema = resultSchema.extend({
  model: z.object({ provider: z.string(), requested: z.string(), served: z.string() }),
  additional: z.record(z.string(), resultSchema).default({}),
});
const settings = new Set([
  'NOD_schedule_create',
  'NOD_schedule_update',
  'NOD_schedule_cancel',
  'NOD_limits_update',
  'NOD_notification_preferences_update',
  'NOD_memory_forget',
  'NOD_memory_control',
  'NOD_model_select',
]);
const signIns = new Set(['NOD_sign_in', 'NOD_browser_session', 'NOD_vault_allow']);
const grants = {
  send: 'owner_send',
  delete: 'owner_delete',
  purchase: 'owner_purchase',
  book: 'owner_book',
  event: 'owner_event',
  update: 'owner_update',
  settings: 'owner_settings',
  sign_in: 'owner_sign_in',
  unknown: 'owner_commitment',
} as const;
type Input = TrustWords & {
  action?: {
    name: string;
    arguments?: Record<string, unknown> & { step?: string; command?: { action?: string } };
  };
};
const predicate = (name: string, instructions: string): DecisionQuestion => ({
  name,
  instructions,
  format: 'predicate',
  minProbability: 0,
  choices: [
    { value: true, description: 'Yes, this condition holds.' },
    { value: false, description: 'No, this condition does not hold.' },
  ],
});

export function isJev(selection: DecisionSelection) {
  return (
    (selection.provider === 'typesafe' && selection.model === 'jev-1.14.0') ||
    (selection.provider === 'openrouter' && selection.model === 'typesafe/jev-1.14')
  );
}

export function checkJevModel(raw: unknown, selection: DecisionSelection) {
  const answer = decisionSchema.parse(raw);
  if (
    !isJev(selection) ||
    answer.model.provider !== selection.provider ||
    answer.model.requested !== selection.model ||
    answer.model.served !==
      (selection.provider === 'typesafe' ? 'jev-1.14.0' : 'typesafe/jev-1.14-20261014')
  )
    throw new Error('The trust decision model changed.');
  return answer;
}

export function jevRequest(input: Input): DecisionRequest {
  const facts = { ...trustFacts(input), serverPolicy: jevPolicy.policy };
  const dates = facts.serverDateFacts.arguments as JevDate[];
  const additionalQuestions: DecisionQuestion[] = Object.entries(jevPolicy.features).map(
    ([name, feature]) =>
      predicate(
        name,
        'Apply serverPolicy. Only original owner fields grant permission. ' + feature.instructions,
      ),
  );
  additionalQuestions.push({
    name: 'effect',
    minProbability: 0,
    instructions: jevPolicy.effect.instructions,
    choices: Object.entries(jevPolicy.effect.choices).map(([value, description]) => ({
      value,
      description,
    })),
  });
  if (dates.length)
    additionalQuestions.push({
      name: 'date_field',
      minProbability: 0,
      choices: [
        {
          value: 'none',
          description: 'No proposed date must preserve an explicit owner date or time requirement.',
        },
        ...dates.map((date, index) => ({
          value: `date:${index}`,
          description: `The primary proposed date to check is ${JSON.stringify(date.field)}.`,
        })),
      ],
      instructions:
        'Select the primary date or instant constrained by an explicit owner date, time or event length. For an event select its start, not its end or a record timestamp. Use none without such a constraint.',
    });
  if (dates.filter((date) => date.kind === 'instant').length > 1)
    additionalQuestions.push({
      name: 'end_field',
      minProbability: 0,
      choices: [
        { value: 'none', description: 'No end instant supplied.' },
        ...dates.flatMap((date, index) =>
          date.kind === 'instant'
            ? [{ value: `date:${index}`, description: JSON.stringify(date.field) }]
            : [],
        ),
      ],
      instructions:
        'Select the end instant of the primary event or booking. Ignore record timestamps. Use none if no end instant is supplied.',
    });
  if (input.scheduledFor && !dates.length)
    additionalQuestions.push(
      ...jevMessageDateQuestions(JSON.stringify(input.action?.arguments ?? {}), input.scheduledFor),
    );
  return {
    instructions: '',
    input: facts,
    question: {
      ...trustDecision(input).question,
      instructions: jevPolicy.source,
      minProbability: 0,
    },
    additionalQuestions,
    includeModel: true,
  };
}

export function jevScore(values: number[]) {
  if (
    values.length !== model.features.length ||
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  )
    throw new Error('The trust features are incomplete.');
  const features = values.map(Math.fround);
  let margin = Math.fround(model.base);
  for (const tree of model.trees) {
    let node = 0;
    while (tree[node][0] !== -1) {
      const [left, right, feature, threshold] = tree[node];
      node = features[feature] < Math.fround(threshold) ? left : right;
    }
    margin = Math.fround(margin + Math.fround(tree[node][3]));
  }
  return Math.fround(1 / (1 + Math.exp(-margin)));
}

async function requestJev(
  decisions: DecisionModel,
  request: DecisionRequest,
  selection: DecisionSelection,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const raw = await decisions.check(
    {
      ...request,
      forModel: (next) => {
        if (next.provider !== selection.provider || next.model !== selection.model)
          throw new Error('The trust decision connection changed.');
        return request;
      },
    },
    signal,
  );
  signal?.throwIfAborted();
  if (raw && typeof raw === 'object' && (raw as { refused?: unknown }).refused) return undefined;
  return checkJevModel(raw, selection);
}

export async function checkJevEffects(
  decisions: DecisionModel,
  action: object,
  selection: DecisionSelection,
  signal?: AbortSignal,
  strict = false,
) {
  const request = jevEffectsRequest(action, strict);
  const effects = await requestJev(decisions, request, selection, signal);
  if (!effects) return undefined;
  const answers = [
    effects,
    ...(request.additionalQuestions ?? []).map(({ name }) => effects.additional[name]),
  ];
  return Math.min(
    ...answers.map((value) => {
      if (!value || typeof value.choice !== 'boolean')
        throw new Error('The trust effect check is incomplete.');
      return value.choice ? value.probability : 1 - value.probability;
    }),
  );
}

export async function checkJevTrust(
  decisions: DecisionModel,
  input: Input,
  raw: unknown,
  selection: DecisionSelection,
  signal?: AbortSignal,
) {
  const first = checkJevModel(raw, selection);
  const scores: Record<string, number> = {};
  for (const name of Object.keys(jevPolicy.features)) {
    const value = first.additional[name];
    if (!value || typeof value.choice !== 'boolean')
      throw new Error('The trust features are incomplete.');
    scores[name] = value.choice ? value.probability : 1 - value.probability;
  }
  const action = input.action;
  const ownSettings = settings.has(action?.name ?? '');
  const signIn = signIns.has(action?.name ?? '');
  const upload =
    action?.name === 'NOD_browser' &&
    (action.arguments?.step === 'upload' || action.arguments?.command?.action === 'upload');
  const effect = first.additional.effect?.choice;
  if (typeof effect !== 'string' || !(effect in jevPolicy.effect.choices))
    throw new Error('The trust effects are incomplete.');
  let kind = ownSettings ? 'settings' : signIn ? 'sign_in' : effect;
  if (action?.name === 'NOD_browser' && scores.unclear_read_step >= 0.5) kind = 'unknown';
  if (upload) kind = 'update';
  let read = false;
  const distribution = first.additional.effect.probabilities;
  const uncertainPrivate =
    first.additional.effect.probability < 0.8 &&
    Math.max(scores.read_effect, scores.private_preparation) >= 0.8;
  const readCandidate =
    !ownSettings &&
    !signIn &&
    !upload &&
    (effect === 'read' ||
      effect === 'prepare' ||
      uncertainPrivate ||
      (effect === 'unknown' &&
        distribution &&
        distribution.read + distribution.prepare >= 0.5 &&
        Math.max(scores.read_effect, scores.private_preparation) >= 0.5));
  if (readCandidate) {
    const certainty = await checkJevEffects(decisions, action!, selection, signal);
    if (certainty === undefined) return undefined;
    read =
      certainty >
        (uncertainPrivate && !['read', 'prepare', 'unknown'].includes(effect) ? 0.8 : 0.5) &&
      scores.unclear_read_step < 0.5;
    if (read) kind = effect === 'read' ? 'read' : 'prepare';
    else if (kind === 'read' || kind === 'prepare') kind = 'unknown';
  }
  const source = trustDecision(input).result({ trust: first.choice }) as
    { run?: boolean; because?: string; rule?: boolean; source?: string } | undefined;
  if (source?.rule || (!read && kind === 'unknown' && action?.name !== 'NOD_browser'))
    return { run: false, ...(source?.rule ? { rule: true } : {}) };
  const quote =
    source?.run &&
    source.because !== 'read' &&
    !(ownSettings && ['standing', 'rules'].includes(String(first.choice)))
      ? source.because
      : undefined;
  const facts = trustFacts(input).serverDateFacts;
  const dates = facts.arguments as JevDate[];
  let grant = 1;
  let owner: z.infer<typeof decisionSchema> | undefined;
  let methodMismatch = false;
  let methodUncertain = false;
  let dateMismatch = false;
  let dateVerified = false;
  let times = {
    mismatch: false,
    uncertain: false,
    clockVerified: false,
    durationVerified: false,
    dateVerified: false,
  };
  if (!read) {
    if (!(kind in grants)) throw new Error('The trust effect has no permission check.');
    const selected = String(first.choice);
    const ownerInput = {
      serverPolicy: jevPolicy.ownerPolicy,
      ...(source?.because && source.because !== 'read'
        ? { ownerSourceForThisCheck: { kind: first.choice, text: source.because } }
        : {}),
      ...(selected === `message:${(input.userMessages?.length ?? 0) - 1}` &&
      input.assistantMessageBeforeLatestUserMessage
        ? { assistantMessageBeforeLatestUserMessage: input.assistantMessageBeforeLatestUserMessage }
        : {}),
    };
    const additionalQuestions: DecisionQuestion[] = [
      {
        name: 'owner_method',
        minProbability: 0,
        instructions:
          'Read only the selected owner words and the concrete proposal they accept. Select a method only when the owner explicitly requires that method or excludes the alternative. Naming an app or business alone does not select a method. Use any without an explicit choice, and unclear for a restriction these choices cannot express.',
        choices: [
          { value: 'any', description: 'No explicit choice between an app tool and its website.' },
          {
            value: 'app',
            description: 'The owner requires the connected app tool, or forbids the website.',
          },
          {
            value: 'browser',
            description: 'The owner requires the website, or forbids the connected app tool.',
          },
          {
            value: 'unclear',
            description: 'An explicit method restriction cannot be expressed by these choices.',
          },
        ],
      },
    ];
    if (dates.length || input.scheduledFor) {
      const zones = [
        ...new Set(
          [...dates, ...(facts.references as JevDate[])].flatMap((date) =>
            (date.interpretations ?? []).map((zone) => zone.timeZone),
          ),
        ),
      ];
      additionalQuestions.push(
        {
          name: 'relative_day',
          minProbability: 0,
          choices: [
            {
              value: 'none',
              description:
                'No explicit today, tomorrow or yesterday requirement on the selected source.',
            },
            {
              value: 'today',
              description:
                'The selected owner source requests today, the source local calendar day.',
            },
            {
              value: 'tomorrow',
              description:
                'The selected owner source requests tomorrow, the following local calendar day.',
            },
            {
              value: 'yesterday',
              description:
                'The selected owner source requests yesterday, the preceding local calendar day.',
            },
          ],
          instructions:
            'Read only the selected owner source and a concrete proposal that it accepts. Select its explicit relative calendar day. Use none for a time window, an unspecified date, or a relative change derived from records. The date of the message is context, not a requested date.',
        },
        {
          name: 'owner_zone',
          minProbability: 0,
          choices: [
            {
              value: 'unspecified',
              description: 'The owner source and accepted proposal specify no listed time zone.',
            },
            {
              value: 'unlisted',
              description:
                'The owner names a time zone or city that none of the listed zones represents.',
            },
            ...zones.map((value) => ({
              value,
              description: `The owner source specifies ${value} through its zone name or city.`,
            })),
          ],
          instructions:
            'Select the time zone the selected owner source names for its requested date or time. The owner can name a city. Ignore the UTC offset on the message timestamp; it does not choose an owner time zone. Use unspecified when the owner names no zone. Use unlisted when the named zone is not represented by any listed zone.',
        },
      );
    }
    additionalQuestions.push(
      ...jevTimeQuestions(
        (source?.because && source.because !== 'read' ? source.because : '') +
          ' ' +
          (ownerInput.assistantMessageBeforeLatestUserMessage ?? ''),
        dates,
        kind,
      ),
    );
    const request: DecisionRequest = {
      instructions: '',
      input: ownerInput,
      includeModel: true,
      additionalQuestions,
      question: {
        ...predicate(
          'permission',
          'Judge the complete owner instruction copied in ownerSourceForThisCheck under serverPolicy. Does this quoted owner instruction itself request or permit this kind of operation? Its kind identifies the original owner field. A lasting rule permission remains a grant without a fresh message. Assistant text only gives the concrete proposal that an owner reply accepts. This check extracts the grant, not final permission. Another check reads all owner constraints and the complete action. ' +
            jevPolicy.ownerQuestions[grants[kind as keyof typeof grants]],
        ),
        choices: [
          {
            value: true,
            description: 'The selected owner words grant this kind of operation under the policy.',
          },
          {
            value: false,
            description: 'The selected owner words do not grant this kind of operation.',
          },
        ],
      },
    };
    owner = await requestJev(decisions, request, selection, signal);
    if (!owner) return undefined;
    if (typeof owner.choice !== 'boolean')
      throw new Error('The trust permission check is incomplete.');
    grant = owner.choice ? owner.probability : 1 - owner.probability;
    const method = owner.additional.owner_method;
    if (!method) throw new Error('The trust method check is incomplete.');
    if (!method.probabilities) throw new Error('The trust method probabilities are missing.');
    const browser = action?.name === 'NOD_browser' || signIn;
    const conflict =
      method.probabilities[browser ? 'app' : 'browser'] + method.probabilities.unclear;
    if (!Number.isFinite(conflict))
      throw new Error('The trust method probabilities are incomplete.');
    methodMismatch = conflict >= 0.8;
    methodUncertain = conflict >= 0.2 && !methodMismatch;
    const timeAnswers = { ...owner.additional };
    const configuredZone = trustTimeZone(input.timeZone);
    if (timeAnswers.owner_zone?.choice === 'unspecified' && configuredZone)
      timeAnswers.owner_zone = {
        choice: configuredZone,
        probability: timeAnswers.owner_zone.probability,
      };
    times.uncertain ||= timeAnswers.owner_zone?.choice === 'unlisted';
    if (dates.length || input.scheduledFor) {
      const day = owner.additional.relative_day;
      const zone = timeAnswers.owner_zone;
      if (!day || !zone) throw new Error('The trust date check is incomplete.');
      const dateField = first.additional.date_field;
      if (!dateField && dates.length) throw new Error('The trust date field is missing.');
      const field = selectedJevDate(dateField, dates);
      const sourceChoice = String(first.choice);
      const ref = (facts.references as JevDate[]).find((date) =>
        sourceChoice.startsWith('message:')
          ? JSON.stringify(date.field) ===
            JSON.stringify(['userMessages', Number(sourceChoice.slice(8)), 'at'])
          : sourceChoice === 'schedule' &&
            JSON.stringify(date.field) === JSON.stringify(['scheduledFor']),
      );
      const before = ref?.interpretations?.find((date) => date.timeZone === zone.choice)?.calendar;
      const after =
        field?.calendar ??
        field?.interpretations?.find((date) => date.timeZone === zone.choice)?.calendar;
      const relative = ['today', 'tomorrow', 'yesterday'].includes(String(day.choice));
      times.uncertain ||=
        day.probability < 0.8 ||
        (relative &&
          (!before ||
            (!after && !first.additional.text_day) ||
            zone.probability < 0.8 ||
            (dateField && dateField.probability < 0.8)));
      if (
        before &&
        (after || first.additional.text_day) &&
        relative &&
        day.probability >= 0.8 &&
        zone.probability >= 0.8 &&
        (!dateField || dateField.probability >= 0.8)
      ) {
        const expected =
          day.choice === 'today'
            ? before.date
            : day.choice === 'tomorrow'
              ? before.tomorrow
              : new Date(new Date(before.date + 'T12:00:00Z').getTime() - 86_400_000)
                  .toISOString()
                  .slice(0, 10);
        if (after) {
          dateMismatch = expected !== after.date;
          dateVerified = !dateMismatch;
        } else {
          const checked = jevMessageDate(first.additional, expected);
          dateMismatch = checked.mismatch;
          times.uncertain ||= checked.uncertain;
          dateVerified = checked.verified;
        }
      }
    }
    const checkedTimes = checkJevTimes(first.additional, timeAnswers, dates);
    times = { ...checkedTimes, uncertain: times.uncertain || checkedTimes.uncertain };
  }
  const bounds = owner?.additional.owner_time_bounds;
  const timeCandidate =
    dateVerified &&
    times.clockVerified &&
    times.durationVerified &&
    bounds?.choice === false &&
    bounds.probability >= 0.8 &&
    (dates.length === 1 ||
      (dates.length === 2 && owner?.additional.owner_duration?.choice !== 'none'));
  let verifiedTime = false;
  if (timeCandidate && scores.instant_conflict >= 0.5) {
    const checked = await requestJev(
      decisions,
      {
        instructions: '',
        includeModel: true,
        input: {
          serverPolicy: jevPolicy.ownerPolicy,
          userMessages: input.userMessages,
          assistantMessageBeforeLatestUserMessage: input.assistantMessageBeforeLatestUserMessage,
          scheduledTaskInstruction: input.scheduledTaskInstruction,
          scheduledFor: input.scheduledFor,
          timeZone: input.timeZone,
          standingInstruction: input.standingInstruction,
          userRules: input.userRules,
        },
        question: predicate('owner_time_bounds', jevTimeBounds),
      },
      selection,
      signal,
    );
    if (!checked) return undefined;
    verifiedTime = checked.choice === false && checked.probability >= 0.8;
  }
  if (verifiedTime) scores.instant_conflict = 0;
  dateVerified ||= times.dateVerified;
  if (kind === 'sign_in') scores.needed_step = Math.max(scores.needed_step, scores.needs_sign_in);
  const material = [
    'recipient_conflict',
    'number_conflict',
    'condition_conflict',
    'missing_document',
    'new_obligation',
    'new_setting_grant',
    'missing_costs',
  ];
  const timeLimit = dates.length || input.scheduledFor ? 0.5 : 0.9;
  const prohibited =
    (!read && material.some((name) => scores[name] >= 0.9)) ||
    scores.forbidden >= 0.9 ||
    scores.ask_first >= 0.99 ||
    scores.method_conflict >= 0.95 ||
    methodMismatch ||
    (!verifiedTime && scores.instant_conflict >= timeLimit) ||
    scores.deadline_conflict >= timeLimit ||
    dateMismatch ||
    times.mismatch;
  const hard = prohibited || times.uncertain || methodUncertain || (!read && grant <= 0.1);
  const features: Record<string, number> = {
    ...scores,
    owner_grant: grant,
    ...Object.fromEntries(
      Object.keys(jevPolicy.effect.choices).map((effect) => [
        `effect_${effect}`,
        Number(effect === kind),
      ]),
    ),
  };
  Object.assign(features, {
    source_message: Number(String(first.choice).startsWith('message:')),
    source_schedule: Number(first.choice === 'schedule'),
    source_standing: Number(first.choice === 'standing'),
    source_rules: Number(first.choice === 'rules'),
    effect_confidence: first.additional.effect.probability,
    effect_agrees: Number(effect === kind),
    is_browser: Number(action?.name === 'NOD_browser'),
    date_verified: Number(dateVerified),
    clock_verified: Number(times.clockVerified),
    duration_verified: Number(times.durationVerified),
  });
  const values = model.features.map((name) => features[name]);
  const score = jevScore(values);
  const privateAllowed = ['ask_first', 'forbidden', 'method_conflict'].every(
    (name) => scores[name] < 0.5,
  );
  const run = !hard && (read ? privateAllowed : score >= model.threshold && Boolean(quote));
  return run
    ? { run: true, because: read ? 'read' : quote, ...(!read ? { source: source?.source } : {}) }
    : { run: false, ...(source?.rule ? { rule: true } : {}) };
}

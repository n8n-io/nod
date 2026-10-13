import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { BrowserPage, CardEntry, CardFields } from '../ports/computer.ts';
import type {
  VaultActivityEntry,
  VaultActivityReason,
  VaultPaymentCard,
  PaymentRequest,
} from '../shared/contracts.ts';
import { logFailure } from './failure-log.ts';
import { type createVaultUses, VaultUseError } from './vault-use.ts';
import type { TurnRef } from './thread.ts';
import { browserOf } from './turn-chain.ts';
import type { PaymentPolicy } from './trust.ts';
import { credentialOrigin } from './vault.ts';

export class PaymentError extends Error {}

type Row = {
  id: string;
  thread_id: string;
  browser_id: string | null;
  turn_id: string;
  origin: string;
  amount_minor: string;
  currency: string;
  card_id: string;
  card_version: string;
  fields: CardFields;
  document: string;
  destinations: Partial<Record<keyof CardFields, string>>;
  submit_selector: string | null;
  keep_notice: boolean;
};

const selector = z.string().min(1).max(500);
const locale = z
  .string()
  .min(1)
  .max(35)
  .refine((value) => {
    try {
      return Intl.getCanonicalLocales(value).length === 1;
    } catch {
      return false;
    }
  });
const expiryField = z.union([
  selector,
  z.object({ selector, format: z.string().min(1).max(100), locale: locale.optional() }).strict(),
]);
const input = z
  .object({
    amount: z.string().regex(/^\d{1,9}(?:\.\d{1,3})?$/),
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    card: z.string().trim().max(100).optional(),
    submitSelector: selector.optional(),
    fields: z
      .object({
        number: selector,
        expiry: expiryField.optional(),
        expiryMonth: expiryField.optional(),
        expiryYear: expiryField.optional(),
        securityCode: selector.optional(),
        name: selector.optional(),
      })
      .strict()
      .refine((fields) => fields.expiry || (fields.expiryMonth && fields.expiryYear), {
        message: 'Pass the expiry field, or the month and year fields.',
      }),
  })
  .strict();

const currencies = new Set(Intl.supportedValuesOf('currency'));
const currentTurnSql = `u.status IN ('running','waiting') AND (u.background OR NOT EXISTS(
  SELECT 1 FROM turns newer WHERE newer.owner_id=u.owner_id AND newer.thread_id=u.thread_id
    AND newer.id<>u.id AND NOT newer.background AND newer.source='user'
    AND newer.created_at>=u.created_at))`;

function digits(currency: string) {
  if (!currencies.has(currency))
    throw new PaymentError('Use a three-letter currency code, such as EUR.');
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits!;
}

export function formatAmount(minor: number, currency: string) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(
    minor / 10 ** digits(currency),
  );
}

export async function createPayments(
  pool: Pool,
  options: {
    ownerId: string;
    uses: Awaited<ReturnType<typeof createVaultUses>>;
    local: boolean;
    policy(turn: TurnRef): Promise<PaymentPolicy>;
    page(threadId: string): Promise<BrowserPage>;
    destinations(
      threadId: string,
      fields: CardFields,
    ): Promise<{ document: string; destinations: Partial<Record<keyof CardFields, string>> }>;
    capture(threadId: string): Promise<Uint8Array>;
    cards(): Promise<VaultPaymentCard[]>;
    card(id: string, version: string, client: PoolClient): Promise<CardEntry['card']>;
    remember(id: string, on: boolean): Promise<unknown>;
    keepCode(id: string, code: string, version: string): Promise<unknown>;
    fill(input: CardEntry): Promise<void>;
    resume(turnId: string, prompt: string, client?: PoolClient): Promise<void>;
    record(
      turn: TurnRef,
      entry: {
        action: VaultActivityEntry['action'];
        origin: string;
        reason: VaultActivityReason;
        itemId?: string;
        itemKind: 'card';
        payment?: { id: string; minor: number; currency: string };
      },
      client?: PoolClient,
    ): Promise<void>;
  },
) {
  const { ownerId, uses } = options;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_payments (
      id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid NOT NULL, turn_id uuid NOT NULL,
      origin text NOT NULL, amount_minor bigint NOT NULL, currency text NOT NULL, card_id text NOT NULL,
      fields jsonb NOT NULL, document text NOT NULL, destinations jsonb NOT NULL,
      keep_notice boolean NOT NULL, status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
    );
    ALTER TABLE vault_payments DROP COLUMN IF EXISTS flagged;
    ALTER TABLE vault_payments ADD COLUMN IF NOT EXISTS submit_selector text;
    ALTER TABLE vault_payments ADD COLUMN IF NOT EXISTS card_version text;
    ALTER TABLE vault_payments ADD COLUMN IF NOT EXISTS browser_id text;
    CREATE INDEX IF NOT EXISTS vault_payments_owner ON vault_payments(owner_id,created_at DESC);
    DELETE FROM vault_payments WHERE created_at<now()-interval '90 days';
  `);
  await pool.query(
    "UPDATE vault_payments SET status='superseded' WHERE owner_id=$1 AND status='pending' AND card_version IS NULL",
    [ownerId],
  );

  await pool.query(
    `INSERT INTO vault_uses(id,owner_id,thread_id,turn_id,origin,kind,item_id,status)
    SELECT id::text,owner_id,thread_id,turn_id,origin,'card',card_id,
      CASE WHEN status='entered' THEN 'submitted' ELSE 'uncertain' END
    FROM vault_payments WHERE owner_id=$1 AND status IN ('entered','approved','entering','uncertain') ON CONFLICT DO NOTHING`,
    [ownerId],
  );
  await pool.query(
    "UPDATE vault_payments SET status='consumed' WHERE owner_id=$1 AND status IN ('entered','approved','entering','uncertain')",
    [ownerId],
  );
  const site = (origin: string) => new URL(origin).host;
  const money = (row: Pick<Row, 'amount_minor' | 'currency'>) =>
    formatAmount(Number(row.amount_minor), row.currency);
  const cardName = (card: Pick<VaultPaymentCard, 'brand' | 'last4'>) =>
    `${card.brand} ••${card.last4}`;
  const payment = (row: Row) => ({
    id: row.id,
    minor: Number(row.amount_minor),
    currency: row.currency,
  });

  const record = options.record;

  async function choose(hint?: string) {
    const cards = await options.cards();
    if (!cards.length)
      throw new PaymentError(
        'Ask the owner to open Otto on desktop and [add a card in Vault](/vault?add=card), then tell you to continue. Do not ask for card details in chat.',
      );
    const named = hint?.toLowerCase();
    const matches = named
      ? cards.filter(
          (card) =>
            card.id === named ||
            card.last4 === named.replace(/\D/g, '') ||
            card.label.toLowerCase().includes(named),
        )
      : cards;
    if (matches.length === 1) return matches[0]!;
    throw new PaymentError(
      `Ask the owner which card to use: ${cards.map((item) => `${item.label} (${cardName(item)})`).join(', ')}. Then call again with card.`,
    );
  }

  async function enter(row: Row, card: VaultPaymentCard, securityCode?: string, resume = false) {
    let value: CardEntry['card'];
    const message = `Otto entered ${cardName(card)} for ${money(row)} at ${site(row.origin)}. Otto submitted the checkout. Check whether the shop accepted the payment. Do not submit it again.`;
    await uses.run(
      {
        id: row.id,
        ownerId,
        threadId: row.thread_id,
        turnId: row.turn_id,
        origin: row.origin,
        kind: 'card',
        itemId: card.id,
      },
      {
        prepare: async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `thread:${ownerId}`,
          ]);
          const active = await client.query(
            `SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id
             WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3 AND th.archived_at IS NULL
               AND ${currentTurnSql} FOR NO KEY UPDATE OF u`,
            [row.turn_id, ownerId, row.thread_id],
          );
          if (!active.rowCount) throw new PaymentError('This payment task is no longer active.');
          const claimed = await client.query(
            "UPDATE vault_payments SET status='consumed' WHERE id=$1 AND owner_id=$2 AND status='pending' AND expires_at>now() RETURNING id",
            [row.id, ownerId],
          );
          if (!claimed.rowCount) throw new PaymentError('This payment request is no longer open.');
          value = await options.card(row.card_id, row.card_version, client);
        },
        perform: async () => {
          await options.fill({
            threadId: row.browser_id ?? row.thread_id,
            fields: row.fields,
            document: row.document,
            destinations: row.destinations,
            submitSelector: row.submit_selector ?? undefined,
            card: { ...value, ...(securityCode ? { securityCode } : {}) },
          });
          if (securityCode && row.keep_notice && card.choice === true)
            await options
              .keepCode(card.id, securityCode, row.card_version)
              .catch((error: unknown) => {
                logFailure('vault_payment_choice_failed', error);
              });
        },
        complete: async (client) => {
          await record(
            { threadId: row.thread_id, turnId: row.turn_id },
            {
              action: 'card',
              origin: row.origin,
              reason: securityCode ? 'code_typed' : 'said_yes',
              itemId: card.id,
              itemKind: 'card',
              payment: payment(row),
            },
            client,
          );
          if (securityCode || resume) {
            await options.resume(
              row.turn_id,
              `${message} Do not repeat completed external actions.`,
              client,
            );
          }
        },
      },
    );
    return message;
  }

  async function fail(row: Row, error: unknown) {
    if (!(error instanceof VaultUseError) || error.statusCode !== 502)
      return 'This payment request is no longer open. Check the order or payment state before a new attempt.';
    await record(
      { threadId: row.thread_id, turnId: row.turn_id },
      {
        action: 'uncertain',
        origin: row.origin,
        reason: 'payment',
        itemId: row.card_id,
        itemKind: 'card',
        payment: payment(row),
      },
    );
    return `The private payment operation did not finish. Card details or the payment may have reached ${site(row.origin)}. Check the order and payment status. Do not repeat this operation.`;
  }

  async function open(id: string, scope: { threadId?: string; turnId?: string }) {
    return (
      await pool.query<Row>(
        `SELECT p.* FROM vault_payments p JOIN turns u ON u.id=p.turn_id AND u.owner_id=p.owner_id
         JOIN threads th ON th.id=p.thread_id AND th.owner_id=p.owner_id
         WHERE p.id=$1 AND p.owner_id=$2 AND th.archived_at IS NULL AND ${currentTurnSql}
         AND ($3::uuid IS NULL OR p.thread_id=$3) AND ($4::uuid IS NULL OR p.turn_id=$4)
         AND p.status='pending' AND p.expires_at>now()`,
        [id, ownerId, scope.threadId ?? null, scope.turnId ?? null],
      )
    ).rows[0];
  }

  async function request(
    turn: TurnRef,
    raw: unknown,
  ): Promise<{ question: string; image: Uint8Array; paymentId?: string; url?: string }> {
    const parsed = input.parse(raw);
    if (!options.local)
      throw new PaymentError(
        'Hosted Otto does not pay with saved cards. Tell the owner to pay on the site themselves.',
      );
    const policy = await options.policy(turn);
    const origin = credentialOrigin((await options.page(browserOf(turn))).origin);
    if (!policy.allowed) {
      await record(turn, { action: 'held', origin, reason: policy.reason, itemKind: 'card' });
      throw new PaymentError('This turn can only read. Do not pay.');
    }
    const currency = parsed.currency.toUpperCase();
    const [whole, fraction = ''] = parsed.amount.split('.');
    const places = digits(currency);
    if (fraction.length > places) throw new PaymentError('Check the amount for this currency.');
    const minor = Number(whole) * 10 ** places + Number(fraction.padEnd(places, '0') || '0');
    if (!minor) throw new PaymentError('Check the amount.');
    const card = await choose(parsed.card);
    const { document, destinations } = await options.destinations(browserOf(turn), parsed.fields);
    for (const destination of Object.values(destinations)) credentialOrigin(destination);
    const image = await options.capture(browserOf(turn));
    const row: Row = {
      id: randomUUID(),
      thread_id: turn.threadId,
      browser_id: browserOf(turn),
      turn_id: turn.turnId,
      origin,
      amount_minor: String(minor),
      currency,
      card_id: card.id,
      card_version: card.version,
      fields: parsed.fields,
      document,
      destinations,
      submit_selector: parsed.submitSelector ?? null,
      keep_notice: card.choice === true && !card.doItForMe,
    };
    await pool.query(
      `UPDATE vault_payments SET status='superseded' WHERE owner_id=$1 AND thread_id=$2 AND turn_id=$3
       AND status='pending'`,
      [ownerId, turn.threadId, turn.turnId],
    );
    await pool.query(
      `INSERT INTO vault_payments(id,owner_id,thread_id,turn_id,origin,amount_minor,currency,card_id,fields,document,destinations,keep_notice,submit_selector,card_version,browser_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now()+interval '10 minutes')`,
      [
        row.id,
        ownerId,
        row.thread_id,
        row.turn_id,
        origin,
        minor,
        currency,
        card.id,
        JSON.stringify(row.fields),
        document,
        JSON.stringify(destinations),
        row.keep_notice,
        row.submit_selector,
        row.card_version,
        row.browser_id,
      ],
    );
    await record(turn, {
      action: 'asked',
      origin,
      reason: 'payment',
      itemKind: 'card',
      itemId: card.id,
      payment: payment(row),
    });
    const elsewhere = [...new Set(Object.values(destinations))]
      .filter((item) => item !== origin)
      .map(site);
    const question = [
      `Pay ${money(row)} at ${site(origin)} with ${cardName(card)}?`,
      elsewhere.length ? `Card details go to ${elsewhere.join(' and ')}.` : '',
    ];
    if (!policy.inOtto)
      return {
        image,
        question: question.filter(Boolean).join(' '),
        url: `/payments/${row.id}`,
      };
    if (card.doItForMe)
      return { paymentId: row.id, question: question.filter(Boolean).join(' '), image };
    return {
      image,
      question: [
        ...question,
        'Reply with its security code.',
        row.keep_notice ? 'Otto will keep it, so next time a yes is enough.' : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  async function approve(context: { threadId: string; turnId: string }, raw: unknown) {
    const { paymentId } = z.object({ paymentId: z.uuid() }).strict().parse(raw);
    const row = await open(paymentId, { threadId: context.threadId });
    const card = (await options.cards()).find((item) => item.id === row?.card_id);
    if (!row || !card?.doItForMe)
      return {
        entered: false,
        message:
          'This payment request is no longer open. Check the order or payment state before a new attempt.',
      };
    try {
      return { entered: true, message: await enter(row, card) };
    } catch (error) {
      return { entered: false, message: await fail(row, error) };
    }
  }

  async function submitCode(turnId: string, code: string, paymentId: string) {
    const row = await open(paymentId, { turnId });
    const card = (await options.cards()).find((item) => item.id === row?.card_id);
    if (!row || !card) return { status: 'unavailable' as const };
    try {
      await enter(row, card, code);
    } catch (error) {
      if (error instanceof VaultUseError && error.statusCode === 502)
        await options.resume(row.turn_id, await fail(row, error));
      return { status: 'unavailable' as const };
    }
    return { status: 'submitted' as const };
  }

  async function requestSetting(turn: TurnRef, raw: unknown) {
    const parsed = z
      .object({ card: z.string().trim().max(100).optional(), doItForMe: z.boolean() })
      .strict()
      .parse(raw);
    if (!options.local) throw new PaymentError('Hosted Otto does not pay with saved cards.');
    const policy = await options.policy(turn);
    if (!policy.allowed || (parsed.doItForMe && !policy.inOtto))
      throw new PaymentError('Do it for me can be turned on only from a message in the Otto app.');
    const card = await choose(parsed.card);
    return {
      args: { card: card.id, doItForMe: parsed.doItForMe },
      question: parsed.doItForMe
        ? `Let Otto keep the security code for ${cardName(card)}, so a yes in Otto is enough for future payments?`
        : `Turn off Do it for me for ${cardName(card)} and delete its saved security code?`,
    };
  }

  async function setting(turn: TurnRef, raw: unknown, approved = false) {
    if (!approved) throw new PaymentError('This saved permission needs the owner’s confirmation.');
    const { args } = await requestSetting(turn, raw);
    const card = await choose(args.card);
    await options.remember(card.id, args.doItForMe);
    return args.doItForMe
      ? `Do it for me is on for ${cardName(card)}. Otto keeps its security code at the next payment.`
      : `Do it for me is off for ${cardName(card)}. Otto deleted its security code.`;
  }

  function registerRoutes(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>('/api/payment-requests/:id', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!z.uuid().safeParse(request.params.id).success)
        return reply.code(404).send({ error: 'This payment request is unavailable.' });
      const row = await open(request.params.id, {});
      const card = (await options.cards()).find((item) => item.id === row?.card_id);
      if (!row || !card || card.version !== row.card_version)
        return reply.code(409).send({ error: 'This payment request is no longer open.' });
      return {
        origin: row.origin,
        amount: money(row),
        card: cardName(card),
        destinations: [...new Set(Object.values(row.destinations))],
        needsCode: !card.doItForMe,
        keepCode: row.keep_notice,
      } satisfies PaymentRequest;
    });
    app.post<{ Params: { id: string } }>(
      '/api/payment-requests/:id',
      { bodyLimit: 1024 },
      async (request, reply) => {
        const parsed = z
          .object({
            code: z
              .string()
              .regex(/^\d{3,4}$/)
              .optional(),
          })
          .strict()
          .safeParse(request.body);
        if (!parsed.success || !z.uuid().safeParse(request.params.id).success)
          return reply.code(400).send({ error: 'Check the payment fields.' });
        const { code } = parsed.data;
        const row = await open(request.params.id, {});
        const card = (await options.cards()).find((item) => item.id === row?.card_id);
        if (!row || !card || (!card.doItForMe && !code))
          return reply.code(409).send({ error: 'This payment needs a fresh secure request.' });
        try {
          await enter(row, card, code, true);
          return { ok: true };
        } catch (error) {
          const message = await fail(row, error);
          if (error instanceof VaultUseError && error.statusCode === 502)
            await options.resume(row.turn_id, message);
          return reply.code(409).send({ error: message });
        }
      },
    );
  }

  return { request, approve, submitCode, requestSetting, setting, registerRoutes };
}

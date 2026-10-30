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
import { captureSecureEntry, type createVaultUses, VaultUseError } from './vault-use.ts';
import type { CaptureAnalytics } from './analytics.ts';
import type { TurnRef } from './thread.ts';
import { browserOf, supersededSql } from './turn-chain.ts';
import { credentialOrigin } from './vault.ts';
import { lockKey, locksTable } from './locks.ts';

class PaymentError extends Error {}

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
const currentTurnSql = `u.status IN ('running','waiting') AND NOT ${supersededSql('u', "newer.source='user' AND newer.created_at>=u.created_at")}`;

function digits(currency: string) {
  if (!currencies.has(currency))
    throw new PaymentError('Use a three-letter currency code, such as EUR.');
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits!;
}

function formatAmount(minor: number, currency: string) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(
    minor / 10 ** digits(currency),
  );
}

export async function createPayments(
  pool: Pool,
  options: {
    ownerId: string;
    analytics?: CaptureAnalytics;
    uses: Awaited<ReturnType<typeof createVaultUses>>;
    present(turn: TurnRef, input: { kind: string; [key: string]: unknown }): Promise<string>;
    page(threadId: string): Promise<BrowserPage>;
    destinations(
      threadId: string,
      fields: CardFields,
    ): Promise<{ document: string; destinations: Partial<Record<keyof CardFields, string>> }>;
    capture(threadId: string): Promise<Uint8Array>;
    cards(): Promise<VaultPaymentCard[]>;
    card(id: string, version: string, client: PoolClient): Promise<CardEntry['card']>;
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
    ${locksTable};
    CREATE TABLE IF NOT EXISTS vault_payments (
      id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid NOT NULL, turn_id uuid NOT NULL,
      origin text NOT NULL, amount_minor bigint NOT NULL, currency text NOT NULL, card_id text NOT NULL,
      fields jsonb NOT NULL, document text NOT NULL, destinations jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE vault_payments ADD COLUMN IF NOT EXISTS submit_selector text;
    ALTER TABLE vault_payments ADD COLUMN IF NOT EXISTS card_version text;
    ALTER TABLE vault_payments ADD COLUMN IF NOT EXISTS browser_id text;
    CREATE INDEX IF NOT EXISTS vault_payments_owner ON vault_payments(owner_id,created_at DESC);
  `);
  const site = (origin: string) => new URL(origin).host;
  const money = (row: Pick<Row, 'amount_minor' | 'currency'>) =>
    formatAmount(Number(row.amount_minor), row.currency);
  const cardName = (card: Pick<VaultPaymentCard, 'brand' | 'last4'>) =>
    `${card.brand} ••${card.last4}`;
  const cardFacts = (card: Pick<VaultPaymentCard, 'brand' | 'last4'>) => ({
    brand: card.brand,
    last4: card.last4,
    savedInNod: true,
  });
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
        'Ask the owner to open Nod on desktop and [add a card in Vault](/vault?add=card), then tell you to continue. Do not ask for card details in chat.',
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

  async function enter(row: Row, card: VaultPaymentCard, securityCode: string) {
    let value: CardEntry['card'];
    const message = `Nod entered ${cardName(card)} for ${money(row)} at ${site(row.origin)}. Nod submitted the checkout. Check whether the shop accepted the payment. Do not submit it again.`;
    await uses.run(
      {
        id: row.id,
        ownerId,
        origin: row.origin,
        kind: 'card',
        itemId: card.id,
        payment: spent(row),
      },
      {
        prepare: async (client) => {
          await lockKey(client, `thread:${ownerId}`);
          const active = await client.query(
            `SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id
             WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3 AND th.archived_at IS NULL
               AND ${currentTurnSql} FOR NO KEY UPDATE OF u`,
            [row.turn_id, ownerId, row.thread_id],
          );
          if (!active.rowCount) throw new PaymentError('This payment task is no longer active.');
          const claimed = await client.query(
            "UPDATE vault_payments SET status='consumed' WHERE id=$1 AND owner_id=$2 AND status='pending' RETURNING id",
            [row.id, ownerId],
          );
          if (!claimed.rowCount) throw new PaymentError('This payment request is no longer open.');
          value = await options.card(row.card_id, row.card_version, client);
        },
        perform: async () => {
          captureSecureEntry(
            options.analytics,
            { kind: 'payment', origin: row.origin, payment: spent(row) },
            'approved',
          );
          await options.fill({
            threadId: row.browser_id ?? row.thread_id,
            fields: row.fields,
            document: row.document,
            destinations: row.destinations,
            submitSelector: row.submit_selector ?? undefined,
            card: { ...value, securityCode },
          });
        },
        complete: async (client) => {
          await record(
            { threadId: row.thread_id, turnId: row.turn_id },
            {
              action: 'card',
              origin: row.origin,
              reason: 'code_typed',
              itemId: card.id,
              itemKind: 'card',
              payment: payment(row),
            },
            client,
          );
          await options.resume(
            row.turn_id,
            `${message} Do not repeat completed external actions.`,
            client,
          );
        },
      },
    );
    return message;
  }

  function spent(row: Pick<Row, 'amount_minor' | 'currency'>) {
    return {
      amount: Number(row.amount_minor) / 10 ** digits(row.currency),
      currency: row.currency,
    };
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
         AND p.status='pending'`,
        [id, ownerId, scope.threadId ?? null, scope.turnId ?? null],
      )
    ).rows[0];
  }

  async function request(turn: TurnRef, raw: unknown) {
    const parsed = input.parse(raw);
    const origin = credentialOrigin((await options.page(browserOf(turn))).origin);
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
    };
    const details = {
      kind: 'payment',
      origin,
      amount: (minor / 10 ** places).toFixed(places),
      amountMinor: minor,
      currency,
      card: cardFacts(card),
      destinations: [...new Set(Object.values(destinations))],
      requires: 'desktop_private_form',
    };
    const question = await options.present({ ...turn }, structuredClone(details));
    if (typeof question !== 'string' || !question.trim() || question.length > 12_000)
      throw new PaymentError('The payment model did not produce a valid question.');
    const closed = await uses.transaction(async (client) => {
      const active = await client.query(
        `SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id
         WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3 AND th.archived_at IS NULL
           AND ${currentTurnSql} FOR NO KEY UPDATE OF u`,
        [row.turn_id, ownerId, row.thread_id],
      );
      if (!active.rowCount) throw new PaymentError('This payment task is no longer active.');
      const superseded = await client.query<Row>(
        `UPDATE vault_payments SET status='superseded' WHERE owner_id=$1 AND thread_id=$2 AND turn_id=$3
       AND status='pending' RETURNING *`,
        [ownerId, turn.threadId, turn.turnId],
      );
      await client.query(
        `INSERT INTO vault_payments(id,owner_id,thread_id,turn_id,origin,amount_minor,currency,card_id,fields,document,destinations,submit_selector,card_version,browser_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
          row.submit_selector,
          row.card_version,
          row.browser_id,
        ],
      );
      await record(
        turn,
        {
          action: 'asked',
          origin,
          reason: 'payment',
          itemKind: 'card',
          itemId: card.id,
          payment: payment(row),
        },
        client,
      );
      return superseded.rows;
    });
    for (const previous of closed)
      captureSecureEntry(
        options.analytics,
        { kind: 'payment', origin: previous.origin, payment: spent(previous) },
        'superseded',
      );
    captureSecureEntry(
      options.analytics,
      { kind: 'payment', origin, payment: spent(row) },
      'requested',
    );
    return { image, question, url: `/payments/${row.id}` };
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

  function registerRoutes(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>(
      '/api/payment-requests/:id/status',
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!z.uuid().safeParse(request.params.id).success)
          return reply.code(404).send({ error: 'This payment request is unavailable.' });
        const result = await pool.query<{ status: string; card_id: string; card_version: string }>(
          `SELECT p.card_id,p.card_version,CASE WHEN v.status='running' THEN 'entering' WHEN v.status IS NOT NULL THEN v.status
           WHEN p.status='pending' AND EXISTS(SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id
             WHERE u.id=p.turn_id AND u.owner_id=p.owner_id AND th.archived_at IS NULL AND ${currentTurnSql}) THEN 'pending'
           ELSE 'expired' END AS status
         FROM vault_payments p LEFT JOIN vault_uses v ON v.id=p.id::text AND v.owner_id=p.owner_id
         WHERE p.id=$1 AND p.owner_id=$2`,
          [request.params.id, ownerId],
        );
        if (!result.rows[0])
          return reply.code(404).send({ error: 'This payment request is unavailable.' });
        const row = result.rows[0];
        if (
          row.status === 'pending' &&
          !(await options.cards()).some(
            (card) => card.id === row.card_id && card.version === row.card_version,
          )
        )
          return { status: 'expired' };
        return { status: row.status };
      },
    );
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
      } satisfies PaymentRequest;
    });
    app.post<{ Params: { id: string } }>(
      '/api/payment-requests/:id',
      { bodyLimit: 1024 },
      async (request, reply) => {
        const parsed = z
          .object({ code: z.string().regex(/^\d{3,4}$/) })
          .strict()
          .safeParse(request.body);
        if (!parsed.success || !z.uuid().safeParse(request.params.id).success)
          return reply.code(400).send({ error: 'Check the payment fields.' });
        const { code } = parsed.data;
        const row = await open(request.params.id, {});
        const card = (await options.cards()).find((item) => item.id === row?.card_id);
        if (!row || !card)
          return reply.code(409).send({ error: 'This payment needs a fresh secure request.' });
        try {
          await enter(row, card, code);
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

  return { request, submitCode, registerRoutes };
}

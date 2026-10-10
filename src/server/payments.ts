import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { BrowserPage, CardEntry, CardFields } from '../ports/computer.ts';
import type {
  VaultActivityEntry,
  VaultActivityReason,
  VaultPaymentCard,
} from '../shared/contracts.ts';
import { logFailure } from './failure-log.ts';
import type { TurnRef } from './thread.ts';
import type { PaymentPolicy } from './trust.ts';
import { credentialOrigin } from './vault.ts';

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

type Row = {
  id: string;
  thread_id: string;
  turn_id: string;
  origin: string;
  page_url: string;
  amount_minor: string;
  currency: string;
  description: string;
  card_id: string;
  fields: CardFields;
  flagged: boolean;
  status: 'pending' | 'approved' | 'entered' | 'declined' | 'failed' | 'superseded';
  expires_at: Date;
};

const selector = z.string().min(1).max(2048);
const input = z
  .object({
    amount: z.string().regex(/^\d{1,9}(?:\.\d{1,3})?$/),
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    description: z.string().trim().min(1).max(200),
    card: z.string().trim().max(100).optional(),
    paymentId: z.uuid().optional(),
    fields: z
      .object({
        number: selector,
        expiry: selector.optional(),
        expiryMonth: selector.optional(),
        expiryYear: selector.optional(),
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
    local: boolean;
    policy(turn: TurnRef): Promise<PaymentPolicy>;
    page(threadId: string): Promise<BrowserPage>;
    cards(): Promise<VaultPaymentCard[]>;
    card(id: string): Promise<CardEntry['card']>;
    remember(id: string, on: boolean, securityCode?: string): Promise<unknown>;
    fill(input: CardEntry): Promise<void>;
    resume(turnId: string, prompt: string): Promise<void>;
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
    ): Promise<void>;
  },
) {
  const { ownerId } = options;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_payments (
      id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid NOT NULL, turn_id uuid NOT NULL,
      origin text NOT NULL, page_url text NOT NULL, amount_minor bigint NOT NULL, currency text NOT NULL,
      description text NOT NULL, card_id text NOT NULL, fields jsonb NOT NULL,
      flagged boolean NOT NULL, status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, entered_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS vault_payments_owner ON vault_payments(owner_id,created_at DESC);
    DELETE FROM vault_payments WHERE created_at<now()-interval '90 days';
  `);

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

  async function record(turn: TurnRef, entry: Parameters<typeof options.record>[1]) {
    await options.record(turn, entry).catch((error: unknown) => {
      logFailure('vault_payment_activity_failed', error);
    });
  }

  async function choose(origin: string, hint?: string) {
    const cards = await options.cards();
    if (!cards.length) throw new PaymentError('Save a payment card in Vault first.');
    const named = hint?.toLowerCase();
    const matches = named
      ? cards.filter(
          (card) =>
            card.last4 === named.replace(/\D/g, '') || card.label.toLowerCase().includes(named),
        )
      : [];
    if (matches.length === 1) return matches[0]!;
    if (cards.length === 1) return cards[0]!;
    const recent = named
      ? undefined
      : (
          await pool.query<{ card_id: string }>(
            `SELECT card_id FROM vault_payments WHERE owner_id=$1 AND origin=$2 AND status='entered'
             ORDER BY entered_at DESC LIMIT 1`,
            [ownerId, origin],
          )
        ).rows[0]?.card_id;
    const card = cards.find((item) => item.id === recent);
    if (card) return card;
    throw new PaymentError(
      `Ask the owner which card to use: ${cards.map((item) => `${item.label} (${cardName(item)})`).join(', ')}. Then call again with card.`,
    );
  }

  async function enter(row: Row, cardId: string, securityCode?: string) {
    const page = await options.page(row.thread_id);
    if (page.url !== row.page_url)
      throw new PaymentError('The checkout page changed. Otto will ask again.', 409);
    const card = await options.card(cardId);
    await options.fill({
      threadId: row.thread_id,
      origin: row.origin,
      fields: row.fields,
      card: { ...card, ...(securityCode ? { securityCode } : {}) },
    });
    await pool.query(
      "UPDATE vault_payments SET status='entered',card_id=$3,entered_at=now() WHERE id=$1 AND owner_id=$2",
      [row.id, ownerId, cardId],
    );
  }

  async function entered(row: Row, cardId: string) {
    const card = (await options.cards()).find((item) => item.id === cardId);
    return `Otto entered ${card ? cardName(card) : 'the card'} for ${money(row)} at ${site(row.origin)}. Place the order, then check the result.`;
  }

  async function request(
    turn: TurnRef,
    raw: unknown,
  ): Promise<
    | { question: string }
    | { paymentId: string; question: string }
    | { entered: true; message: string }
  > {
    const parsed = input.parse(raw);
    const policy = await options.policy(turn);
    const page = await options.page(turn.threadId);
    const origin = credentialOrigin(page.origin);
    if (!policy.allowed) {
      await record(turn, { action: 'held', origin, reason: policy.reason, itemKind: 'card' });
      throw new PaymentError(
        policy.reason === 'background'
          ? 'Work Otto starts on its own never pays. Tell the owner what to buy.'
          : 'This turn can only read. Do not pay.',
      );
    }
    if (parsed.paymentId) {
      const row = (
        await pool.query<Row>(
          `SELECT * FROM vault_payments WHERE id=$1 AND owner_id=$2 AND thread_id=$3
           AND status='approved' AND expires_at>now() AND NOT flagged`,
          [parsed.paymentId, ownerId, turn.threadId],
        )
      ).rows[0];
      const card = (await options.cards()).find((item) => item.id === row?.card_id);
      if (!row || !card?.doItForMe || row.origin !== origin || policy.flagged)
        throw new PaymentError('This payment approval is no longer available. Call pay again.');
      await enter({ ...row, fields: parsed.fields }, card.id);
      await record(turn, {
        action: 'paid',
        origin,
        reason: 'said_yes',
        itemId: card.id,
        itemKind: 'card',
        payment: payment(row),
      });
      return { entered: true, message: await entered(row, card.id) };
    }
    const currency = parsed.currency.toUpperCase();
    const [whole, fraction = ''] = parsed.amount.split('.');
    const places = digits(currency);
    if (fraction.length > places) throw new PaymentError('Check the amount for this currency.');
    const minor = Number(whole) * 10 ** places + Number(fraction.padEnd(places, '0') || '0');
    if (!minor) throw new PaymentError('Check the amount.');
    const chosen = await choose(origin, parsed.card);
    const row: Row = {
      id: randomUUID(),
      thread_id: turn.threadId,
      turn_id: turn.turnId,
      origin,
      page_url: page.url,
      amount_minor: String(minor),
      currency,
      description: parsed.description,
      card_id: chosen.id,
      fields: parsed.fields,
      flagged: policy.flagged,
      status: 'pending',
      expires_at: new Date(Date.now() + 10 * 60_000),
    };
    await pool.query(
      `UPDATE vault_payments SET status='superseded' WHERE owner_id=$1 AND thread_id=$2
       AND status IN ('pending','approved')`,
      [ownerId, turn.threadId],
    );
    await pool.query(
      `INSERT INTO vault_payments(id,owner_id,thread_id,turn_id,origin,page_url,amount_minor,currency,description,card_id,fields,flagged,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        row.id,
        ownerId,
        row.thread_id,
        row.turn_id,
        origin,
        row.page_url,
        minor,
        currency,
        row.description,
        row.card_id,
        JSON.stringify(row.fields),
        row.flagged,
        row.expires_at,
      ],
    );
    await record(turn, {
      action: 'asked',
      origin,
      reason: 'payment',
      itemKind: 'card',
      itemId: chosen.id,
      payment: payment(row),
    });
    const question = `Pay ${money(row)} at ${site(origin)} with ${cardName(chosen)}?`;
    if (options.local && chosen.doItForMe && !policy.flagged)
      return { paymentId: row.id, question };
    const keep = options.local && !policy.flagged;
    return {
      question: [
        policy.flagged
          ? 'A page in this task had instructions for AI assistants, so a yes is not enough.'
          : '',
        question,
        'Reply with its security code.',
        keep && chosen.choice === null ? 'Add “keep” and next time your yes is enough.' : '',
        keep && chosen.choice ? 'Otto keeps it, so next time your yes is enough.' : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  async function approve(context: { threadId: string; turnId: string }, raw: unknown) {
    const { paymentId } = z.object({ paymentId: z.uuid() }).strict().parse(raw);
    const found = (
      await pool.query<Row>(
        `SELECT * FROM vault_payments WHERE id=$1 AND owner_id=$2 AND thread_id=$3
         AND status='pending' AND expires_at>now() AND NOT flagged`,
        [paymentId, ownerId, context.threadId],
      )
    ).rows[0];
    const card = found?.card_id
      ? (await options.cards()).find((item) => item.id === found.card_id)
      : undefined;
    const row = card?.doItForMe
      ? (
          await pool.query<Row>(
            `UPDATE vault_payments SET status='approved' WHERE id=$1 AND owner_id=$2
             AND status='pending' AND expires_at>now() RETURNING *`,
            [paymentId, ownerId],
          )
        ).rows[0]
      : undefined;
    if (!row || !card)
      return {
        entered: false,
        message:
          'This payment request is no longer open, so nothing was paid. Call pay again if the purchase is still wanted.',
      };
    try {
      await enter(row, card.id);
    } catch {
      return {
        entered: false,
        paymentId: row.id,
        message: `The owner approved ${money(row)} at ${site(row.origin)}, but the card could not be entered. Take a fresh snapshot and call pay with paymentId ${row.id} and the current card fields.`,
      };
    }
    await record(context, {
      action: 'paid',
      origin: row.origin,
      reason: 'said_yes',
      itemId: card.id,
      itemKind: 'card',
      payment: payment(row),
    });
    return { entered: true, paymentId: row.id, message: await entered(row, card.id) };
  }

  async function submitCode(turnId: string, code: string, paymentId: string, keep: boolean) {
    const row = (
      await pool.query<Row>(
        `UPDATE vault_payments SET status='approved' WHERE id=$1 AND owner_id=$2 AND turn_id=$3
         AND status='pending' AND expires_at>now() RETURNING *`,
        [paymentId, ownerId, turnId],
      )
    ).rows[0];
    const card = (await options.cards()).find((item) => item.id === row?.card_id);
    if (!row || !card) return { status: 'unavailable' as const };
    try {
      await enter(row, card.id, code);
    } catch {
      await pool.query("UPDATE vault_payments SET status='failed' WHERE id=$1 AND owner_id=$2", [
        row.id,
        ownerId,
      ]);
      await options.resume(
        row.turn_id,
        `The owner sent the security code for ${money(row)} at ${site(row.origin)}, but the checkout page changed before Otto could enter the card. Take a fresh snapshot and call pay again if the purchase is still wanted. Do not repeat completed external actions.`,
      );
      return { status: 'unavailable' as const };
    }
    const choice = options.local && !row.flagged && (keep || card.choice === true);
    if (options.local && !row.flagged && (keep || card.choice !== false))
      await options.remember(card.id, choice, choice ? code : undefined).catch((error: unknown) => {
        logFailure('vault_payment_choice_failed', error);
      });
    await record(
      { threadId: row.thread_id, turnId: row.turn_id },
      {
        action: 'paid',
        origin: row.origin,
        reason: 'code_typed',
        itemId: card.id,
        itemKind: 'card',
        payment: payment(row),
      },
    );
    await options.resume(
      row.turn_id,
      `${await entered(row, card.id)}${choice ? ` Do it for me is on for ${cardName(card)}: next time the owner's yes is enough.` : ''} Do not repeat completed external actions.`,
    );
    return { status: 'submitted' as const };
  }

  async function setting(turn: TurnRef, raw: unknown) {
    const parsed = z
      .object({ card: z.string().trim().max(100).optional(), doItForMe: z.boolean() })
      .strict()
      .parse(raw);
    if (!options.local)
      throw new PaymentError('Otto never keeps security codes here, so every payment needs one.');
    const policy = await options.policy(turn);
    if (!policy.allowed || (parsed.doItForMe && policy.flagged))
      throw new PaymentError('Only a message from the owner can change Do it for me.');
    const card = await choose('', parsed.card);
    await options.remember(card.id, parsed.doItForMe);
    return !parsed.doItForMe
      ? `Do it for me is off for ${cardName(card)}. Otto deleted its security code and asks for it each time.`
      : card.doItForMe
        ? `Do it for me is on for ${cardName(card)}: the owner's yes is enough to pay.`
        : `Do it for me is on for ${cardName(card)}. Otto keeps its security code the next time the owner pays with it; after that a yes is enough.`;
  }

  return { request, approve, submitCode, setting };
}

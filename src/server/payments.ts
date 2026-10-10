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

export class PaymentError extends Error {}

type Row = {
  id: string;
  thread_id: string;
  turn_id: string;
  origin: string;
  amount_minor: string;
  currency: string;
  card_id: string;
  fields: CardFields;
  document: string;
  destinations: Partial<Record<keyof CardFields, string>>;
  keep_notice: boolean;
  flagged: boolean;
};

const selector = z.string().min(1).max(2048);
const input = z
  .object({
    amount: z.string().regex(/^\d{1,9}(?:\.\d{1,3})?$/),
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    card: z.string().trim().max(100).optional(),
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
    destinations(
      threadId: string,
      fields: CardFields,
    ): Promise<{ document: string; destinations: Partial<Record<keyof CardFields, string>> }>;
    capture(threadId: string): Promise<Uint8Array>;
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
      origin text NOT NULL, amount_minor bigint NOT NULL, currency text NOT NULL, card_id text NOT NULL,
      fields jsonb NOT NULL, document text NOT NULL, destinations jsonb NOT NULL,
      keep_notice boolean NOT NULL, flagged boolean NOT NULL, status text NOT NULL DEFAULT 'pending',
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

  async function choose(hint?: string) {
    const cards = await options.cards();
    if (!cards.length) throw new PaymentError('Save a payment card in Vault first.');
    const named = hint?.toLowerCase();
    const matches = named
      ? cards.filter(
          (card) =>
            card.last4 === named.replace(/\D/g, '') || card.label.toLowerCase().includes(named),
        )
      : cards;
    if (matches.length === 1) return matches[0]!;
    throw new PaymentError(
      `Ask the owner which card to use: ${cards.map((item) => `${item.label} (${cardName(item)})`).join(', ')}. Then call again with card.`,
    );
  }

  async function enter(row: Row, card: VaultPaymentCard, securityCode?: string) {
    await options.fill({
      threadId: row.thread_id,
      fields: row.fields,
      document: row.document,
      destinations: row.destinations,
      card: { ...(await options.card(card.id)), ...(securityCode ? { securityCode } : {}) },
    });
    await pool.query(
      "UPDATE vault_payments SET status='entered',entered_at=now() WHERE id=$1 AND owner_id=$2",
      [row.id, ownerId],
    );
    await record(
      { threadId: row.thread_id, turnId: row.turn_id },
      {
        action: 'paid',
        origin: row.origin,
        reason: securityCode ? 'code_typed' : 'said_yes',
        itemId: card.id,
        itemKind: 'card',
        payment: payment(row),
      },
    );
    return `Otto entered ${cardName(card)} for ${money(row)} at ${site(row.origin)}. Place the order, then check the result. While card details are on that page you can only look and click.`;
  }

  async function fail(row: Row) {
    await pool.query("UPDATE vault_payments SET status='failed' WHERE id=$1 AND owner_id=$2", [
      row.id,
      ownerId,
    ]);
    return `The owner approved ${money(row)} at ${site(row.origin)}, but the checkout changed before Otto could enter the card, so nothing was entered. Take a fresh snapshot and call pay again if the purchase is still wanted.`;
  }

  async function open(id: string, scope: { threadId?: string; turnId?: string; yes?: boolean }) {
    return (
      await pool.query<Row>(
        `UPDATE vault_payments SET status='approved' WHERE id=$1 AND owner_id=$2
         AND ($3::uuid IS NULL OR thread_id=$3) AND ($4::uuid IS NULL OR turn_id=$4)
         AND NOT ($5 AND flagged) AND status='pending' AND expires_at>now() RETURNING *`,
        [id, ownerId, scope.threadId ?? null, scope.turnId ?? null, scope.yes === true],
      )
    ).rows[0];
  }

  async function request(
    turn: TurnRef,
    raw: unknown,
  ): Promise<{ question: string; image: Uint8Array; paymentId?: string }> {
    const parsed = input.parse(raw);
    if (!options.local)
      throw new PaymentError(
        'Hosted Otto does not pay with saved cards. Tell the owner to pay on the site themselves.',
      );
    const policy = await options.policy(turn);
    const origin = credentialOrigin((await options.page(turn.threadId)).origin);
    if (!policy.allowed || !policy.inOtto) {
      const reason = policy.allowed ? 'chat_app' : policy.reason;
      await record(turn, { action: 'held', origin, reason, itemKind: 'card' });
      throw new PaymentError(
        reason === 'chat_app'
          ? 'Payments are approved only in the Otto app. Nothing was paid. Tell the owner to open Otto and ask you there to go ahead.'
          : reason === 'background'
            ? 'Work Otto starts on its own never pays. Tell the owner what to buy.'
            : 'This turn can only read. Do not pay.',
      );
    }
    const currency = parsed.currency.toUpperCase();
    const [whole, fraction = ''] = parsed.amount.split('.');
    const places = digits(currency);
    if (fraction.length > places) throw new PaymentError('Check the amount for this currency.');
    const minor = Number(whole) * 10 ** places + Number(fraction.padEnd(places, '0') || '0');
    if (!minor) throw new PaymentError('Check the amount.');
    const card = await choose(parsed.card);
    const { document, destinations } = await options.destinations(turn.threadId, parsed.fields);
    for (const destination of Object.values(destinations)) credentialOrigin(destination);
    const image = await options.capture(turn.threadId);
    const row: Row = {
      id: randomUUID(),
      thread_id: turn.threadId,
      turn_id: turn.turnId,
      origin,
      amount_minor: String(minor),
      currency,
      card_id: card.id,
      fields: parsed.fields,
      document,
      destinations,
      keep_notice: !policy.flagged && card.choice === true && !card.doItForMe,
      flagged: policy.flagged,
    };
    await pool.query(
      `UPDATE vault_payments SET status='superseded' WHERE owner_id=$1 AND thread_id=$2
       AND status IN ('pending','approved')`,
      [ownerId, turn.threadId],
    );
    await pool.query(
      `INSERT INTO vault_payments(id,owner_id,thread_id,turn_id,origin,amount_minor,currency,card_id,fields,document,destinations,keep_notice,flagged,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '10 minutes')`,
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
        row.flagged,
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
    if (card.doItForMe && !policy.flagged)
      return { paymentId: row.id, question: question.filter(Boolean).join(' '), image };
    return {
      image,
      question: [
        policy.flagged
          ? 'A page in this task had instructions for AI assistants, so a yes is not enough.'
          : '',
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
    const row = await open(paymentId, { threadId: context.threadId, yes: true });
    const card = (await options.cards()).find((item) => item.id === row?.card_id);
    if (!row || !card?.doItForMe)
      return {
        entered: false,
        message:
          'This payment request is no longer open, so nothing was paid. Call pay again if the purchase is still wanted.',
      };
    try {
      return { entered: true, message: await enter(row, card) };
    } catch {
      return { entered: false, message: await fail(row) };
    }
  }

  async function submitCode(turnId: string, code: string, paymentId: string) {
    const row = await open(paymentId, { turnId });
    const card = (await options.cards()).find((item) => item.id === row?.card_id);
    if (!row || !card) return { status: 'unavailable' as const };
    let message: string;
    try {
      message = await enter(row, card, code);
    } catch {
      await options.resume(row.turn_id, await fail(row));
      return { status: 'unavailable' as const };
    }
    if (row.keep_notice && card.choice === true)
      await options.remember(card.id, true, code).catch((error: unknown) => {
        logFailure('vault_payment_choice_failed', error);
      });
    const first =
      card.choice === null &&
      (
        await pool.query(
          "SELECT 1 FROM vault_payments WHERE owner_id=$1 AND card_id=$2 AND status='entered' LIMIT 2",
          [ownerId, card.id],
        )
      ).rowCount === 1;
    await options.resume(
      row.turn_id,
      `${message}${first ? ` After the order, ask the owner once whether a yes should be enough to pay with ${cardName(card)} next time (Otto would keep its security code from the next payment), and save their answer with payment_setting.` : ''} Do not repeat completed external actions.`,
    );
    return { status: 'submitted' as const };
  }

  async function setting(turn: TurnRef, raw: unknown) {
    const parsed = z
      .object({ card: z.string().trim().max(100).optional(), doItForMe: z.boolean() })
      .strict()
      .parse(raw);
    if (!options.local) throw new PaymentError('Hosted Otto does not pay with saved cards.');
    const policy = await options.policy(turn);
    if (!policy.allowed || (parsed.doItForMe && (policy.flagged || !policy.inOtto)))
      throw new PaymentError('Do it for me can be turned on only from a message in the Otto app.');
    const card = await choose(parsed.card);
    await options.remember(card.id, parsed.doItForMe);
    return !parsed.doItForMe
      ? `Do it for me is off for ${cardName(card)}. Otto deleted its security code and asks for it each time.`
      : card.doItForMe
        ? `Do it for me is on for ${cardName(card)}: the owner's yes in Otto is enough to pay.`
        : `Do it for me is on for ${cardName(card)}. Otto keeps its security code the next time the owner pays with it; after that a yes is enough.`;
  }

  return { request, approve, submitCode, setting };
}

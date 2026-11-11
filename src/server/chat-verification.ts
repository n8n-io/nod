import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { SubmitMessageResponse, VerificationRequest } from '../shared/contracts.ts';
import { classifyVerificationReply, securityCodeIn } from '../shared/verification-code.ts';
import { lockThread } from './thread.ts';
import { transaction } from './transaction.ts';
import { supersededSql } from './turn-chain.ts';
import { waitingTurnSql } from './vault.ts';

interface VerificationInput {
  clientMessageId: string;
  channel?: string;
  threadId?: string;
  replyToMessageId?: string;
  verificationRequestId?: string;
  receiptOnly?: boolean;
  attachmentIds?: string[];
  signal?: AbortSignal;
  persistOrdinary?: (client: PoolClient) => Promise<void>;
  persistVerification?: (client: PoolClient, response: SubmitMessageResponse) => Promise<void>;
}

type VerificationStatus = 'submitted' | 'invalid' | 'unavailable';
export const texts = {
  otp: {
    masked: 'Verification code sent securely.',
    pending: 'Verification code received securely.',
    cancelled: 'Verification code cancelled before sending.',
  },
  payment: {
    masked: 'Security code sent securely.',
    pending: 'Security code received securely.',
    cancelled: 'Security code cancelled before sending.',
  },
};
const unavailableMessage =
  'This code request is no longer available. Continue the task to request a new code.';

function conflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export async function createChatVerification(
  pool: Pool,
  options: {
    ownerId: string;
    keyStore: Pick<CredentialKeyStore, 'getKey'>;
    submitCode: (
      ownerId: string,
      turnId: string,
      code: string,
      requestId: string,
    ) => Promise<{ status: VerificationStatus }>;
    submitPayment?: (
      turnId: string,
      code: string,
      paymentId: string,
    ) => Promise<{ status: VerificationStatus }>;
    present?: (
      threadId: string,
      input: { kind: 'verification_failure'; verification: 'otp' | 'payment' },
    ) => Promise<string>;
    refresh: () => void;
  },
) {
  const codeRequests = `(SELECT id,owner_id,thread_id,turn_id,kind,status FROM credential_requests WHERE kind='otp'${
    options.submitPayment
      ? ` UNION ALL SELECT id::text,owner_id,thread_id,turn_id,'payment',status FROM vault_payments`
      : ''
  })`;
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_verification_submissions (
    message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    request_id text NOT NULL, status text NOT NULL DEFAULT 'pending', code_fingerprint text NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_verification_questions (
    message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    request_id text NOT NULL
  )`);
  async function bindQuestion(
    turnId: string,
    messageId: string,
    database: Pick<PoolClient, 'query'> = pool,
  ) {
    await database.query(
      `WITH pending AS (
         SELECT r.id FROM ${codeRequests} r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
         JOIN messages m ON m.turn_id=u.id AND m.thread_id=r.thread_id AND m.owner_id=r.owner_id
         WHERE m.id=$1 AND m.owner_id=$2 AND m.turn_id=$3 AND m.role='assistant'
           AND r.status='pending' AND (r.kind<>'payment' OR u.channel='web')
           AND ${waitingTurnSql('u', 'credentials')}
       ) INSERT INTO chat_verification_questions(message_id,request_id)
         SELECT $1,id FROM pending WHERE (SELECT count(*) FROM pending)=1
         ON CONFLICT(message_id) DO NOTHING`,
      [messageId, options.ownerId, turnId],
    );
  }
  let fingerprintKey: Promise<Buffer> | undefined;
  async function fingerprint(code: string, input: VerificationInput) {
    fingerprintKey ??= options.keyStore
      .getKey()
      .then((key) => {
        if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error();
        return createHmac('sha256', key).update('nod:chat-verification:fingerprint:v1').digest();
      })
      .catch(() => {
        fingerprintKey = undefined;
        throw Object.assign(new Error('Verification is temporarily unavailable. Try again.'), {
          statusCode: 503,
        });
      });
    return createHmac('sha256', await fingerprintKey)
      .update(
        JSON.stringify([options.ownerId, input.channel ?? 'web', input.clientMessageId, code]),
      )
      .digest('hex');
  }

  async function pending(channel = 'web'): Promise<VerificationRequest[]> {
    const result = await pool.query<VerificationRequest>(
      `SELECT r.id,u.id AS "turnId",r.kind
       FROM ${codeRequests} r JOIN turns u ON u.id=r.turn_id
       WHERE r.owner_id=$1 AND u.owner_id=$1 AND u.channel=$2
         AND r.status='pending' AND ${waitingTurnSql('u', 'credentials')}
         ORDER BY u.created_at,r.id LIMIT 50`,
      [options.ownerId, channel],
    );
    return result.rows;
  }

  async function accept(
    text: string,
    input: VerificationInput,
  ): Promise<SubmitMessageResponse | undefined> {
    input.signal?.throwIfAborted();
    const reply = classifyVerificationReply(text);
    const codes = {
      otp: reply.kind === 'code' ? reply.code : undefined,
      payment: options.submitPayment ? securityCodeIn(text) : undefined,
    };
    if (reply.kind === 'ordinary' && !codes.payment && !input.verificationRequestId) return;
    if (!codes.otp && !codes.payment && input.verificationRequestId)
      throw conflict('Send the code by itself.');
    const incompatible = Boolean(input.attachmentIds?.length);
    if (incompatible && input.verificationRequestId)
      throw conflict('Send the verification code by itself in the sign-in conversation.');
    const channel = input.channel ?? 'web';
    const client = await pool.connect();
    let reserved:
      | {
          threadId: string;
          turnId: string;
          requestId: string;
          kind: 'otp' | 'payment';
          code: string;
        }
      | undefined;
    try {
      await client.query('BEGIN');
      const thread = await lockThread(client, options.ownerId);
      input.signal?.throwIfAborted();
      if (input.threadId !== undefined && input.threadId !== thread.id)
        throw conflict('This conversation has been reset. Reload it before continuing.');
      const previous = (
        await client.query(
          `SELECT m.owner_id,m.thread_id,m.turn_id,m.reply_to_message_id,m.text,u.owner_id AS turn_owner_id,
           u.channel,v.request_id,v.status,v.code_fingerprint
           FROM messages m LEFT JOIN turns u ON u.id=m.turn_id
           LEFT JOIN chat_verification_submissions v ON v.message_id=m.id WHERE m.id=$1`,
          [input.clientMessageId],
        )
      ).rows[0];
      if (input.receiptOnly && !previous?.request_id) {
        await client.query('COMMIT');
        return;
      }
      if (previous) {
        if (!previous.request_id) {
          await input.persistOrdinary?.(client);
          await client.query('COMMIT');
          return;
        }
        const code = codes.otp ?? codes.payment;
        if (!code) throw conflict('Send the code by itself.');
        const codeFingerprint = await fingerprint(code, input);
        if (
          previous.owner_id !== options.ownerId ||
          previous.turn_owner_id !== options.ownerId ||
          previous.channel !== channel ||
          previous.thread_id !== thread.id ||
          previous.reply_to_message_id !== (input.replyToMessageId ?? null) ||
          (input.verificationRequestId && previous.request_id !== input.verificationRequestId) ||
          incompatible ||
          previous.code_fingerprint.length !== codeFingerprint.length ||
          !timingSafeEqual(Buffer.from(previous.code_fingerprint), Buffer.from(codeFingerprint))
        )
          throw conflict('This message ID is already in use. Send this as a new message.');
        const response: SubmitMessageResponse = {
          threadId: previous.thread_id,
          turnId: previous.turn_id,
          messageId: input.clientMessageId,
          messageText: previous.text,
          verificationStatus:
            previous.status === 'pending' || previous.status === 'submitted'
              ? previous.status
              : 'unavailable',
        };
        await input.persistVerification?.(client, response);
        await client.query('COMMIT');
        return response;
      }
      let turnId: string | undefined;
      let requestId = input.verificationRequestId;
      if (input.replyToMessageId) {
        const target = (
          await client.query(
            `SELECT u.id,q.request_id FROM messages m JOIN turns u ON u.id=m.turn_id
             LEFT JOIN chat_verification_questions q ON q.message_id=m.id
             WHERE m.id=$1 AND m.owner_id=$2 AND u.owner_id=$2 AND u.channel=$3 AND m.thread_id=$4`,
            [input.replyToMessageId, options.ownerId, channel, thread.id],
          )
        ).rows[0];
        if (!target) throw conflict('The reply is unavailable in this conversation.');
        turnId = target.id;
        if (target.request_id) {
          if (requestId && requestId !== target.request_id) throw conflict(unavailableMessage);
          requestId = target.request_id;
        } else if (
          requestId ||
          (
            await client.query(
              `SELECT 1 FROM ${codeRequests} WHERE owner_id=$1 AND thread_id=$2 AND turn_id=$3 LIMIT 1`,
              [options.ownerId, thread.id, turnId],
            )
          ).rowCount
        )
          throw conflict(unavailableMessage);
      }
      const requests = await client.query<{
        id: string;
        turn_id: string;
        kind: 'otp' | 'payment';
      }>(
        `SELECT r.id,r.turn_id,r.kind FROM ${codeRequests} r JOIN turns u ON u.id=r.turn_id
         WHERE r.owner_id=$1 AND u.owner_id=$1 AND u.channel=$2 AND r.thread_id=$5
           AND r.status='pending' AND (r.kind<>'payment' OR u.channel='web')
           AND ${waitingTurnSql('u', 'credentials')}
           AND ($3::uuid IS NULL OR r.turn_id=$3) AND ($4::text IS NULL OR r.id=$4)
           ORDER BY u.created_at,r.id LIMIT 2`,
        [options.ownerId, channel, turnId ?? null, requestId ?? null, thread.id],
      );
      if (!requests.rowCount) {
        if (requestId) throw conflict(unavailableMessage);
        const waiting = (
          await client.query<{ kind: 'otp' | 'payment'; channel: string }>(
            `SELECT r.kind,u.channel FROM ${codeRequests} r JOIN turns u ON u.id=r.turn_id
             WHERE r.owner_id=$1 AND u.owner_id=$1 AND (u.channel=$2 OR r.kind='payment') AND r.thread_id=$3
               AND r.status='pending' AND (r.turn_id=$6::uuid OR NOT ${supersededSql(
                 'u',
                 `newer.created_at>u.created_at AND (NOT $7::boolean OR newer.created_at<now()-interval '10 minutes')`,
               )})
               AND ((r.kind='payment' AND ($4::boolean OR ($5::boolean AND u.channel=$2))) OR (r.kind='otp' AND $5::boolean)) LIMIT 1`,
            [
              options.ownerId,
              channel,
              thread.id,
              Boolean(codes.payment),
              reply.kind !== 'ordinary',
              turnId ?? null,
              reply.kind === 'code' || reply.kind === 'wrapped' || Boolean(codes.payment),
            ],
          )
        ).rows[0];
        if (waiting)
          throw conflict(
            waiting.kind === 'payment'
              ? waiting.channel !== channel
                ? 'Open the secure payment link in Nod. Nod did not use this code.'
                : 'Send just the card’s security code.'
              : unavailableMessage,
          );
        await input.persistOrdinary?.(client);
        await client.query('COMMIT');
        return;
      }
      if (requests.rowCount !== 1)
        throw conflict(
          'More than one sign-in needs a code. Reply to the verification request you want to complete.',
        );
      const request = requests.rows[0]!;
      const code = codes[request.kind];
      if (!code && request.kind === 'otp' && reply.kind === 'ordinary') {
        await input.persistOrdinary?.(client);
        await client.query('COMMIT');
        return;
      }
      if (incompatible)
        throw conflict('Send the verification code by itself in the sign-in conversation.');
      if (!code)
        throw conflict(
          request.kind === 'payment'
            ? 'Send just the card’s security code.'
            : 'Send the code by itself, using 4 to 8 digits.',
        );
      const codeFingerprint = await fingerprint(code, input);
      input.signal?.throwIfAborted();
      await client.query(
        `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,reply_to_message_id)
         VALUES($1,$2,'user',$3,$4,$5,$6)`,
        [
          input.clientMessageId,
          options.ownerId,
          texts[request.kind].pending,
          thread.id,
          request.turn_id,
          input.replyToMessageId ?? null,
        ],
      );
      await client.query(
        'INSERT INTO chat_verification_submissions(message_id,request_id,code_fingerprint) VALUES($1,$2,$3)',
        [input.clientMessageId, request.id, codeFingerprint],
      );
      input.signal?.throwIfAborted();
      await client.query('COMMIT');
      reserved = {
        threadId: thread.id,
        turnId: request.turn_id,
        requestId: request.id,
        kind: request.kind,
        code,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    options.refresh();
    let status: 'submitted' | 'unavailable' | 'cancelled';
    if (input.signal?.aborted) {
      status = 'cancelled';
    } else {
      try {
        const result =
          reserved.kind === 'payment'
            ? await options.submitPayment!(reserved.turnId, reserved.code, reserved.requestId)
            : await options.submitCode(
                options.ownerId,
                reserved.turnId,
                reserved.code,
                reserved.requestId,
              );
        status = result.status === 'submitted' ? 'submitted' : 'unavailable';
      } catch {
        status = 'unavailable';
      }
    }
    const response: SubmitMessageResponse = {
      threadId: reserved.threadId,
      turnId: reserved.turnId,
      messageId: input.clientMessageId,
      messageText: texts[reserved.kind][status === 'cancelled' ? 'cancelled' : 'masked'],
      verificationStatus: status === 'cancelled' ? 'unavailable' : status,
    };
    await pool.query(
      `WITH changed AS (
       UPDATE chat_verification_submissions SET status=$2 WHERE message_id=$1 RETURNING message_id
       ) UPDATE messages SET text=$3 WHERE id IN (SELECT message_id FROM changed)`,
      [input.clientMessageId, status, response.messageText],
    );
    if (status === 'cancelled') {
      options.refresh();
      input.signal?.throwIfAborted();
    }
    if (input.persistVerification)
      await transaction((client) => input.persistVerification!(client, response), pool);
    if (status !== 'submitted' && !input.persistVerification) {
      const message = await options
        .present?.(reserved.threadId, {
          kind: 'verification_failure',
          verification: reserved.kind,
        })
        .catch(() => undefined);
      if (typeof message === 'string' && message.trim())
        await pool.query(
          `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id)
           SELECT $1,$2,'assistant',$3,u.thread_id,u.id FROM turns u JOIN threads th ON th.id=u.thread_id
           WHERE u.id=$4 AND u.owner_id=$2 AND th.owner_id=$2 AND th.id=$5 AND th.archived_at IS NULL`,
          [randomUUID(), options.ownerId, message.trim(), reserved.turnId, reserved.threadId],
        );
    }
    options.refresh();
    return response;
  }

  return { pending, accept, bindQuestion };
}

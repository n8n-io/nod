import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { SubmitMessageResponse, VerificationRequest } from '../shared/contracts.ts';
import { classifyVerificationReply } from '../shared/verification-code.ts';
import { lockThread } from './thread.ts';
import { waitingTurnSql } from './vault.ts';

interface VerificationInput {
  clientMessageId: string;
  channel?: string;
  threadId?: string;
  replyToMessageId?: string;
  verificationRequestId?: string;
  forceNew?: boolean;
  attachmentIds?: string[];
  persistOrdinary?: (client: PoolClient) => Promise<void>;
}

type VerificationStatus = 'submitted' | 'invalid' | 'unavailable';
const maskedMessage = 'Verification code sent securely.';
const pendingMessage = 'Verification code received securely.';
const unavailableMessage =
  'This verification request is no longer available. Continue the sign-in task to request a new code.';

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
    refresh: () => void;
  },
) {
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_verification_submissions (
    message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    request_id text NOT NULL, status text NOT NULL DEFAULT 'pending', code_fingerprint text NOT NULL
  )`);
  let fingerprintKey: Promise<Buffer> | undefined;
  async function fingerprint(code: string, input: VerificationInput) {
    fingerprintKey ??= options.keyStore
      .getKey()
      .then((key) => {
        if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error();
        return createHmac('sha256', key).update('otto:chat-verification:fingerprint:v1').digest();
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
      `SELECT r.id,u.id AS "turnId",r.expires_at AS "expiresAt"
       FROM credential_requests r JOIN turns u ON u.id=r.turn_id
       WHERE r.owner_id=$1 AND u.owner_id=$1 AND u.channel=$2
         AND r.kind='otp' AND r.status='pending' AND r.expires_at>now()
         AND ${waitingTurnSql('u', 'credentials')} ORDER BY r.expires_at,r.id LIMIT 50`,
      [options.ownerId, channel],
    );
    return result.rows;
  }

  async function accept(
    text: string,
    input: VerificationInput,
  ): Promise<SubmitMessageResponse | undefined> {
    const reply = classifyVerificationReply(text);
    const code = reply.kind === 'code' ? reply.code : undefined;
    if (reply.kind === 'ordinary' && !input.verificationRequestId) return;
    if (!code && input.verificationRequestId)
      throw conflict('Send one verification code using 4 to 8 digits.');
    const incompatible = Boolean(input.attachmentIds?.length || input.forceNew);
    if (incompatible && input.verificationRequestId)
      throw conflict('Send the verification code by itself in the sign-in conversation.');
    const channel = input.channel ?? 'web';
    const client = await pool.connect();
    let reserved: { threadId: string; turnId: string; requestId: string } | undefined;
    try {
      await client.query('BEGIN');
      const thread = await lockThread(client, options.ownerId);
      if (input.threadId !== undefined && input.threadId !== thread.id)
        throw conflict('This conversation has been reset. Reload it before continuing.');
      const previous = (
        await client.query(
          `SELECT m.owner_id,m.thread_id,m.turn_id,m.reply_to_message_id,u.owner_id AS turn_owner_id,
           u.channel,v.request_id,v.status,v.code_fingerprint
           FROM messages m LEFT JOIN turns u ON u.id=m.turn_id
           LEFT JOIN chat_verification_submissions v ON v.message_id=m.id WHERE m.id=$1`,
          [input.clientMessageId],
        )
      ).rows[0];
      if (previous) {
        if (!previous.request_id) {
          await input.persistOrdinary?.(client);
          await client.query('COMMIT');
          return;
        }
        if (!code) throw conflict('Send one verification code using 4 to 8 digits.');
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
        await client.query('COMMIT');
        return {
          threadId: previous.thread_id,
          turnId: previous.turn_id,
          messageId: input.clientMessageId,
          messageText: previous.status === 'pending' ? pendingMessage : maskedMessage,
          verificationStatus:
            previous.status === 'pending' || previous.status === 'submitted'
              ? previous.status
              : 'unavailable',
        };
      }
      let turnId: string | undefined;
      if (input.replyToMessageId) {
        const target = (
          await client.query(
            `SELECT u.id FROM messages m JOIN turns u ON u.id=m.turn_id
             WHERE m.id=$1 AND m.owner_id=$2 AND u.owner_id=$2 AND u.channel=$3 AND m.thread_id=$4`,
            [input.replyToMessageId, options.ownerId, channel, thread.id],
          )
        ).rows[0];
        if (!target) throw conflict('The reply is unavailable in this conversation.');
        turnId = target.id;
      }
      const requests = await client.query<{ id: string; turn_id: string }>(
        `SELECT r.id,r.turn_id FROM credential_requests r JOIN turns u ON u.id=r.turn_id
         WHERE r.owner_id=$1 AND u.owner_id=$1 AND u.channel=$2 AND r.thread_id=$5
           AND r.kind='otp' AND r.status='pending' AND r.expires_at>now()
           AND ${waitingTurnSql('u', 'credentials')}
           AND ($3::uuid IS NULL OR r.turn_id=$3) AND ($4::text IS NULL OR r.id=$4)
           ORDER BY r.expires_at,r.id LIMIT 2 FOR UPDATE OF r`,
        [options.ownerId, channel, turnId ?? null, input.verificationRequestId ?? null, thread.id],
      );
      if (!requests.rowCount) {
        if (input.verificationRequestId) throw conflict(unavailableMessage);
        const waiting = await client.query(
          `SELECT 1 FROM credential_requests r JOIN turns u ON u.id=r.turn_id
           WHERE r.owner_id=$1 AND u.owner_id=$1 AND u.channel=$2 AND r.thread_id=$4
             AND r.kind='otp' AND (r.expires_at>now() OR $3::uuid IS NOT NULL OR
               NOT EXISTS(SELECT 1 FROM turns newer WHERE newer.owner_id=$1 AND newer.thread_id=$4
                 AND newer.source='user' AND newer.id<>u.id AND newer.started_at>u.started_at))
             AND ($3::uuid IS NULL OR r.turn_id=$3) LIMIT 1`,
          [options.ownerId, channel, turnId ?? null, thread.id],
        );
        if (waiting.rows[0]) throw conflict(unavailableMessage);
        await input.persistOrdinary?.(client);
        await client.query('COMMIT');
        return;
      }
      if (incompatible)
        throw conflict('Send the verification code by itself in the sign-in conversation.');
      if (!code) throw conflict('Send one verification code using 4 to 8 digits.');
      if (requests.rowCount !== 1)
        throw conflict(
          'More than one sign-in needs a code. Reply to the verification request you want to complete.',
        );
      const request = requests.rows[0]!;
      const codeFingerprint = await fingerprint(code, input);
      await client.query(
        `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,reply_to_message_id)
         VALUES($1,$2,'user',$3,$4,$5,$6)`,
        [
          input.clientMessageId,
          options.ownerId,
          pendingMessage,
          thread.id,
          request.turn_id,
          input.replyToMessageId ?? null,
        ],
      );
      await client.query(
        'INSERT INTO chat_verification_submissions(message_id,request_id,code_fingerprint) VALUES($1,$2,$3)',
        [input.clientMessageId, request.id, codeFingerprint],
      );
      await client.query('COMMIT');
      reserved = { threadId: thread.id, turnId: request.turn_id, requestId: request.id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    options.refresh();
    let status: 'submitted' | 'unavailable';
    try {
      const result = await options.submitCode(
        options.ownerId,
        reserved.turnId,
        code,
        reserved.requestId,
      );
      status = result.status === 'submitted' ? 'submitted' : 'unavailable';
    } catch {
      status = 'unavailable';
    }
    await pool.query(
      `WITH changed AS (
       UPDATE chat_verification_submissions SET status=$2 WHERE message_id=$1 RETURNING message_id
       ) UPDATE messages SET text=$3 WHERE id IN (SELECT message_id FROM changed)`,
      [input.clientMessageId, status, maskedMessage],
    );
    if (status !== 'submitted') {
      await pool.query(
        `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id)
         SELECT $1,$2,'assistant',$3,u.thread_id,u.id FROM turns u JOIN threads th ON th.id=u.thread_id
         WHERE u.id=$4 AND u.owner_id=$2 AND th.archived_at IS NULL`,
        [
          randomUUID(),
          options.ownerId,
          'The code could not be applied. Check the sign-in step, then send a fresh code when it is ready.',
          reserved.turnId,
        ],
      );
    }
    options.refresh();
    return {
      threadId: reserved.threadId,
      turnId: reserved.turnId,
      messageId: input.clientMessageId,
      messageText: maskedMessage,
      verificationStatus: status,
    };
  }

  return { pending, accept };
}

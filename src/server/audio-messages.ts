import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { AppDependencies } from './app.ts';
import { pool } from './db.ts';
import { ownerId, configuration } from './config.ts';
import { artifactView, localArtifacts } from './artifacts.ts';
import { lockThread, stopSignal, submitUserMessage } from './thread.ts';
import { transaction } from './transaction.ts';
import { refresh } from './events.ts';
import { SpeechSetupError } from './speech.ts';
import type { SubmitMessageResponse } from '../shared/contracts.ts';
import { classifyVerificationReply, securityCodeIn } from '../shared/verification-code.ts';
import { questionAnswerSchema } from '../shared/answer-choices.ts';

const audioMessageOptions = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

export const messageInput = z
  .object({
    text: z
      .string()
      .max(100_000)
      .transform((value) => (value.trim() ? value : ''))
      .default(''),
    displayText: z.string().max(1_000_000).optional(),
    attachmentIds: z.array(z.uuid()).default([]),
    replyToMessageId: z.uuid().optional(),
    questionAnswer: questionAnswerSchema.optional(),
    replyQuote: z.string().trim().min(1).max(4000).optional(),
    seenMessageId: z.uuid().optional(),
    clientMessageId: z.uuid().optional(),
    threadId: z.uuid().optional(),
    verificationRequestId: z.uuid().optional(),
  })
  .strict();

const conflict = () =>
  Object.assign(
    new Error(
      'This recording may already be in the conversation. Check before sending a new recording.',
    ),
    { statusCode: 409, retryable: false },
  );
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const privateConflict = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409, retryable: false });

export function registerAudioMessages(app: FastifyInstance, dependencies: AppDependencies) {
  const artifacts = dependencies.artifacts ?? localArtifacts;
  const active = new Map<AbortController, string | undefined>();
  let suspensions = 0;
  const cancel = (threadId?: string) => {
    for (const [controller, id] of active)
      if (!threadId || !id || id === threadId)
        controller.abort(privateConflict('This voice message was cancelled.'));
  };
  const pause = async <T>(operation: () => Promise<T>, threadId?: string) => {
    suspensions++;
    cancel(threadId);
    try {
      return await operation();
    } finally {
      suspensions--;
    }
  };
  app.addHook('preClose', async () => {
    suspensions++;
    cancel();
  });
  app.post('/api/messages/audio', audioMessageOptions, async (request, reply) => {
    if (suspensions)
      throw privateConflict('Work is stopping. Send the recording again when it finishes.');
    const arrival = stopSignal();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    active.set(controller, undefined);
    const abort = () => controller.abort();
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    const cleanup: Array<() => Promise<void>> = [];
    let submitting = false;
    try {
      const verificationRequests = (await dependencies.verification?.pending('web')) ?? [];
      signal.throwIfAborted();
      let recording: { bytes: Buffer; mimeType: string; name: string } | undefined;
      let rawMessage: unknown;
      for await (const part of request.parts({
        limits: {
          fileSize: 25 * 1024 * 1024,
          files: 1,
          fields: 1,
          parts: 2,
          fieldSize: 8 * 1024 * 1024,
        },
      })) {
        signal.throwIfAborted();
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || !part.mimetype.startsWith('audio/'))
            throw invalid('Choose an audio recording.');
          const bytes = await part.toBuffer();
          if (part.file.truncated || !bytes.length || bytes.length > 25 * 1024 * 1024)
            throw invalid('Choose an audio recording smaller than 25 MB.');
          recording = { bytes, mimeType: part.mimetype, name: part.filename || 'voice.webm' };
        } else {
          if (part.fieldname !== 'message' || part.valueTruncated || typeof part.value !== 'string')
            throw invalid('Check the voice message details.');
          try {
            rawMessage = JSON.parse(part.value);
          } catch {
            throw invalid('Check the voice message details.');
          }
        }
      }
      if (!recording) throw invalid('Choose an audio recording.');
      const input = messageInput
        .extend({ clientMessageId: z.uuid(), threadId: z.uuid() })
        .refine(
          (value) =>
            !value.questionAnswer ||
            ('custom' in value.questionAnswer &&
              Boolean(value.replyToMessageId) &&
              !value.verificationRequestId),
        )
        .parse(rawMessage);
      active.set(controller, input.threadId);
      signal.throwIfAborted();
      const speech = dependencies.speech;
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ input, mimeType: recording.mimeType, name: recording.name }))
        .update('\0')
        .update(recording.bytes)
        .digest('hex');
      const accepted = await transaction(async (client) => {
        const thread = await lockThread(client);
        if (thread.id !== input.threadId)
          throw Object.assign(
            new Error('This conversation has been reset. Reload it before continuing.'),
            { statusCode: 409 },
          );
        const stored = await client.query(
          'SELECT * FROM artifacts WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND deleting_at IS NULL',
          [input.attachmentIds, ownerId],
        );
        if (stored.rowCount !== input.attachmentIds.length)
          throw invalid('An attachment is unavailable.');
        const replyTarget = input.replyToMessageId
          ? (
              await client.query<{ turn_id: string }>(
                'SELECT turn_id FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3',
                [input.replyToMessageId, ownerId, thread.id],
              )
            ).rows[0]
          : undefined;
        if (input.replyToMessageId && !replyTarget)
          throw invalid('The reply is unavailable in this conversation.');
        const claimed = await client.query(
          'INSERT INTO audio_messages(owner_id,message_id,thread_id,fingerprint) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,message_id) DO NOTHING RETURNING message_id',
          [ownerId, input.clientMessageId, thread.id, fingerprint],
        );
        if (!claimed.rowCount) {
          const receipt = (
            await client.query(
              'SELECT fingerprint,response FROM audio_messages WHERE owner_id=$1 AND message_id=$2 AND thread_id=$3',
              [ownerId, input.clientMessageId, thread.id],
            )
          ).rows[0];
          if (!receipt || receipt.fingerprint !== fingerprint || !receipt.response)
            throw conflict();
          return {
            response: receipt.response as SubmitMessageResponse,
            attachments: [],
            replyTurnId: replyTarget?.turn_id,
          };
        }
        if (!speech || !speech.transcriptionConfigured)
          throw new SpeechSetupError(
            'Set up audio in Settings → General → Voice. Choose free voices or connect a voice service.',
          );
        if (
          !(dependencies.configuration?.() ?? configuration()).llmReady &&
          !verificationRequests.length
        )
          throw invalid('Connect an AI provider in Settings → Models before sending a message.');
        if (
          (await client.query('SELECT 1 FROM messages WHERE id=$1', [input.clientMessageId]))
            .rowCount
        )
          throw conflict();
        signal.throwIfAborted();
        return {
          response: undefined,
          attachments: input.attachmentIds.map((id) =>
            artifactView(stored.rows.find((file) => file.id === id)!),
          ),
          replyTurnId: replyTarget?.turn_id,
        };
      }, pool);
      if (accepted.response) return accepted.response;
      const usageIds = new Set<string>();
      const transcript = await speech!.transcribe(recording, signal, (usage) =>
        usageIds.add(usage.id),
      );
      signal.throwIfAborted();
      const text = [input.text, transcript].filter(Boolean).join('\n\n');
      const displayText = input.displayText;
      if (text.length > 100_000) throw invalid('Send a shorter voice message.');
      const codeLike =
        classifyVerificationReply(text).kind !== 'ordinary' || Boolean(securityCodeIn(text));
      let verificationRequestId = input.verificationRequestId;
      if (!verificationRequestId && verificationRequests.length) {
        const eligible = verificationRequests.filter(
          (pending) => !accepted.replyTurnId || pending.turnId === accepted.replyTurnId,
        );
        if (eligible.length !== 1)
          throw privateConflict(
            'Reply to the verification request you want to complete and record the code again.',
          );
        verificationRequestId = eligible[0].id;
      }
      const persist = async (client: PoolClient, response: SubmitMessageResponse) => {
        signal.throwIfAborted();
        await client.query(
          'UPDATE audio_messages SET response=$3 WHERE owner_id=$1 AND message_id=$2',
          [ownerId, input.clientMessageId, JSON.stringify(response)],
        );
        if (usageIds.size)
          await dependencies.attributeAudioUsage?.(client, [...usageIds], response.turnId);
      };
      submitting = true;
      const verification = await dependencies.verification?.accept(text, {
        ...input,
        verificationRequestId,
        receiptOnly: codeLike && !verificationRequestId && !input.replyToMessageId,
        channel: 'web',
        signal,
        persistVerification: persist,
      });
      if (verification) return verification;
      submitting = false;
      if (verificationRequestId)
        throw privateConflict('This verification request is no longer available.');
      if (!(dependencies.configuration?.() ?? configuration()).llmReady)
        throw invalid('Connect an AI provider in Settings → Models before sending a message.');
      signal.throwIfAborted();
      submitting = true;
      const submitted = await (dependencies.submitMessage ?? submitUserMessage)(
        text,
        accepted.attachments,
        {
          ...input,
          displayText,
          audioCaption: input.text,
          channel: 'web',
          stopSignal: arrival,
          prepareAttachments: async (client, threadId) => {
            signal.throwIfAborted();
            const clip = await artifacts.storeArtifact(
              recording.bytes,
              recording.name,
              recording.mimeType,
              threadId,
              client,
              (remove) => cleanup.push(remove),
            );
            signal.throwIfAborted();
            return [clip];
          },
          persistSubmission: (client, result) =>
            persist(client, {
              ...result,
              messageText: text,
              displayText,
              audioCaption: input.text,
            }),
        },
      );
      refresh();
      return { ...submitted, messageText: text, displayText, audioCaption: input.text };
    } catch (error) {
      if (!submitting && !signal.aborted && error instanceof Error && !('retryable' in error))
        Object.assign(error, { retryable: true });
      throw error;
    } finally {
      active.delete(controller);
      request.raw.off('aborted', abort);
      reply.raw.off('close', abort);
      await Promise.all(cleanup.map((remove) => remove().catch(() => {})));
    }
  });
  return { pause };
}

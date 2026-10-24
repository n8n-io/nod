import type { PoolClient } from 'pg';
import type { MessagingAttachment } from '../ports/messaging.ts';
import { MessagingAttachmentError } from '../ports/messaging.ts';
import type { ArtifactService } from './artifacts.ts';
import type { SpeechService } from './speech.ts';
import { SpeechSetupError, TranscriptionLengthError } from './speech.ts';
import { spendingLimitReached } from './ledger.ts';

export class ChannelMediaFailure extends Error {
  constructor(
    readonly reason:
      | 'too_large'
      | 'text_too_long'
      | 'spending_limit'
      | 'unavailable'
      | 'transcription_unavailable'
      | 'speech_setup_required',
    readonly fileLimitMb?: number,
  ) {
    super(reason);
  }
}

export function createChannelMedia(options: {
  artifacts: Pick<ArtifactService, 'storeArtifact'>;
  speech: Pick<SpeechService, 'transcribe'>;
}) {
  return {
    async prepare(
      attachments: MessagingAttachment[],
      signal: AbortSignal,
      beforeTranscribe?: () => Promise<void>,
    ) {
      if (!attachments.length) throw new ChannelMediaFailure('unavailable');
      if (attachments.length > 10) throw new ChannelMediaFailure('too_large');
      const files: {
        bytes: Buffer;
        name: string;
        mimeType: string;
        source?: MessagingAttachment['source'];
      }[] = [];
      const transcripts: string[] = [];
      const usageIds = new Set<string>();
      const cleanup: Array<() => Promise<void>> = [];
      let total = 0;
      for (const attachment of attachments) {
        signal.throwIfAborted();
        if (attachment.size > 50 * 1024 * 1024) throw new ChannelMediaFailure('too_large');
        let bytes: Buffer;
        try {
          bytes = Buffer.from(await attachment.read(signal));
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof MessagingAttachmentError)
            throw new ChannelMediaFailure('too_large', error.maxBytes / 1024 / 1024);
          throw new ChannelMediaFailure('unavailable');
        }
        signal.throwIfAborted();
        total += bytes.length;
        if (!bytes.length) throw new ChannelMediaFailure('unavailable');
        if (attachment.size && bytes.length !== attachment.size)
          throw new ChannelMediaFailure('unavailable');
        if (total > 50 * 1024 * 1024) throw new ChannelMediaFailure('too_large');
        if (attachment.voice) {
          if (!attachment.mimeType.startsWith('audio/'))
            throw new ChannelMediaFailure('unavailable');
          if (bytes.length > 25 * 1024 * 1024) throw new ChannelMediaFailure('too_large');
          try {
            await beforeTranscribe?.();
            transcripts.push(
              await options.speech.transcribe({ ...attachment, bytes }, signal, (usage) => {
                usageIds.add(usage.id);
              }),
            );
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof SpeechSetupError)
              throw new ChannelMediaFailure('speech_setup_required');
            if (error instanceof TranscriptionLengthError)
              throw new ChannelMediaFailure('text_too_long');
            if (error instanceof Error && error.message === spendingLimitReached)
              throw new ChannelMediaFailure('spending_limit');
            throw new ChannelMediaFailure('transcription_unavailable');
          }
        }
        files.push({
          bytes,
          name: attachment.name,
          mimeType: attachment.mimeType,
          source: attachment.source,
        });
      }
      return {
        text: transcripts.join('\n\n'),
        usageIds: [...usageIds],
        async save(client: PoolClient, threadId?: string) {
          const saved = [];
          for (const file of files) {
            signal.throwIfAborted();
            const artifact = await options.artifacts.storeArtifact(
              file.bytes,
              file.name,
              file.mimeType,
              threadId,
              client,
              (remove) => cleanup.push(remove),
            );
            saved.push({ ...artifact, ...(file.source ? { source: file.source } : {}) });
          }
          return saved;
        },
        async dispose() {
          await Promise.all(cleanup.map((remove) => remove()));
        },
      };
    },
  };
}

export type ChannelMedia = ReturnType<typeof createChannelMedia>;

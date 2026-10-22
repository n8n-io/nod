import type { PoolClient } from 'pg';
import type { MessagingAttachment } from '../ports/messaging.ts';
import { MessagingAttachmentError } from '../ports/messaging.ts';
import type { ArtifactService } from './artifacts.ts';
import type { SpeechService } from './speech.ts';
import { TranscriptionLengthError } from './speech.ts';
import { spendingLimitReached } from './ledger.ts';

export class ChannelMediaFailure extends Error {
  constructor(
    readonly reason:
      | 'too_large'
      | 'text_too_long'
      | 'spending_limit'
      | 'unavailable'
      | 'transcription_unavailable',
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
    async prepare(attachments: MessagingAttachment[], signal: AbortSignal) {
      if (!attachments.length || attachments.length > 10)
        throw new ChannelMediaFailure('too_large');
      const files: { bytes: Buffer; name: string; mimeType: string }[] = [];
      const transcripts: string[] = [];
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
        if (
          !bytes.length ||
          total > 50 * 1024 * 1024 ||
          (attachment.size && bytes.length !== attachment.size)
        )
          throw new ChannelMediaFailure('too_large');
        if (attachment.voice) {
          if (!attachment.mimeType.startsWith('audio/') || bytes.length > 25 * 1024 * 1024)
            throw new ChannelMediaFailure('too_large');
          try {
            transcripts.push(await options.speech.transcribe({ ...attachment, bytes }, signal));
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof TranscriptionLengthError)
              throw new ChannelMediaFailure('text_too_long');
            if (error instanceof Error && error.message === spendingLimitReached)
              throw new ChannelMediaFailure('spending_limit');
            throw new ChannelMediaFailure('transcription_unavailable');
          }
        }
        files.push({ bytes, name: attachment.name, mimeType: attachment.mimeType });
      }
      return {
        text: transcripts.join('\n\n'),
        async save(client: PoolClient, threadId?: string) {
          const saved = [];
          for (const file of files) {
            signal.throwIfAborted();
            saved.push(
              await options.artifacts.storeArtifact(
                file.bytes,
                file.name,
                file.mimeType,
                threadId,
                client,
                (remove) => cleanup.push(remove),
              ),
            );
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

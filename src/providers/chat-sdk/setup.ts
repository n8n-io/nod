import { createHash } from 'node:crypto';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { ConsoleLogger } from 'chat';
import { z } from 'zod';
import type { ChannelPairingRequest, MessagingChannel } from '../../ports/messaging.ts';
import type { SetupJournal } from '../../ports/setup.ts';
import { channelConfiguration } from './index.ts';
import { telegramPairing } from './telegram.ts';

const updatesSchema = z.object({
  ok: z.literal(true),
  result: z
    .array(z.object({ update_id: z.number().int().nonnegative(), message: z.unknown().optional() }))
    .max(100),
});
const capturedSchema = z.object({
  configurationId: z.string().regex(/^[a-f0-9]{64}$/),
  updateId: z.number().int().nonnegative(),
});

export function createSetupTelegram(options: {
  journal: SetupJournal;
  pair(request: ChannelPairingRequest): Promise<boolean>;
  fetch?: typeof fetch;
}) {
  const request = options.fetch ?? fetch;
  let environment: Record<string, string | undefined> = {};
  let closed = false;
  let generation = 0;
  let stop = new AbortController();
  const pending = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changes: Promise<void> = Promise.resolve();
  function channels(): MessagingChannel[] {
    return channelConfiguration(environment).map((entry) => ({
      id: entry.provider,
      status: entry.status,
      missing: entry.missing,
      accountId:
        entry.provider === 'telegram'
          ? environment.TELEGRAM_BOT_TOKEN?.split(':')[0]
          : environment.WHATSAPP_PHONE_NUMBER_ID,
      allowedSenderIds:
        (entry.provider === 'telegram'
          ? environment.TELEGRAM_ALLOWED_USER_ID
          : environment.WHATSAPP_ALLOWED_NUMBER
        )?.split(',') ?? [],
    }));
  }
  function interrupt() {
    generation++;
    clearTimeout(timer);
    stop.abort();
  }
  async function start(next: Record<string, string | undefined>) {
    interrupt();
    if (closed) return;
    environment = { ...next };
    if (
      environment.TELEGRAM_ENABLED !== 'true' ||
      environment.TELEGRAM_MODE !== 'polling' ||
      environment.TELEGRAM_ALLOWED_USER_ID ||
      environment.TELEGRAM_PAIRING_CANDIDATE ||
      !environment.TELEGRAM_PAIRING_CODE_HASH ||
      !channels().some((channel) => channel.id === 'telegram' && channel.status === 'configured')
    )
      return;
    const expiresAt = Number(environment.TELEGRAM_PAIRING_EXPIRES_AT);
    if (!(expiresAt > Date.now())) return;
    const token = environment.TELEGRAM_BOT_TOKEN!;
    const configurationId = createHash('sha256')
      .update(JSON.stringify([token, environment.TELEGRAM_PAIRING_CODE_HASH, expiresAt]))
      .digest('hex');
    const saved = capturedSchema.safeParse(await options.journal.read('telegram-pairing'));
    if (saved.success && saved.data.configurationId === configurationId) return;
    const adapter = createTelegramAdapter({
      botToken: token,
      secretToken: environment.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
      allowedUserIds: [],
      mode: 'webhook',
      allowUnverifiedWebhooks: false,
      apiUrl: 'https://api.telegram.org',
      logger: new ConsoleLogger('silent'),
    });
    stop = new AbortController();
    const controller = stop;
    const revision = generation;
    const current = () =>
      !closed && revision === generation && !controller.signal.aborted && Date.now() < expiresAt;
    async function poll() {
      let captured = false;
      try {
        if (!current()) return;
        const response = await request(`https://api.telegram.org/bot${token}/getUpdates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 100, timeout: 0, allowed_updates: ['message'] }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok || !current()) return;
        const updates = updatesSchema.parse(await response.json());
        for (const update of updates.result) {
          if (!current()) break;
          const candidate = telegramPairing(
            update.message,
            token.split(':')[0],
            ({ reply_to_message: _reply, ...message }) => adapter.parseMessage(message),
          );
          if (!candidate || !(await options.pair(candidate))) continue;
          captured = true;
          await options.journal.update('telegram-pairing', () => ({
            configurationId,
            updateId: update.update_id,
          }));
          break;
        }
      } catch {
      } finally {
        if (current() && !captured) {
          timer = setTimeout(() => {
            launch();
          }, 1500);
          timer.unref();
        }
      }
    }
    function launch() {
      const operation = poll();
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
    }
    launch();
  }
  return {
    channels,
    apply(next: Record<string, string | undefined>) {
      const applied = changes.then(() => start(next));
      changes = applied.catch(() => {});
      return applied;
    },
    async close() {
      closed = true;
      interrupt();
      await changes;
      await Promise.all(pending);
    },
  };
}

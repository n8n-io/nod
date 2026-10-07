import type { Agent, ModelUsageObservation } from '../ports/agent.ts';
import type { Computer, Workspace } from '../ports/computer.ts';
import type { IntegrationProvider, IntegrationSession } from '../ports/integrations.ts';
import type { MessagingTransport } from '../ports/messaging.ts';
import type { MemoryCurator } from '../ports/memory-curator.ts';
import type { RelevanceClassifier } from '../ports/relevance.ts';
import type { SpeechProvider } from '../ports/speech.ts';
import type { ProviderUsageStore } from './provider-usage.ts';

export function meterAgent(agent: Agent, usage: ProviderUsageStore): Agent {
  return {
    ...agent,
    async open(options) {
      let started = performance.now();
      return agent.open({
        ...options,
        onEvent(event) {
          if (event.type === 'turn_start') started = performance.now();
          if (event.type === 'model_usage') {
            const value: ModelUsageObservation = event;
            usage.record({
              id: value.id,
              provider: value.provider,
              category: 'agent',
              operation: 'response',
              model: value.model,
              turnId: options.turnId,
              status: value.status ?? 'succeeded',
              durationMs: performance.now() - started,
              inputTokens: value.inputTokens,
              outputTokens: value.outputTokens,
              cacheReadTokens: value.cacheReadTokens,
              cacheWriteTokens: value.cacheWriteTokens,
              costUsd: value.costUsd,
              pricing: value.costSource,
            });
          }
          if (event.type === 'provider_usage')
            usage.record({ ...event.usage, turnId: options.turnId });
          else options.onEvent(event);
        },
      });
    },
  };
}

export function meterComputer(computer: Computer, usage: ProviderUsageStore): Computer {
  const base = { provider: 'agent-browser', category: 'browser' as const };
  return {
    ...computer,
    act: (id, input, signal) =>
      usage.track({ ...base, operation: input.action }, () => computer.act(id, input, signal)),
    screenshot: (id, signal) =>
      usage.track(
        { ...base, operation: 'screenshot' },
        () => computer.screenshot(id, signal),
        (value) => ({ bytes: value?.byteLength ?? 0 }),
      ),
    currentPage: (id) =>
      usage.track({ ...base, operation: 'current_page' }, () => computer.currentPage(id)),
    injectCredentials: (input) =>
      usage.track({ ...base, operation: 'secure_entry' }, () => computer.injectCredentials(input)),
    control: computer.control
      ? (id, input, signal) =>
          usage.track({ ...base, operation: `handoff_${input.type}` }, () =>
            computer.control!(id, input, signal),
          )
      : undefined,
  };
}

export function meterWorkspace(workspace: Workspace, usage: ProviderUsageStore): Workspace {
  return {
    ...workspace,
    ...(workspace.readArtifact
      ? {
          readArtifact: (
            id: string,
            path: string,
            maxBytes: number,
            purpose?: 'attachment' | 'publication',
          ) =>
            usage.track(
              {
                provider: 'local-workspace',
                category: 'workspace',
                operation:
                  purpose === 'publication'
                    ? 'publish_file'
                    : purpose === 'attachment'
                      ? 'read_attachment'
                      : 'read_file',
              },
              () => workspace.readArtifact!(id, path, maxBytes, purpose),
            ),
        }
      : {}),
    open(input) {
      const session = workspace.open(input);
      const base = {
        provider: 'local-workspace',
        category: 'workspace' as const,
      };
      return {
        ...session,
        exec: (command, options) =>
          usage.track(
            { ...base, operation: 'execute' },
            () => session.exec(command, options),
            (result) => ({ status: result.exitCode === 0 ? 'succeeded' : 'failed' }),
          ),
        ...(session.executeProgram
          ? {
              executeProgram: (
                program: string,
                args: string[],
                environment: Record<string, string>,
                timeout?: number,
              ) =>
                usage.track(
                  { ...base, operation: 'execute' },
                  () => session.executeProgram!(program, args, environment, timeout),
                  (result) => ({ status: result.exitCode === 0 ? 'succeeded' : 'failed' }),
                ),
            }
          : {}),
      };
    },
  };
}

export function meterIntegrations(
  provider: IntegrationProvider,
  usage: ProviderUsageStore,
): IntegrationProvider {
  const base = { provider: provider.id, category: 'integration' as const };
  function session(value: IntegrationSession): IntegrationSession {
    return {
      ...value,
      authorize: (service, url) =>
        usage.track({ ...base, operation: 'authorize' }, () => value.authorize(service, url)),
      search: (query, signal) =>
        usage.track({ ...base, operation: 'search' }, () => value.search(query, signal)),
      execute: (action, args, account, signal) =>
        usage.track({ ...base, operation: 'execute' }, () =>
          value.execute(action, args, account, signal),
        ),
      download: value.download
        ? (action, args, account, signal) =>
            usage.track(
              { ...base, operation: 'download_file' },
              () => value.download!(action, args, account, signal),
              (file) => ({ bytes: file.bytes.byteLength }),
            )
        : undefined,
      upload: value.upload
        ? (action, file, signal) =>
            usage.track({ ...base, operation: 'upload_file', bytes: file.bytes.byteLength }, () =>
              value.upload!(action, file, signal),
            )
        : undefined,
    };
  }
  return {
    ...provider,
    get configured() {
      return provider.configured;
    },
    get webhooksConfigured() {
      return provider.webhooksConfigured;
    },
    setApiKey: provider.setApiKey?.bind(provider),
    createSession: async (owner, accounts, signal) =>
      session(
        await usage.track({ ...base, operation: 'create_session' }, () =>
          provider.createSession(owner, accounts, signal),
        ),
      ),
    restoreSession: async (id, signal) =>
      session(
        await usage.track({ ...base, operation: 'restore_session' }, () =>
          provider.restoreSession(id, signal),
        ),
      ),
    deleteSession: (id) =>
      usage.track({ ...base, operation: 'delete_session' }, () => provider.deleteSession(id)),
    inspectAccount: (id, owner) =>
      usage.track({ ...base, operation: 'inspect_account' }, () =>
        provider.inspectAccount(id, owner),
      ),
    pollInbox: provider.pollInbox
      ? (id, cursor, signal) =>
          usage.track({ ...base, operation: 'poll_inbox' }, () =>
            provider.pollInbox!(id, cursor, signal),
          )
      : undefined,
    deleteAccount: (id) =>
      usage.track({ ...base, operation: 'delete_account' }, () => provider.deleteAccount(id)),
    subscribe: (owner, service, account) =>
      usage.track({ ...base, operation: 'subscribe' }, () =>
        provider.subscribe(owner, service, account),
      ),
    unsubscribe: (id) =>
      usage.track({ ...base, operation: 'unsubscribe' }, () => provider.unsubscribe(id)),
  };
}

export function meterRelevance(
  provider: RelevanceClassifier,
  usage: ProviderUsageStore,
): RelevanceClassifier {
  return {
    ...provider,
    get configured() {
      return provider.configured;
    },
    classify: (context, policy, signal) =>
      usage.track({ provider: provider.id, category: 'relevance', operation: 'classify' }, () =>
        provider.classify(context, policy, signal),
      ),
  };
}

export function meterMemoryCurator(
  provider: MemoryCurator,
  usage: ProviderUsageStore,
): MemoryCurator {
  return {
    ...provider,
    get configured() {
      return provider.configured;
    },
    curate: (request, signal) =>
      usage.track(
        {
          provider: provider.id,
          category:
            request.task === 'review' ? 'review' : request.task === 'progress' ? 'tasks' : 'memory',
          operation: request.task,
        },
        () => provider.curate(request, signal),
      ),
  };
}

export function meterSpeech(provider: SpeechProvider, usage: ProviderUsageStore): SpeechProvider {
  const base = { provider: provider.id, category: 'speech' as const };
  return {
    ...provider,
    synthesize: (text, signal) =>
      usage.track(
        { ...base, operation: 'synthesize', characters: [...text].length },
        () => provider.synthesize(text, signal),
        (value) => ({ bytes: value.bytes.byteLength }),
      ),
  };
}

export function meterMessaging(
  transport: MessagingTransport,
  usage: ProviderUsageStore,
): MessagingTransport {
  return {
    ...transport,
    ...(transport.poll
      ? {
          poll: async (
            accept: Parameters<NonNullable<MessagingTransport['poll']>>[0],
            pair?: Parameters<NonNullable<MessagingTransport['poll']>>[1],
          ) => {
            if (
              transport.pollingEnabled === false ||
              !transport.channels.some(
                (channel) => channel.id === 'telegram' && channel.status === 'configured',
              )
            )
              return transport.poll!(accept, pair);
            return usage.track(
              { provider: 'telegram', category: 'channel', operation: 'poll' },
              () =>
                transport.poll!(async (message) => {
                  await accept(message);
                  usage.record({
                    provider: 'telegram',
                    category: 'channel',
                    operation: 'receive',
                    status: 'succeeded',
                    durationMs: 0,
                    messages: 1,
                  });
                }, pair),
            );
          },
        }
      : {}),
    receive: async (input) =>
      usage.track(
        { provider: input.channelId, category: 'channel', operation: 'webhook' },
        () => transport.receive(input),
        (result) => ({
          status: result.status >= 400 ? 'failed' : 'succeeded',
          messages: result.messages?.length ?? 0,
        }),
      ),
    post: (input) =>
      usage.track(
        { provider: input.channelId, category: 'channel', operation: 'send' },
        () => transport.post(input),
        () => ({
          messages: 1,
          bytes: input.attachments?.reduce((sum, item) => sum + item.bytes.byteLength, 0) ?? 0,
        }),
      ),
  };
}

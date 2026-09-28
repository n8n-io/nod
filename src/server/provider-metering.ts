import type { Agent, ModelUsageObservation } from '../ports/agent.ts';
import { z } from 'zod';
import type { Computer, Workspace } from '../ports/computer.ts';
import type { IntegrationProvider, IntegrationSession } from '../ports/integrations.ts';
import type { MessagingTransport } from '../ports/messaging.ts';
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
              taskId: options.taskId,
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
            usage.record({ ...event.usage, taskId: options.taskId });
          else options.onEvent(event);
        },
      });
    },
  };
}

export function meterComputer(computer: Computer, usage: ProviderUsageStore): Computer {
  const base = { provider: 'agent-browser', category: 'browser' as const };
  const taskScope = (id: string) => (z.uuid().safeParse(id).success ? { taskId: id } : {});
  return {
    ...computer,
    act: (id, input, signal) =>
      usage.track({ ...base, taskId: id, operation: input.action }, () =>
        computer.act(id, input, signal),
      ),
    screenshot: (id, signal) =>
      usage.track(
        { ...base, taskId: id, operation: 'screenshot' },
        () => computer.screenshot(id, signal),
        (value) => ({ bytes: value?.byteLength ?? 0 }),
      ),
    inspectLogin: (id) =>
      usage.track({ ...base, taskId: id, operation: 'inspect_login' }, () =>
        computer.inspectLogin(id),
      ),
    injectCredentials: (input) =>
      usage.track({ ...base, taskId: input.taskId, operation: 'secure_entry' }, () =>
        computer.injectCredentials(input),
      ),
    selectLoginMethod: (id, origin, method) =>
      usage.track({ ...base, taskId: id, operation: 'select_login_method' }, () =>
        computer.selectLoginMethod(id, origin, method),
      ),
    ...(computer.takeControl
      ? {
          takeControl: (id: string) =>
            usage.track({ ...base, taskId: id, operation: 'take_control' }, () =>
              computer.takeControl!(id),
            ),
        }
      : {}),
    ...(computer.control
      ? {
          control: (id: string, input: Parameters<NonNullable<Computer['control']>>[1]) =>
            usage.track({ ...base, taskId: id, operation: 'manual_input' }, () =>
              computer.control!(id, input),
            ),
        }
      : {}),
    ...(computer.openSignIn
      ? {
          openSignIn: (id: string) =>
            usage.track({ ...base, ...taskScope(id), operation: 'open_sign_in' }, () =>
              computer.openSignIn!(id),
            ),
        }
      : {}),
    ...(computer.finishSignIn
      ? {
          finishSignIn: (id: string) =>
            usage.track({ ...base, ...taskScope(id), operation: 'finish_sign_in' }, () =>
              computer.finishSignIn!(id),
            ),
        }
      : {}),
    ...(computer.releaseControl
      ? {
          releaseControl: (id: string) =>
            usage.track({ ...base, ...taskScope(id), operation: 'release_control' }, () =>
              computer.releaseControl!(id),
            ),
        }
      : {}),
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
                taskId: id,
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
        taskId: input.taskId,
      };
      return {
        ...session,
        execute: (command, timeout) =>
          usage.track({ ...base, operation: 'execute' }, () => session.execute(command, timeout)),
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
        readFile: (path) =>
          usage.track({ ...base, operation: 'read_file' }, () => session.readFile(path)),
        writeFile: (path, content) =>
          usage.track({ ...base, operation: 'write_file' }, () => session.writeFile(path, content)),
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
      search: (query) => usage.track({ ...base, operation: 'search' }, () => value.search(query)),
      execute: (action, args, account) =>
        usage.track({ ...base, operation: 'execute' }, () => value.execute(action, args, account)),
      download: value.download
        ? (action, args, account, signal) =>
            usage.track(
              { ...base, operation: 'download_file' },
              () => value.download!(action, args, account, signal),
              (file) => ({ bytes: file.bytes.byteLength }),
            )
        : undefined,
    };
  }
  return {
    ...provider,
    createSession: async (owner, accounts) =>
      session(
        await usage.track({ ...base, operation: 'create_session' }, () =>
          provider.createSession(owner, accounts),
        ),
      ),
    restoreSession: async (id) =>
      session(
        await usage.track({ ...base, operation: 'restore_session' }, () =>
          provider.restoreSession(id),
        ),
      ),
    deleteSession: (id) =>
      usage.track({ ...base, operation: 'delete_session' }, () => provider.deleteSession(id)),
    inspectAccount: (id, owner) =>
      usage.track({ ...base, operation: 'inspect_account' }, () =>
        provider.inspectAccount(id, owner),
      ),
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
    classify: (context, policy, signal) =>
      usage.track({ provider: provider.id, category: 'relevance', operation: 'classify' }, () =>
        provider.classify(context, policy, signal),
      ),
  };
}

export function meterSpeech(provider: SpeechProvider, usage: ProviderUsageStore): SpeechProvider {
  const base = { provider: provider.id, category: 'speech' as const };
  return {
    ...provider,
    transcribe: (input, signal) =>
      usage.track({ ...base, operation: 'transcribe', bytes: input.bytes.byteLength }, () =>
        provider.transcribe(input, signal),
      ),
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
          poll: async (accept: Parameters<NonNullable<MessagingTransport['poll']>>[0]) => {
            if (
              transport.pollingEnabled === false ||
              !transport.channels.some(
                (channel) => channel.id === 'telegram' && channel.status === 'configured',
              )
            )
              return transport.poll!(accept);
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
                }),
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

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import type { Agent } from '../ports/agent.ts';
import type { BrowserChooser, Computer, Workspace } from '../ports/computer.ts';
import type { IntegrationProvider, IntegrationService } from '../ports/integrations.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { RelevanceClassifier } from '../ports/relevance.ts';
import type { SpeechProvider } from '../ports/speech.ts';
import type { MessagingTransport } from '../ports/messaging.ts';
import type { ChannelAccountRegistry, ChannelSetupVerifier } from '../ports/channel-settings.ts';
import type { PrivateObjectStore } from '../ports/object-storage.ts';
import type { LinkPreviewProvider } from '../ports/link-preview.ts';
import type { ConversationRouter } from '../ports/conversation.ts';
import type { RecordProviderUsage } from '../ports/provider-usage.ts';
import { agentModels } from '../shared/model-defaults.ts';
import { createChatSdkTransport } from '../providers/chat-sdk/index.ts';
import { createChatSdkSetupVerifier } from '../providers/chat-sdk/settings.ts';
import { createContainerBrowserComputer } from '../providers/container-browser/index.ts';
import { createComposioProvider } from '../providers/composio/integrations.ts';
import { createDirectProvider } from '../providers/direct/integrations.ts';
import { createDiscoveredTransport } from '../providers/discovered/remote.ts';
import { createDiscoveredOAuth } from '../providers/discovered/oauth.ts';
import { createDiscoveredConnections } from './discovered-connections.ts';
import { createAppGrantVault } from './vault-app-grants.ts';
import { createDockerWorkspace } from '../providers/docker/index.ts';
import { createE2BAdapters } from '../providers/e2b/index.ts';
import { createCloudflareAdapters } from '../providers/cloudflare-computer/index.ts';
import { createFilesystemObjectStore } from '../providers/object-storage/filesystem.ts';
import { createHttpObjectStore } from '../providers/object-storage/http.ts';
import {
  createEnvironmentKeyStore,
  parseCredentialKey,
} from '../providers/environment/key-store.ts';
import { createGoogleAuthentication } from '../providers/better-auth/index.ts';
import { createCloudflareRuntimeTransport } from '../providers/runtime-host/cloudflare.ts';
import { createLocalRuntimeTransport } from '../providers/runtime-host/local.ts';
import { createComputerShutdownConfirmation } from '../providers/runtime-host/computer-shutdown.ts';
import { createJevBrowserChooser } from '../providers/jev/browser.ts';
import { createJevRelevanceClassifier } from '../providers/jev/relevance.ts';
import { createKeychainKeyStore } from '../providers/keychain/key-store.ts';
import { createOpenAIRelevanceClassifier } from '../providers/openai/relevance.ts';
import { createOpenAISpeechProvider } from '../providers/openai/speech.ts';
import { createPiAgent } from '../providers/pi/index.ts';
import { createPiConversationRouter } from '../providers/pi/conversation.ts';
import { createPublicLinkPreviewProvider } from '../providers/public-web/link-preview.ts';
import { createWebSearch } from '../providers/public-web/search.ts';
import { createAgentRuntime } from '../runtime/index.ts';
import { createApp } from './app.ts';
import { createWorkAdmission, createWorkConsumers } from './work-admission.ts';
import { createTenantDrain } from './tenant-drain.ts';
import { createChatVerification } from './chat-verification.ts';
import { createAgentReactionService } from './agent-reactions.ts';
import { createApprovals } from './approvals.ts';
import { createArtifactService, localArtifacts } from './artifacts.ts';
import { createChannels } from './channels.ts';
import { createChannelSettings } from './channel-settings.ts';
import {
  configuration,
  dataRoot,
  ownerId,
  publicOrigin,
  runtimeGeneration,
  runtimeMode,
} from './config.ts';
import { createAccountStore } from './account-store.ts';
import { createAccountSession } from './account.ts';
import { createComputerAllocationStore } from './computer-allocations.ts';
import { createPostgresObjectStore } from './object-storage.ts';
import { createGateway } from './gateway.ts';
import { createTenantStore } from './tenants.ts';
import { createTenantRuntimeHost } from './runtime-host.ts';
import { createChannelAccountRegistry } from './channel-account-registry.ts';
import { createTenantControl, createTenantChannelRegistry } from './tenant-control.ts';
import { createHostedWebhooks } from './hosted-webhooks.ts';
import { loadPrivacyNoticeFile, registerPrivacyNotice } from './privacy.ts';
import { createInspectorPool, initializeDatabase, pool } from './db.ts';
import { events, refresh } from './events.ts';
import { createIntegrations } from './integrations.ts';
import { createInspectorStore } from './inspector.ts';
import { createPromptInspector } from './inspector-prompts.ts';
import { createInspectorWork } from './inspector-work.ts';
import { createPersonalService } from './personal.ts';
import { createSpeech } from './speech.ts';
import {
  boss,
  createUserMessageService,
  initializeTasks,
  pauseOwnedTaskForControl,
  resumeOwnedTaskFromControl,
  resumeTask,
  resumeConnectedTask,
  restartOnboarding,
  retryTaskCredentials,
  startTaskWorkers,
  stopTasks,
  submitTask,
} from './tasks.ts';
import { createTriage } from './triage.ts';
import { createVault } from './vault.ts';
import { createTakeover } from './takeover.ts';
import { createProviderUsageStore } from './provider-usage.ts';
import { createLinkPreviews } from './link-previews.ts';
import {
  meterAgent,
  meterComputer,
  meterWorkspace,
  meterIntegrations,
  meterRelevance,
  meterSpeech,
  meterMessaging,
} from './provider-metering.ts';

export interface ApplicationAdapters {
  initialize?(): Promise<void>;
  prepareComputer?(): Promise<void>;
  computerLifecycle?: { pause(): Promise<void>; resume(): Promise<void> };
  confirmComputerShutdown?(): Promise<void>;
  objectStore?: PrivateObjectStore;
  channelAccounts?: ChannelAccountRegistry;
  createConversationRouter?(onUsage: RecordProviderUsage): ConversationRouter;
  agent: Agent;
  computer: Computer;
  workspace: Workspace;
  speech: SpeechProvider;
  integrations: IntegrationProvider;
  directIntegrations?: (
    pool: pg.Pool,
    keyStore: CredentialKeyStore,
    grantVault: Awaited<ReturnType<typeof createAppGrantVault>>,
    ownerId: string,
  ) => IntegrationProvider;
  keyStore: CredentialKeyStore;
  relevance: RelevanceClassifier;
  messaging?: MessagingTransport;
  linkPreviews?: LinkPreviewProvider;
  messagingSetup?: {
    verifier: ChannelSetupVerifier;
    create(environment: Record<string, string>): MessagingTransport;
  };
  chooseBrowserAction?: BrowserChooser;
  model: { provider: string; name: string; configured: boolean };
}

export function createDefaultAdapters(
  env: Record<string, string | undefined> = process.env,
): ApplicationAdapters {
  const provider = env.LLM_PROVIDER || 'openai';
  if (!['openai', 'anthropic'].includes(provider))
    throw new Error('LLM_PROVIDER must be openai or anthropic.');
  const apiKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  const model = env.LLM_MODEL || agentModels[provider as keyof typeof agentModels];
  const authConfigs: Partial<Record<IntegrationService, string>> = {
    gmail: env.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
    googlecalendar: env.COMPOSIO_CALENDAR_AUTH_CONFIG_ID,
    googledrive: env.COMPOSIO_DRIVE_AUTH_CONFIG_ID,
    googlesheets: env.COMPOSIO_SHEETS_AUTH_CONFIG_ID,
    googledocs: env.COMPOSIO_DOCS_AUTH_CONFIG_ID,
    slack: env.COMPOSIO_SLACK_AUTH_CONFIG_ID,
    notion: env.COMPOSIO_NOTION_AUTH_CONFIG_ID,
  };
  const computerProvider = env.COMPUTER_PROVIDER || 'docker';
  if (
    !['docker', 'e2b', 'cloudflare'].includes(computerProvider) ||
    (runtimeMode === 'tenant' && computerProvider === 'docker') ||
    (computerProvider === 'cloudflare' && runtimeMode !== 'tenant')
  )
    throw new Error('Configure a supported, isolated computer provider.');
  const allocations =
    computerProvider === 'e2b'
      ? createComputerAllocationStore({ database: pool, ownerId })
      : undefined;
  if (computerProvider === 'e2b' && (!env.E2B_API_KEY || !env.E2B_COMPUTER_TEMPLATE))
    throw new Error('The remote computer configuration is incomplete.');
  if (
    computerProvider === 'e2b' &&
    (env.E2B_BROWSER_TEMPLATE !== undefined || env.E2B_WORKSPACE_TEMPLATE !== undefined)
  )
    throw new Error(
      'Split E2B templates are no longer supported. Configure E2B_COMPUTER_TEMPLATE.',
    );
  const e2b = allocations
    ? createE2BAdapters({
        apiKey: env.E2B_API_KEY!,
        ownerId,
        allocations,
        templateId: env.E2B_COMPUTER_TEMPLATE!,
        workspaceRoot: join(dataRoot, 'workspaces'),
        ...(env.E2B_SANDBOX_TIMEOUT_MS
          ? { sandboxTimeoutMs: Number(env.E2B_SANDBOX_TIMEOUT_MS) }
          : {}),
      })
    : undefined;
  const remote =
    computerProvider === 'cloudflare'
      ? createCloudflareAdapters({
          ownerId,
          generation: runtimeGeneration,
          workspaceRoot: join(dataRoot, 'workspaces'),
        })
      : e2b;
  const databaseObjects =
    env.OBJECT_STORAGE_PROVIDER === 'postgres'
      ? createPostgresObjectStore({ database: pool, ownerId })
      : undefined;
  const objectStore =
    databaseObjects ??
    (env.OBJECT_STORAGE_PROVIDER === 'http'
      ? createHttpObjectStore({
          endpoint: env.OBJECT_STORAGE_ENDPOINT,
          ...(runtimeMode === 'tenant' ? { generation: runtimeGeneration } : {}),
        })
      : env.OBJECT_STORAGE_PROVIDER === 'filesystem'
        ? createFilesystemObjectStore(env.OBJECT_STORAGE_ROOT || join(dataRoot, 'objects'))
        : undefined);
  if (runtimeMode === 'tenant' && !objectStore)
    throw new Error('Private durable storage is required.');
  return {
    initialize: async () => {
      await allocations?.initialize();
      await databaseObjects?.initialize();
    },
    ...(e2b
      ? {
          prepareComputer: e2b.prepare,
          computerLifecycle: { pause: e2b.pause, resume: e2b.resume },
        }
      : {}),
    ...(e2b && runtimeMode === 'tenant' && env.OTTO_COMPUTER_CONTROL_URL
      ? {
          confirmComputerShutdown: createComputerShutdownConfirmation({
            endpoint: env.OTTO_COMPUTER_CONTROL_URL,
            generation: runtimeGeneration,
          }),
        }
      : {}),
    objectStore,
    ...(runtimeMode === 'tenant'
      ? {
          channelAccounts: createTenantChannelRegistry({
            origin: env.OTTO_CONTROL_URL!,
            ownerId,
            environment: env.OTTO_ENVIRONMENT!,
            generation: env.OTTO_RUNTIME_GENERATION!,
            secret: env.OTTO_RUNTIME_SECRET!,
          }),
        }
      : {}),
    createConversationRouter: (onUsage) =>
      createPiConversationRouter({ provider, model: env.ROUTING_MODEL, apiKey, onUsage }),
    agent: createPiAgent({
      provider,
      model,
      apiKey,
      sessionRoot: join(dataRoot, 'sessions'),
      objectStore,
    }),
    computer:
      remote?.computer ??
      createContainerBrowserComputer({ dataRoot, container: env.BROWSER_CONTAINER }),
    workspace:
      remote?.workspace ??
      createDockerWorkspace({
        container: env.WORKSPACE_CONTAINER || 'otto-workspace',
        workspaceRoot: join(dataRoot, 'workspaces'),
      }),
    speech: createOpenAISpeechProvider({
      apiKey: env.OPENAI_API_KEY,
      transcriptionModel: env.STT_MODEL,
      speechModel: env.TTS_MODEL,
      voice: env.TTS_VOICE,
    }),
    integrations: createComposioProvider({
      apiKey: env.COMPOSIO_API_KEY,
      webhookSecret: env.COMPOSIO_WEBHOOK_SECRET,
      authConfigs,
    }),
    ...(['local', 'tenant'].includes(runtimeMode)
      ? {
          directIntegrations: (
            pool: pg.Pool,
            keyStore: CredentialKeyStore,
            grantVault: Awaited<ReturnType<typeof createAppGrantVault>>,
            ownerId: string,
          ) => createDirectProvider({ pool, keyStore, grantVault, ownerId }),
        }
      : {}),
    keyStore: env.OTTO_VAULT_KEY
      ? createEnvironmentKeyStore(env.OTTO_VAULT_KEY)
      : process.platform === 'darwin'
        ? createKeychainKeyStore()
        : createEnvironmentKeyStore(),
    relevance: env.TYPESAFE_API_KEY
      ? createJevRelevanceClassifier({ apiKey: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL })
      : createOpenAIRelevanceClassifier({ apiKey: env.OPENAI_API_KEY, model: env.TRIAGE_MODEL }),
    chooseBrowserAction: env.TYPESAFE_API_KEY
      ? createJevBrowserChooser({ apiKey: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL })
      : undefined,
    messagingSetup: {
      verifier: createChatSdkSetupVerifier(
        runtimeMode === 'tenant'
          ? {
              webhookUrl: (provider) => env[`OTTO_${provider.toUpperCase()}_WEBHOOK_URL`]!,
            }
          : undefined,
      ),
      create: (environment) => createChatSdkTransport(pool, { ...env, ...environment }),
    },
    linkPreviews: createPublicLinkPreviewProvider(),
    model: { provider, name: model, configured: Boolean(apiKey) },
  };
}

export async function createApplication(
  adapters: ApplicationAdapters,
  options: { workers?: boolean; channels?: boolean } = {},
) {
  const admission = createWorkAdmission();
  const consumers = createWorkConsumers();
  const deploymentDrain = createTenantDrain({
    admission,
    consumers,
    computer: adapters.computerLifecycle,
  });
  const privacyNotice =
    runtimeMode === 'local'
      ? await loadPrivacyNoticeFile(process.env.OTTO_PRIVACY_NOTICE_FILE)
      : undefined;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await initializeDatabase();
  await adapters.initialize?.();
  await initializeTasks();
  const artifacts = adapters.objectStore
    ? createArtifactService({ database: pool, ownerId, store: adapters.objectStore })
    : localArtifacts;
  const inspectorDatabase = createInspectorPool();
  const inspectorSecrets = Object.entries(process.env)
    .filter(([key]) => /(?:API_KEY|SECRET|PASSWORD|VAULT_KEY|BOT_TOKEN|ACCESS_TOKEN)$/.test(key))
    .flatMap(([, value]) => (value ? [value] : []));
  if (process.env.DATABASE_URL) {
    inspectorSecrets.push(process.env.DATABASE_URL);
    try {
      const password = decodeURIComponent(new URL(process.env.DATABASE_URL).password);
      if (password) inspectorSecrets.push(password);
    } catch {}
  }
  const inspector = createInspectorStore(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    secrets: inspectorSecrets,
  });
  const promptInspector = createPromptInspector(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    secrets: inspectorSecrets,
    provider: adapters.model.provider,
    model: adapters.model.name,
  });
  await promptInspector.initialize(pool);
  const providerUsage = createProviderUsageStore(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    coverage: [
      {
        provider: adapters.model.provider,
        category: 'agent',
        status: 'recorded',
        note: 'Responses, compaction and cache warming when reported by Pi. Costs are SDK estimates; unreported failed attempts may be missing.',
      },
      {
        provider: adapters.relevance.id,
        category: 'relevance',
        status: 'recorded',
        note: 'Classification operations and duration. Tokens and prices are not exposed by this adapter.',
      },
      {
        provider: 'agent-browser',
        category: 'browser',
        status: 'recorded',
        note: 'Local browser operations, screen captures and secure/manual steps. Hosting and visited-site charges are not measured.',
      },
      {
        provider: 'pi-web-access',
        category: 'browser',
        status: 'recorded',
        note: 'Public search operations and duration. Provider prices and network charges are unavailable.',
      },
      ...(adapters.linkPreviews
        ? [
            {
              provider: 'public-web',
              category: 'browser' as const,
              status: 'recorded' as const,
              note: 'Public link preview metadata and image operations. Cache hits are included; network and hosting charges are not measured.',
            },
          ]
        : []),
      ...(adapters.chooseBrowserAction
        ? [
            {
              provider: 'jev',
              category: 'browser' as const,
              status: 'recorded' as const,
              note: 'Fast-choice operations and duration. Provider price is unavailable.',
            },
          ]
        : []),
      {
        provider: adapters.integrations.id,
        category: 'integration',
        status: 'recorded',
        note: 'Composio session, account, search, execution and subscription operations; internal SDK requests and Google quotas are not measured.',
      },
      ...(adapters.directIntegrations
        ? [
            {
              provider: 'direct',
              category: 'integration' as const,
              status: 'recorded' as const,
              note: 'Direct OAuth, MCP search and read operations. Provider fees are not measured.',
            },
          ]
        : []),
      {
        provider: adapters.speech.id,
        category: 'speech',
        status: 'recorded',
        note: 'Transcription bytes and synthesis characters/bytes. Audio duration, tokens and prices are unavailable.',
      },
      {
        provider: 'telegram',
        category: 'channel',
        status: 'recorded',
        note: 'Setup, polling, received messages and sends when configured. Provider fees are unavailable.',
      },
      {
        provider: 'whatsapp',
        category: 'channel',
        status: 'recorded',
        note: 'Setup, webhook messages and sends when configured. Provider fees are unavailable.',
      },
      {
        provider: 'local-workspace',
        category: 'workspace',
        status: 'recorded',
        note: 'Command and file operations; cloud/hosting resource charges are not measured.',
      },
      {
        provider: 'hosting',
        category: 'workspace',
        status: 'unsupported',
        note: 'Database, storage, network and machine billing require a hosting billing integration.',
      },
    ],
  });
  await providerUsage.initialize(pool);
  const computer = meterComputer(adapters.computer, providerUsage);
  const workspace = meterWorkspace(adapters.workspace, providerUsage);
  const speechProvider = meterSpeech(adapters.speech, providerUsage);
  const integrationProvider = meterIntegrations(adapters.integrations, providerUsage);
  const classify = meterRelevance(adapters.relevance, providerUsage);
  const webSearch = createWebSearch();
  const runtime = createAgentRuntime({
    agent: meterAgent(adapters.agent, providerUsage),
    withTool: providerUsage.withTool,
    computer,
    workspace,
    webSearch: (query, signal) =>
      providerUsage.track(
        { provider: 'pi-web-access', category: 'browser', operation: 'search' },
        () => webSearch(query, signal),
      ),
    chooseBrowserAction: adapters.chooseBrowserAction
      ? (...args) =>
          providerUsage.track(
            { provider: 'jev', category: 'browser', operation: 'choose_action' },
            () => adapters.chooseBrowserAction!(...args),
          )
      : undefined,
  });
  const speech = createSpeech(speechProvider);
  const personal = createPersonalService({
    pool,
    ownerId,
    scheduler: boss,
    submitTask,
    refresh,
    consumers,
    stopConsumer: (id) => boss.offWork('scheduled-task', { id, wait: true }),
  });
  await personal.initialize({ workers: options.workers });
  const triage = createTriage({
    consumers,
    classifier: classify,
    getProfile: personal.getProfile,
    listGoals: personal.listGoals,
  });
  const grantVault = await createAppGrantVault(pool, {
    ownerId,
    keyStore: adapters.keyStore,
  });
  const discovered = await createDiscoveredConnections(pool, {
    ownerId,
    baseUrl: publicOrigin,
    keyStore: adapters.keyStore,
    grantVault,
    transport: createDiscoveredTransport(),
    oauth: createDiscoveredOAuth(),
    resumeConnection: resumeConnectedTask,
    refresh,
  });
  let vault!: Awaited<ReturnType<typeof createVault>>;
  const integrations = await createIntegrations(pool, {
    admission,
    ownerId,
    provider: integrationProvider,
    resumeConnection: resumeConnectedTask,
    ...(adapters.directIntegrations
      ? {
          additionalProviders: [
            meterIntegrations(
              adapters.directIntegrations(pool, adapters.keyStore, grantVault, ownerId),
              providerUsage,
            ),
          ],
        }
      : {}),
    wake: triage.triageEvent,
    refresh,
    baseUrl: publicOrigin,
    discovered,
    browserAccounts: () => vault.list(ownerId),
    removeBrowserAccount: (id) => vault.removeLogin(id),
  });
  vault = await createVault(pool, {
    admission,
    keyStore: adapters.keyStore,
    resume: resumeTask,
    retry: retryTaskCredentials,
    inject: computer.injectCredentials,
    inspect: computer.inspectLogin,
    hold: computer.hold,
    selectMethod: computer.selectLoginMethod,
    emailCode: (input, signal) => integrations.emailCode(ownerId, input, signal),
  });
  const chatVerification = await createChatVerification(pool, {
    ownerId,
    keyStore: adapters.keyStore,
    submitCode: vault.submitChatCode,
    refresh,
  });
  const approvals = await createApprovals(
    (action, args, provenance) =>
      action.startsWith('OTTO_')
        ? personal.manage(action.slice('OTTO_'.length), args, provenance)
        : providerUsage.withTask(provenance.taskId, () =>
            integrations.executeApproved(ownerId, action, args),
          ),
    async (action, args) => {
      if (action.startsWith('OTTO_'))
        await personal.validateReview(action.slice('OTTO_'.length), args);
      else await integrations.validateApproval(ownerId, action, args);
    },
    (action, args) => integrations.describeApproval(ownerId, action, args),
    (action, args) => integrations.describeTarget(ownerId, action, args),
  );
  const reactions = createAgentReactionService({ pool, ownerId, refresh });
  const userMessages = createUserMessageService({
    routeConversation: adapters.createConversationRouter?.(providerUsage.record),
    confirmAction: approvals.acceptChat,
  });
  if (options.workers !== false) {
    await inspector.recover().catch(() => {});
    await triage.initializeHeartbeat();
    await startTaskWorkers({
      consumers,
      artifacts,
      writeArtifact: workspace.writeArtifact?.bind(workspace),
      readArtifact: workspace.readArtifact?.bind(workspace),
      executeConfirmation: approvals.executeConfirmed,
      reactToMessage: reactions.react,
      downloadIntegrationFile: (_taskId, action, args, signal) =>
        integrations.download(ownerId, action, args, signal),
      runTask: (context) => providerUsage.withTask(context.taskId, () => runtime.runTask(context)),
      observe: inspector.record,
      recordFailure: inspector.recordFailure,
      inspectPrompt: promptInspector.record,
      finishObservationSegment: inspector.finishSegment,
      connections: integrations.manageConnections,
      speech,
      manage: async (taskId, action, args, provenance) => {
        if (
          [
            'profile_update',
            'notification_preferences_update',
            'goal_create',
            'goal_update',
            'schedule_create',
            'schedule_update',
            'schedule_cancel',
            'memory_propose',
          ].includes(action)
        )
          return approvals.request(
            taskId,
            `OTTO_${action}`,
            await personal.validateReview(action, args),
            { revision: provenance?.revision },
          );
        return personal.manage(action, args, provenance);
      },
      requestCredential: async (taskId, input) => {
        if (input.kind === 'otp' && (await vault.fillEmailCode(taskId, ownerId, input)))
          return { filled: true };
        if (input.kind !== 'otp') {
          const selected = await vault.fillSelected(taskId, ownerId, input);
          if (selected) return { filled: true };
          if (selected === undefined) {
            const matches = (await vault.list(ownerId)).filter(
              (entry) => entry.origin === input.origin,
            );
            if (matches.length === 1) {
              try {
                await vault.fillSaved(taskId, ownerId, matches[0].id, input);
                return { filled: true };
              } catch {}
            }
          }
        }
        return vault.request(taskId, ownerId, input);
      },
      integration: async (taskId, action, args, options) => {
        const result = await integrations.execute(ownerId, action, args);
        if (
          result &&
          typeof result === 'object' &&
          'requiresApproval' in result &&
          result.requiresApproval
        ) {
          if (options?.readOnly)
            throw new Error(
              'Getting started can inspect connected apps but cannot change their data.',
            );
          return approvals.request(
            taskId,
            action,
            'args' in result && result.args && typeof result.args === 'object'
              ? (result.args as Record<string, unknown>)
              : args,
            { revision: options?.revision },
          );
        }
        return result;
      },
    });
  }
  const app = await createApp({
    admission,
    deploymentDrain,
    artifacts,
    submitMessage: userMessages.submit,
    verification: chatVerification,
    onboard: async (timeZone, conversationRevision) => {
      if (timeZone) await triage.updatePreferences({ timeZone });
      return restartOnboarding(conversationRevision);
    },
    speech,
    computer,
    runtime,
    inspector,
    configuration: () =>
      configuration({
        provider: adapters.model.provider,
        model: adapters.model.name,
        llmReady: adapters.model.configured,
        speechReady: adapters.speech.configured,
        integrationsReady: adapters.integrations.configured,
        browserAssistReady: Boolean(adapters.chooseBrowserAction),
      }),
  });
  if (runtimeMode === 'local') {
    registerPrivacyNotice(app, privacyNotice);
    const accounts = createAccountStore(pool);
    await accounts.initialize();
    createAccountSession({
      accounts,
      origin: publicOrigin,
      localUser: { id: ownerId, name: 'You', email: null, avatarUrl: null },
      developerIds: configuration().inspectorEnabled ? new Set([ownerId]) : new Set(),
      prepare: async () => adapters.prepareComputer?.(),
    }).register(app);
  } else {
    app.post('/api/account/prepare', async (request) => {
      z.object({})
        .strict()
        .parse(request.body ?? {});
      await adapters.prepareComputer?.();
      return { ok: true };
    });
  }
  providerUsage.registerRoutes(app);
  promptInspector.registerRoutes(app);
  createInspectorWork(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    secrets: inspectorSecrets,
    async reviewStatus() {
      const registered =
        options.workers === false ? undefined : (await boss.getSchedules('heartbeat'))[0];
      return {
        configured: adapters.relevance.configured,
        scheduled: Boolean(registered),
        cron: registered?.cron ?? null,
        timeZone: registered?.timezone ?? null,
      };
    },
  }).registerRoutes(app);
  if (adapters.linkPreviews) {
    const previews = adapters.linkPreviews;
    createLinkPreviews({
      metadata: (url) =>
        providerUsage.track(
          { provider: 'public-web', category: 'browser', operation: 'link_metadata' },
          () => previews.metadata(url),
        ),
      image: (url) =>
        providerUsage.track(
          { provider: 'public-web', category: 'browser', operation: 'link_image' },
          () => previews.image(url),
          (image) => ({ bytes: image?.bytes.byteLength ?? 0 }),
        ),
    }).registerRoutes(app);
  }
  vault.registerRoutes(app);
  integrations.registerRoutes(app);
  personal.registerRoutes(app);
  triage.registerRoutes(app);
  createTakeover({
    pool,
    ownerId,
    computer,
    enabled: () => configuration().inspectorEnabled,
    pause: pauseOwnedTaskForControl,
    resume: resumeOwnedTaskFromControl,
    waitForTask: runtime.waitForTask,
  }).registerRoutes(app);
  let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
  let channelSettings: Awaited<ReturnType<typeof createChannelSettings>> | undefined;
  if (options.channels !== false && (adapters.messaging || adapters.messagingSetup)) {
    const setup = adapters.messagingSetup;
    if (setup) {
      channelSettings = await createChannelSettings(pool, {
        ownerId,
        accounts: adapters.channelAccounts,
        keyStore: adapters.keyStore,
        verifier: {
          verify: (provider, input) =>
            providerUsage.track({ provider, category: 'channel', operation: 'setup' }, () =>
              setup.verifier.verify(provider, input),
            ),
          ...(setup.verifier.register
            ? {
                register: (provider, configuration) =>
                  providerUsage.track(
                    { provider, category: 'channel', operation: 'register' },
                    () => setup.verifier.register!(provider, configuration),
                  ),
              }
            : {}),
        },
        apply: async (environment) => {
          if (!channels) throw new Error('Messaging is not ready.');
          await channels.replaceTransport(meterMessaging(setup.create(environment), providerUsage));
        },
      });
      channelSettings.registerRoutes(app);
    }
    const messaging = setup
      ? setup.create(await channelSettings!.environment())
      : adapters.messaging!;
    channels = await createChannels(pool, {
      admission,
      ownerId,
      resolveAttachments: artifacts.readTaskArtifacts,
      transport: meterMessaging(messaging, providerUsage),
      acceptVerification: (text, input) => chatVerification.accept(text, input),
      subscribe(listener) {
        const onEvent = (event: { type?: string }) => {
          if (event.type === 'refresh') listener();
        };
        events.on('event', onEvent);
        return () => {
          events.off('event', onEvent);
        };
      },
      prepare: (text, sourceId, channel) => userMessages.prepare(text, [], { sourceId, channel }),
      submit: async (text, sourceId, client, channel, preparedRoute, messageId) =>
        (
          await userMessages.submit(text, [], {
            sourceId,
            channel,
            client,
            preparedRoute,
            clientMessageId: messageId,
          })
        ).taskId,
    });
    channels.registerRoutes(app);
    await channelSettings?.recover();
  }
  let closingConsumers: Promise<void> | undefined;
  app.addHook('preClose', async () => {
    admission.close();
    closingConsumers = consumers.close();
    void closingConsumers.catch(() => {});
  });
  async function finishWork() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([closingConsumers, admission.drain(Date.now() + 30_000)]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Application work did not finish.')), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  app.addHook('onClose', async () => {
    const failures: unknown[] = [];
    for (const close of [
      () => channels?.close(),
      () => stopTasks(),
      finishWork,
      async () => {
        await runtime.dispose();
        await adapters.confirmComputerShutdown?.();
      },
      () => inspector.close(),
      () => promptInspector.close(),
      () => providerUsage.close(),
      () => inspectorDatabase.end(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new Error('Some application resources could not close.');
  });
  return {
    app,
    runtime,
    personal,
    triage,
    integrations,
    vault,
    channels,
    channelSettings,
    deploymentDrain,
  };
}

export async function createGatewayApplication(
  env: Record<string, string | undefined> = process.env,
) {
  const privacyNotice = await loadPrivacyNoticeFile(env.OTTO_PRIVACY_NOTICE_FILE);
  const databaseUrl = z.string().min(1).parse(env.DATABASE_URL);
  const environment = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .parse(env.OTTO_ENVIRONMENT || 'development');
  const origin = z.url().parse(env.OTTO_PUBLIC_URL);
  const masterKey = parseCredentialKey(env.OTTO_MASTER_KEY || '');
  const tenants = createTenantStore({
    admin: pool,
    databaseUrl,
    environment,
    getSecret: () => masterKey,
    maxTenants: env.OTTO_MAX_USERS ? Number(env.OTTO_MAX_USERS) : 8,
  });
  await tenants.initialize();
  await pool.query(
    'CREATE SCHEMA IF NOT EXISTS otto_auth; REVOKE ALL ON SCHEMA otto_auth FROM PUBLIC',
  );
  const authenticationDatabase = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 10_000,
    options: '-c search_path=otto_auth',
  });
  let runtimes: ReturnType<typeof createTenantRuntimeHost> | undefined;
  try {
    const authentication = createGoogleAuthentication({
      database: authenticationDatabase,
      origin,
      environment,
      secret: env.BETTER_AUTH_SECRET || '',
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    });
    await authentication.initialize();
    const accounts = createAccountStore(authenticationDatabase);
    await accounts.initialize();
    const channelAccounts = createChannelAccountRegistry({ admin: pool, environment });
    await channelAccounts.initialize();
    const developerIds = new Set(
      (env.OTTO_DEVELOPER_IDS || '')
        .split(',')
        .filter(Boolean)
        .map((id) => z.uuid().parse(id.trim()).toLowerCase()),
    );
    const transport =
      env.OTTO_RUNTIME_URL === 'http://otto.runtime'
        ? createCloudflareRuntimeTransport()
        : createLocalRuntimeTransport({
            root: join(dataRoot, 'tenants'),
            entrypoint: 'src/server/index.ts',
            cwd: process.cwd(),
          });
    runtimes = createTenantRuntimeHost({
      tenants,
      transport,
      masterKey,
      environment,
      developerIds,
      operatorEnvironment: { ...env, OTTO_PUBLIC_URL: origin },
    });
    const app = await createGateway({
      origin,
      authentication,
      accounts,
      runtimes,
      privacyNotice,
      release: env.OTTO_IMAGE_RELEASE || env.OTTO_RELEASE,
      ...(env.OTTO_RUNTIME_URL === 'http://otto.runtime' && {
        deployment: {
          masterKey,
          environment,
          release: env.OTTO_IMAGE_RELEASE || env.OTTO_RELEASE,
        },
      }),
      developerIds,
      internal: createTenantControl({
        masterKey,
        environment,
        accounts: channelAccounts,
        currentLease: tenants.currentLease,
      }),
      webhook: createHostedWebhooks({
        runtimes,
        masterKey,
        environment,
        listOwners: tenants.listOwners,
        hasOwner: async (owner) => Boolean(await tenants.get(owner)),
        integrations: createComposioProvider({
          apiKey: env.COMPOSIO_API_KEY,
          webhookSecret: env.COMPOSIO_WEBHOOK_SECRET,
        }),
      }),
    });
    let restoring = false;
    let closing = false;
    async function restore() {
      if (restoring || closing) return;
      restoring = true;
      try {
        for (const owner of await tenants.listOwners()) {
          if (closing) break;
          try {
            const result = await runtimes!.fetch(
              owner,
              new Request('http://otto.runtime/api/runtime/wake', { method: 'POST' }),
              { developer: false, kind: 'wake' },
            );
            await result.body?.cancel();
          } catch {}
        }
      } finally {
        restoring = false;
      }
    }
    const timer = setInterval(() => {
      void restore().catch(() => {});
    }, 30_000);
    timer.unref();
    app.addHook('onListen', async () => {
      void restore().catch(() => {});
    });
    app.addHook('preClose', async () => {
      closing = true;
      clearInterval(timer);
    });
    app.addHook('onClose', async () => authenticationDatabase.end());
    return { app };
  } catch {
    await runtimes?.close().catch(() => {});
    await authenticationDatabase.end().catch(() => {});
    throw new Error('The hosted application configuration could not be initialized.');
  }
}

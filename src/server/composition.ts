import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { appConfirmation, type Agent } from '../ports/agent.ts';
import type { ProductAnalytics } from '../ports/analytics.ts';
import { createPostHogAnalytics } from '../providers/posthog/analytics.ts';
import { analyticsEnabled, analyticsEnvironment, createAnalytics } from './analytics.ts';
import type { Computer, Workspace } from '../ports/computer.ts';
import type { IntegrationProvider, IntegrationService } from '../ports/integrations.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { MemoryCurator } from '../ports/memory-curator.ts';
import type { RelevanceClassifier } from '../ports/relevance.ts';
import type { SpeechProvider } from '../ports/speech.ts';
import type { MessagingTransport } from '../ports/messaging.ts';
import type { ChannelAccountRegistry, ChannelSetupVerifier } from '../ports/channel-settings.ts';
import type { PrivateObjectStore } from '../ports/object-storage.ts';
import type { LinkPreviewProvider } from '../ports/link-preview.ts';
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
import { createJevRelevanceClassifier } from '../providers/jev/relevance.ts';
import { createKeychainKeyStore } from '../providers/keychain/key-store.ts';
import { createOpenAISpeechProvider } from '../providers/openai/speech.ts';
import { createPiModelBackend } from '../providers/pi/models.ts';
import { createModelService } from './models.ts';
import { createPiAgent } from '../providers/pi/index.ts';
import { createSkillLibrary } from '../providers/pi/skills.ts';
import { readPiSessionEntries } from '../providers/pi/checkpoint.ts';
import { createPiMemoryCurator } from '../providers/pi/memory-curator.ts';
import { createPublicLinkPreviewProvider } from '../providers/public-web/link-preview.ts';
import { createAgentRuntime } from '../runtime/index.ts';
import { coreSkills } from '../runtime/prompt.ts';
import { createApp } from './app.ts';
import { createWorkAdmission, createWorkConsumers } from './work-admission.ts';
import { createTenantDrain } from './tenant-drain.ts';
import { createChatVerification } from './chat-verification.ts';
import { createAgentReactionService } from './agent-reactions.ts';
import { createApprovals } from './approvals.ts';
import { appActionConfirmation } from './action-presentation.ts';
import { createTrust } from './trust.ts';
import { createArtifactService, localArtifacts } from './artifacts.ts';
import { createChannels } from './channels.ts';
import { createChannelSettings } from './channel-settings.ts';
import {
  configuration,
  dataRoot,
  desktopMode,
  ownerId,
  publicOrigin,
  runtimeGeneration,
  runtimeMode,
} from './config.ts';
import { createAccountStore } from './account-store.ts';
import { createAccountProfileStore, runtimeAccount } from './account-profile.ts';
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
import { createInspectorPool, createPool, initializeDatabase, pool } from './db.ts';
import { events, refresh } from './events.ts';
import { createIntegrations } from './integrations.ts';
import { createInspectorStore } from './inspector.ts';
import { createPromptInspector } from './inspector-prompts.ts';
import { createErrorRedactor } from './inspector-redaction.ts';
import { registerBugReport } from './bug-report.ts';
import { createPersonalService } from './personal.ts';
import { createMemoryLearning, initializeMemoryLearning } from './memory-learning.ts';
import { createMemoryService } from './memory.ts';
import { createSpeech } from './speech.ts';
import {
  boss,
  createUserMessageService,
  enqueueTurn,
  initializeThreads,
  restartOnboarding,
  resumeAfterConnection,
  resumeAfterCredentials,
  retryCredentials,
  startOnboarding,
  startThreadWorkers,
  stopThreadWorkers,
  withTurnLock,
} from './thread.ts';
import { createTriage } from './triage.ts';
import { createTasks } from './tasks.ts';
import { createVault, credentialOrigin } from './vault.ts';
import { createBrowserConnections } from './browser-connections.ts';
import { createProviderUsageStore } from './provider-usage.ts';
import { createLinkPreviews } from './link-previews.ts';
import {
  meterAgent,
  meterComputer,
  meterWorkspace,
  meterIntegrations,
  meterMemoryCurator,
  meterRelevance,
  meterSpeech,
  meterMessaging,
} from './provider-metering.ts';

export interface ApplicationAdapters {
  analytics?: ProductAnalytics;
  initialize?(): Promise<void>;
  models?: ReturnType<typeof createModelService>;
  prepareComputer?(): Promise<void>;
  computerLifecycle?: { pause(): Promise<void>; resume(): Promise<void> };
  confirmComputerShutdown?(): Promise<void>;
  objectStore?: PrivateObjectStore;
  channelAccounts?: ChannelAccountRegistry;
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
  memoryCurator?: MemoryCurator;
  messaging?: MessagingTransport;
  linkPreviews?: LinkPreviewProvider;
  messagingSetup?: {
    verifier: ChannelSetupVerifier;
    create(environment: Record<string, string>): MessagingTransport;
  };
  model: { provider: string; name: string; configured: boolean };
}

export function createDefaultAdapters(
  env: Record<string, string | undefined> = process.env,
): ApplicationAdapters {
  const provider = env.LLM_PROVIDER || 'openai';
  if (!['openai', 'anthropic', 'openrouter'].includes(provider))
    throw new Error('LLM_PROVIDER must be openai, anthropic or openrouter.');
  const model = env.LLM_MODEL || agentModels[provider as keyof typeof agentModels];
  const keyStore = env.OTTO_VAULT_KEY
    ? createEnvironmentKeyStore(env.OTTO_VAULT_KEY)
    : process.platform === 'darwin'
      ? createKeychainKeyStore()
      : createEnvironmentKeyStore();
  const models = createModelService({
    database: pool,
    ownerId,
    keyStore,
    backend: createPiModelBackend(),
    origin: publicOrigin,
    local: runtimeMode === 'local',
    bootstrap: {
      provider: provider as keyof typeof agentModels,
      model,
      keys: {
        openai: env.OPENAI_API_KEY,
        anthropic: env.ANTHROPIC_API_KEY,
        openrouter: env.OPENROUTER_API_KEY,
      },
    },
    changed: refresh,
  });
  const modelCurator = createPiMemoryCurator({
    get provider() {
      return models.current.provider;
    },
    resolve: () => models.resolve(true),
    configured: () => models.configured,
  });
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
    ...(analyticsEnabled(env) ? { analytics: createPostHogAnalytics() } : {}),
    initialize: async () => {
      await models.initialize();
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
    models,
    agent: createPiAgent({
      resolve: () => models.resolve(),
      provider,
      model,
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
      speechModel: env.TTS_MODEL,
      voice: env.TTS_VOICE,
    }),
    integrations: createComposioProvider({
      apiKey: env.COMPOSIO_API_KEY,
      webhookSecret: env.COMPOSIO_WEBHOOK_SECRET,
      webhookUrl: env.OTTO_COMPOSIO_WEBHOOK_URL,
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
    keyStore,
    relevance: env.TYPESAFE_API_KEY
      ? createJevRelevanceClassifier({ apiKey: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL })
      : {
          get id() {
            return modelCurator.id;
          },
          get configured() {
            return models.configured;
          },
          async classify(context, policy, signal) {
            const answer = (await modelCurator.curate(
              {
                task: 'search',
                instructions: `Return JSON {"decision":"ignore"|"digest"|"wake","confidence":0.0}. ${policy.instructions} Decision criteria: ${JSON.stringify(policy.criteria)}`,
                input: context,
              },
              signal,
            )) as { decision?: string; confidence?: number } | null;
            const parsed = z
              .object({
                decision: z.enum(['ignore', 'digest', 'wake']),
                confidence: z.number().min(0).max(1),
              })
              .parse(answer);
            return parsed.decision === 'wake' && parsed.confidence < policy.minWakeConfidence
              ? 'digest'
              : parsed.decision;
          },
        },
    memoryCurator: modelCurator,
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
    get model() {
      return models.current;
    },
  };
}

export async function createApplication(
  adapters: ApplicationAdapters,
  options: { workers?: boolean; channels?: boolean } = {},
) {
  try {
    return await initializeApplication(adapters, options);
  } catch (error) {
    try {
      await adapters.analytics?.shutdown();
    } catch {}
    throw error;
  }
}

async function initializeApplication(
  adapters: ApplicationAdapters,
  options: { workers?: boolean; channels?: boolean },
) {
  const analytics = await createAnalytics({
    provider: adapters.analytics,
    deployment: runtimeMode === 'local' ? 'local' : 'hosted',
    environment: analyticsEnvironment(process.env),
    dataRoot,
    installationId: process.env.OTTO_ANALYTICS_ID,
  });
  const captureAnalytics = analytics.forOwner(ownerId);
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
  await initializeThreads();
  const artifacts = adapters.objectStore
    ? createArtifactService({ database: pool, ownerId, store: adapters.objectStore })
    : localArtifacts;
  const inspectorDatabase = createInspectorPool();
  const inspectorSecrets = Object.entries(process.env)
    .filter(([key]) =>
      /(?:API_KEY|SECRET|PASSWORD|VAULT_KEY|BOT_TOKEN|ACCESS_TOKEN|DESKTOP_AUTH_TOKEN)$/.test(key),
    )
    .flatMap(([, value]) => (value ? [value] : []));
  if (process.env.DATABASE_URL) {
    inspectorSecrets.push(process.env.DATABASE_URL);
    try {
      const password = decodeURIComponent(new URL(process.env.DATABASE_URL).password);
      if (password) inspectorSecrets.push(password);
    } catch {}
  }
  adapters.models?.onSecrets((values) => inspectorSecrets.push(...values));
  const memoryCurator =
    adapters.memoryCurator ?? createPiMemoryCurator({ provider: adapters.model.provider });
  const inspector = createInspectorStore(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    secrets: inspectorSecrets,
  });
  const promptInspector = createPromptInspector(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    secrets: inspectorSecrets,
    get provider() {
      return adapters.model.provider;
    },
    get model() {
      return adapters.model.name;
    },
  });
  await promptInspector.initialize(pool);
  const providerUsage = createProviderUsageStore(inspectorDatabase, {
    ownerId,
    enabled: () => configuration().inspectorEnabled,
    coverage: [
      {
        get provider() {
          return adapters.model.provider;
        },
        category: 'agent',
        status: 'recorded',
        note: 'Responses, compaction and cache warming when reported by Pi. Costs are SDK estimates; unreported failed attempts may be missing.',
      },
      {
        get provider() {
          return adapters.relevance.id;
        },
        category: 'relevance',
        status: 'recorded',
        note: 'Classification operations and duration. Tokens and prices are not exposed by this adapter.',
      },
      {
        get provider() {
          return memoryCurator.id;
        },
        category: 'memory',
        status: 'recorded',
        note: 'Background memory reflection, consolidation and search calls and duration. Tokens and prices are not exposed by this adapter.',
      },
      {
        provider: 'agent-browser',
        category: 'browser',
        status: 'recorded',
        note: 'Local browser operations, screen captures and secure entry. Hosting and visited-site charges are not measured.',
      },
      {
        provider: 'pi-web-access',
        category: 'browser',
        status: 'recorded',
        note: 'Public search and fetch operations and duration. Provider prices and network charges are unavailable.',
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
  const curator = meterMemoryCurator(memoryCurator, providerUsage);
  const runtime = createAgentRuntime({
    agent: meterAgent(adapters.agent, providerUsage),
    skills: createSkillLibrary(
      fileURLToPath(new URL('../runtime/skills/', import.meta.url)),
      coreSkills,
    ),
    withTool: providerUsage.withTool,
    computer,
    workspace,
    redactError: createErrorRedactor(inspectorSecrets),
  });
  const speech = createSpeech(speechProvider);
  const memoryNoticeHash = createHash('sha256').update(`memory-notice:${ownerId}`).digest('hex');
  const memoryNoticeId = `${memoryNoticeHash.slice(0, 8)}-${memoryNoticeHash.slice(8, 12)}-8${memoryNoticeHash.slice(13, 16)}-8${memoryNoticeHash.slice(17, 20)}-${memoryNoticeHash.slice(20, 32)}`;
  const memory = createMemoryService({
    pool,
    ownerId,
    store: adapters.objectStore ?? createFilesystemObjectStore(join(dataRoot, 'objects')),
    curator,
    onSaved: async (sourceMessageId) => {
      const result = await pool.query(
        `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id)
         SELECT $1,$2,'assistant',$3,m.thread_id,m.turn_id FROM messages m
         JOIN threads t ON t.id=m.thread_id AND t.owner_id=m.owner_id AND t.archived_at IS NULL
         WHERE m.id=$4 AND m.owner_id=$2 AND m.role='user'
         ON CONFLICT(id) DO NOTHING RETURNING id`,
        [
          memoryNoticeId,
          ownerId,
          'I’ve saved this and will remember useful details you share. You can ask me to stop saving or forget your saved details anytime.',
          sourceMessageId,
        ],
      );
      if (result.rowCount) refresh();
    },
  });
  const learning = createMemoryLearning({ pool, ownerId, memory, curator });
  const personal = createPersonalService({
    analytics: captureAnalytics,
    pool,
    ownerId,
    scheduler: boss,
    enqueueTurn,
    refresh,
    memory,
    consumers,
    stopConsumer: (id) => boss.offWork('scheduled-task', { id, wait: true }),
  });
  await memory.initialize();
  await personal.initialize({ workers: options.workers });
  const tasks = createTasks({ pool, ownerId });
  await tasks.initialize();
  const triage = createTriage({
    consumers,
    classifier: classify,
    getProfile: personal.getProfile,
    connectedApps: () => integrations.connectedApps(),
  });
  const grantVault = await createAppGrantVault(pool, {
    ownerId,
    keyStore: adapters.keyStore,
  });
  const discovered = await createDiscoveredConnections(pool, {
    ownerId,
    baseUrl: publicOrigin,
    grantVault,
    transport: createDiscoveredTransport(),
    accountReplaced: triage.invalidateActivityCheck,
    oauth: createDiscoveredOAuth(),
    runCli: workspace.connectedCliAvailable
      ? async (threadId, command, args, envName, token, timeoutSeconds, signal) => {
          const workspacePath = join(dataRoot, 'workspaces', threadId);
          const session = workspace.open({
            threadId,
            workspacePath,
            signal: signal
              ? AbortSignal.any([
                  signal,
                  AbortSignal.timeout((timeoutSeconds ?? 30) * 1000 + 20_000),
                ])
              : AbortSignal.timeout((timeoutSeconds ?? 30) * 1000 + 20_000),
          });
          if (!session.executeProgram) throw new Error('Connected CLI commands are unavailable.');
          return session.executeProgram(command, args, { [envName]: token }, timeoutSeconds);
        }
      : undefined,
    resumeConnection: resumeAfterConnection,
    refresh,
  });
  let vault!: Awaited<ReturnType<typeof createVault>>;
  let browserConnections!: Awaited<ReturnType<typeof createBrowserConnections>>;
  const icon = adapters.linkPreviews?.icon
    ? (origin: string) =>
        providerUsage.track(
          { provider: 'public-web', category: 'browser', operation: 'site_icon' },
          () => adapters.linkPreviews!.icon!(origin),
          (value) => ({ bytes: value?.bytes.byteLength ?? 0 }),
        )
    : undefined;
  const integrations = await createIntegrations(pool, {
    admission,
    ownerId,
    provider: integrationProvider,
    validateActivityCheck: triage.validateActivityCheck,
    resumeConnection: resumeAfterConnection,
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
    callbackReturnTo: desktopMode ? 'window' : undefined,
    discovered,
    browserAccounts: () => vault.list(ownerId),
    removeBrowserAccount: (id) => vault.removeLogin(id),
    browserConnections: () => browserConnections.list(),
    removeBrowserConnection: (id) => browserConnections.disconnect(id),
    icon,
  });
  vault = await createVault(pool, {
    admission,
    keyStore: adapters.keyStore,
    resume: resumeAfterCredentials,
    retry: retryCredentials,
    inject: computer.injectCredentials,
    page: computer.currentPage,
    hold: computer.hold,
    emailCode: (input, signal) => integrations.emailCode(ownerId, input, signal),
    icon,
  });
  browserConnections = await createBrowserConnections(pool, {
    ownerId,
    computer,
    refresh,
  });
  const chatVerification = await createChatVerification(pool, {
    ownerId,
    keyStore: adapters.keyStore,
    submitCode: vault.submitChatCode,
    refresh,
  });
  const approvals = await createApprovals(
    (action, args, provenance) =>
      action === 'OTTO_memory_save'
        ? memory.save(args, { sourceMessageId: provenance.sourceMessageId, approved: true })
        : action.startsWith('OTTO_')
          ? personal.manage(action.slice('OTTO_'.length), args, provenance)
          : providerUsage.withTurn(provenance.turnId, () =>
              integrations.executeApproved(ownerId, action, args, {
                threadId: provenance.threadId,
                turnId: provenance.turnId,
              }),
            ),
    async (action, args) => {
      if (action.startsWith('OTTO_'))
        await personal.validateReview(action.slice('OTTO_'.length), args);
      else await integrations.prepare(ownerId, action, args);
    },
  );
  const reactions = createAgentReactionService({ pool, ownerId, refresh });
  const localAccounts = runtimeMode === 'local' ? createAccountStore(pool) : null;
  const accountProfiles = createAccountProfileStore(pool, ownerId);
  await (localAccounts ?? accountProfiles).initialize();
  const accountProfile = async () =>
    runtimeAccount(
      localAccounts
        ? {
            name: null,
            givenName: null,
            email: null,
            preferredName: (await localAccounts.read(ownerId)).displayName,
          }
        : await accountProfiles.read(),
    );
  const trust = createTrust({
    pool,
    ownerId,
    ownAddresses: async () => [
      (await accountProfile())?.email,
      ...(await integrations.connectedApps()).map((app) => app.accountEmail),
    ],
    review: async (instructions, input) =>
      curator.configured ? curator.curate({ task: 'review', instructions, input }) : undefined,
  });
  await trust.initialize();
  const userMessages = createUserMessageService({ confirmAction: approvals.acceptChat });
  if (options.workers !== false) {
    await inspector.recover().catch(() => {});
    await triage.initializeHeartbeat();
    await initializeMemoryLearning({ boss, consumers, run: learning.run });
    await startThreadWorkers({
      analytics: captureAnalytics,
      consumers,
      artifacts,
      writeArtifact: workspace.writeArtifact?.bind(workspace),
      readArtifact: workspace.readArtifact?.bind(workspace),
      executeConfirmation: approvals.executeConfirmed,
      reactToMessage: reactions.react,
      downloadIntegrationFile: (_turn, action, args, signal) =>
        integrations.download(ownerId, action, args, signal),
      runTurn: (context) => providerUsage.withTurn(context.turnId, () => runtime.runTurn(context)),
      observe: inspector.record,
      recordFailure: inspector.recordFailure,
      inspectPrompt: promptInspector.record,
      finishObservationSegment: inspector.finishSegment,
      accountProfile,
      connectedApps: integrations.connectedApps,
      activityCheck: triage.activityCheck,
      memoryContext: memory.context,
      task: async (turn, input) => {
        const result = await withTurnLock(turn.turnId, (client) => tasks.act(client, turn, input));
        refresh();
        return result;
      },
      markUntrustedContext: (turn) => memory.markUntrusted(turn.threadId),
      flagInjection: trust.flag,
      connections: integrations.manageConnections,
      browserConnection: (request, turn, signal) =>
        browserConnections.request(request, turn, signal),
      speech,
      manage: async (turn, action, args, provenance) => {
        if (
          [
            'profile_update',
            'notification_preferences_update',
            'schedule_create',
            'schedule_update',
            'schedule_cancel',
          ].includes(action)
        )
          return approvals.request(
            turn,
            `OTTO_${action}`,
            await personal.validateReview(action, args),
          );
        if (action === 'memory_save' && (await memory.untrusted(turn.threadId))) {
          const input = memory.validate(args);
          return approvals.request(turn, 'OTTO_memory_save', input, {
            confirm: await memory.cites(provenance.sourceMessageId),
          });
        }
        if (
          [
            'memory_save',
            'memory_forget',
            'memory_learn',
            'memory_control',
            'profile_learn',
          ].includes(action)
        ) {
          return withTurnLock(turn.turnId, () =>
            personal.manage(action, args, { ...provenance, turnId: turn.turnId }),
          );
        }
        return personal.manage(action, args, { ...provenance, turnId: turn.turnId });
      },
      requestCredential: async (turn, input) => {
        if (!('kind' in input)) {
          const { entry, secret } = await vault.readCredential(input.id);
          if (entry.origin !== credentialOrigin(input.origin))
            throw new Error('This saved login does not match the requested website.');
          return { credential: secret };
        }
        const { savedLoginId, ...request } = input;
        if (savedLoginId !== undefined) {
          if (request.kind === 'otp')
            throw new Error('Saved logins cannot supply verification codes.');
          return (await vault.fillSaved(turn, ownerId, savedLoginId, request))
            ? { filled: true }
            : vault.request(turn, ownerId, request);
        }
        if (request.kind === 'otp' && (await vault.fillEmailCode(turn, ownerId, request)))
          return { filled: true };
        if (request.kind !== 'otp') {
          const selected = await vault.fillSelected(turn, ownerId, request);
          if (selected) return { filled: true };
          if (selected === undefined) {
            const matches = (await vault.list(ownerId)).filter(
              (entry) => entry.origin === request.origin,
            );
            if (matches.length === 1) {
              try {
                if (await vault.fillSaved(turn, ownerId, matches[0].id, request))
                  return { filled: true };
              } catch {}
            }
          }
        }
        return vault.request(turn, ownerId, request);
      },
      integration: async (turn, action, args, options) => {
        const verdict = await trust.check(turn, action, args);
        if (verdict.confirm) {
          const prepared = await integrations.prepare(ownerId, action, args);
          const account = (await integrations.list(ownerId, { refresh: false })).find(
            (item) => item.connectionId === prepared.connectionId,
          );
          const path = account?.accessPaths?.find((item) => item.id === prepared.pathId);
          const result = await approvals.request(turn, action, prepared, {
            confirm: true,
            question: appActionConfirmation(
              action,
              prepared,
              verdict.reason,
              account &&
                [
                  account.name,
                  account.accountEmail ?? account.accountName,
                  path && `${path.kind} ${path.endpoint}`,
                ]
                  .filter(Boolean)
                  .join(' · '),
            ),
          });
          return result && typeof result === 'object' && 'requiresConfirmation' in result
            ? { [appConfirmation]: result.question }
            : result;
        }
        return integrations.execute(
          ownerId,
          action,
          args,
          turn,
          options?.signal,
          options?.checkConnectionId,
        );
      },
    });
  }
  const welcome = async (name?: string) => {
    if (!adapters.model.configured) return;
    const connected = (await integrations.list()).filter(
      (connection) => connection.status === 'connected',
    );
    await startOnboarding(name, [...new Set(connected.map((connection) => connection.name))]);
  };
  const app = await createApp({
    analytics: captureAnalytics,
    admission,
    deploymentDrain,
    artifacts,
    submitMessage: userMessages.submit,
    verification: chatVerification,
    onboard: async (timeZone, threadId) => {
      if (timeZone) await triage.updatePreferences({ timeZone });
      return restartOnboarding(threadId);
    },
    startOnboarding: welcome,
    computer,
    runtime,
    inspector,
    configuration: () =>
      configuration({
        provider: adapters.model.provider,
        model: adapters.model.name,
        llmReady: adapters.model.configured,
        integrationsReady: adapters.integrations.configured,
      }),
  });
  adapters.models?.register(app);
  app.addHook('preClose', async () => {
    await adapters.models?.close();
  });
  registerBugReport(app, {
    pool,
    ownerId,
    captureEnabled: () => configuration().inspectorEnabled,
    secrets: inspectorSecrets,
    get provider() {
      return adapters.model.provider;
    },
    get model() {
      return adapters.model.name;
    },
    sessionEntries: (threadId) =>
      readPiSessionEntries({
        threadId,
        sessionRoot: join(dataRoot, 'sessions'),
        objectStore: adapters.objectStore,
      }),
  });
  if (localAccounts) {
    registerPrivacyNotice(app, privacyNotice);
    createAccountSession({
      analytics,
      accounts: localAccounts,
      origin: publicOrigin,
      localUser: { id: ownerId, name: 'You', email: null, avatarUrl: null },
      developerIds: configuration().inspectorEnabled ? new Set([ownerId]) : new Set(),
      prepare: async () => adapters.prepareComputer?.(),
      start: (_owner, name) => welcome(name),
    }).register(app);
  } else {
    app.post('/api/account/prepare', async (request) => {
      z.object({})
        .strict()
        .parse(request.body ?? {});
      await adapters.prepareComputer?.();
      return { ok: true };
    });
    app.put('/api/account/profile', async (request) => {
      await accountProfiles.save(request.body);
      return { ok: true };
    });
  }
  providerUsage.registerRoutes(app);
  promptInspector.registerRoutes(app);
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
  tasks.registerRoutes(app);
  triage.registerRoutes(app);
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
        paired: async (candidate, client) => {
          if (!channels) throw new Error('Messaging is not ready.');
          return channels.announcePairing(candidate, client);
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
      appOrigin: runtimeMode === 'tenant' ? publicOrigin : undefined,
      resolveAttachments: artifacts.readThreadArtifacts,
      ...(channelSettings ? { pair: channelSettings.pair } : {}),
      transport: meterMessaging(messaging, providerUsage),
      acceptVerification: (text, input) => chatVerification.accept(text, input),
      refresh,
      subscribe(listener) {
        const onEvent = (event: { type?: string }) => {
          if (event.type === 'refresh') listener();
        };
        events.on('event', onEvent);
        return () => {
          events.off('event', onEvent);
        };
      },
      submit: async (text, sourceId, client, channel, messageId) =>
        (
          await userMessages.submit(text, [], {
            sourceId,
            channel,
            client,
            clientMessageId: messageId,
          })
        ).turnId,
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
      () => stopThreadWorkers(),
      finishWork,
      async () => {
        await runtime.dispose();
        await adapters.confirmComputerShutdown?.();
      },
      () => inspector.close(),
      () => promptInspector.close(),
      () => providerUsage.close(),
      () => inspectorDatabase.end(),
      () => analytics.shutdown(),
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
  const authenticationDatabase = createPool({
    connectionString: databaseUrl,
    max: 4,
    options: '-c search_path=otto_auth',
  });
  let runtimes: ReturnType<typeof createTenantRuntimeHost> | undefined;
  const analytics = await createAnalytics({
    provider: analyticsEnabled(env) ? createPostHogAnalytics() : undefined,
    deployment: 'hosted',
    environment: analyticsEnvironment(env),
    dataRoot,
  });
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
      analytics,
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
    app.addHook('onClose', async () => analytics.shutdown());
    return { app };
  } catch {
    await analytics.shutdown();
    await runtimes?.close().catch(() => {});
    await authenticationDatabase.end().catch(() => {});
    throw new Error('The hosted application configuration could not be initialized.');
  }
}

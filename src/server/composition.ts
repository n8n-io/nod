import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { appConfirmation, type Agent, type RuntimeObservation } from '../ports/agent.ts';
import { lightestEffort } from '../shared/models.ts';
import type { ProductAnalytics } from '../ports/analytics.ts';
import { createPostHogAnalytics } from '../providers/posthog/analytics.ts';
import { analyticsEnabled, analyticsEnvironment, createAnalytics } from './analytics.ts';
import type { Computer, Workspace } from '../ports/computer.ts';
import type { IntegrationProvider, IntegrationService } from '../ports/integrations.ts';
import { hasWorkspaceFiles, saveIntegrationFiles } from './integration-files.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { MemoryCurator } from '../ports/memory-curator.ts';
import type { SpeechProvider } from '../ports/speech.ts';
import type { MessagingTransport } from '../ports/messaging.ts';
import type { ChannelAccountRegistry, ChannelSetupVerifier } from '../ports/channel-settings.ts';
import type { PrivateObjectStore } from '../ports/object-storage.ts';
import type { LinkPreviewProvider } from '../ports/link-preview.ts';
import type { FeedbackDelivery } from '../ports/feedback.ts';
import { createN8nFeedback } from '../providers/n8n/feedback.ts';
import { agentModels } from '../shared/model-defaults.ts';
import { createChatSdkTransport } from '../providers/chat-sdk/index.ts';
import { createChatSdkSetupVerifier } from '../providers/chat-sdk/settings.ts';
import { createContainerBrowserComputer } from '../providers/container-browser/index.ts';
import { createComposioProvider } from '../providers/composio/integrations.ts';
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
import { createKeychainKeyStore } from '../providers/keychain/key-store.ts';
import { createOpenAISpeechProvider } from '../providers/openai/speech.ts';
import { createPiModelBackend } from '../providers/pi/models.ts';
import { createModelService } from './models.ts';
import { createIntegrationKeyService, registerIntegrationKeyRoutes } from './integration-key.ts';
import { createPiAgent } from '../providers/pi/index.ts';
import { createSkillLibrary } from '../providers/pi/skills.ts';
import { readPiSessionEntries } from '../providers/pi/checkpoint.ts';
import { createPiMemoryCurator } from '../providers/pi/memory-curator.ts';
import { createPublicLinkPreviewProvider } from '../providers/public-web/link-preview.ts';
import { createAgentRuntime } from '../runtime/index.ts';
import { coreSkills } from '../runtime/prompt.ts';
import { createApp } from './app.ts';
import { createWorkAdmission, createWorkConsumers } from './work-admission.ts';
import { learnWritingStyle } from './writing-style.ts';
import { createTenantDrain } from './tenant-drain.ts';
import { createChatVerification } from './chat-verification.ts';
import { createAgentReactionService } from './agent-reactions.ts';
import { createApprovals } from './approvals.ts';
import { appActionConfirmation } from './action-presentation.ts';
import { createTrust } from './trust.ts';
import { createArtifactService, localArtifacts } from './artifacts.ts';
import { memoryDigest, memoryFileName, memoryMarkdown } from '../shared/memory-export.ts';
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
import { createPool, initializeDatabase, pool } from './db.ts';
import { events, refresh } from './events.ts';
import { createIntegrations } from './integrations.ts';
import { createErrorRedactor } from './redaction.ts';
import { createLedger } from './ledger.ts';
import { usageDigest, usageFileName, usagePdf } from './usage-report.ts';
import { buildFeedbackReport, type FeedbackReportOptions } from './bug-report.ts';
import { registerFeedback } from './feedback.ts';
import { feedbackContext } from './feedback-context.ts';
import { createPersonalService } from './personal.ts';
import { createOnboardingInterview } from './onboarding-interview.ts';
import { createOnboardingSuggestions } from './onboarding-suggestions.ts';
import { createMemoryLearning, initializeMemoryLearning } from './memory-learning.ts';
import { createMemoryService, importMemoryFile } from './memory.ts';
import { createSpeech } from './speech.ts';
import {
  activeThread,
  boss,
  createUserMessageService,
  enqueueTurn,
  initializeThreads,
  resumeAfterConnection,
  resumeAfterCredentials,
  resumeAfterPayment,
  retryCredentials,
  startThreadWorkers,
  stopThreadWorkers,
  withTurnLock,
  type TurnRef,
} from './thread.ts';
import { browserOf } from './turn-chain.ts';
import type { VaultActivityReason } from '../shared/contracts.ts';
import { createTriage } from './triage.ts';
import { createTasks } from './tasks.ts';
import { checkedKeyStore, createVault, credentialOrigin, sealedDataExists } from './vault.ts';
import { createVaultAccess } from './vault-access.ts';
import { createPayments } from './payments.ts';
import { createBrowserConnections } from './browser-connections.ts';
import { cachedIcons, createLinkPreviews } from './link-previews.ts';

export interface ApplicationAdapters {
  analytics?: ProductAnalytics;
  initialize?(): Promise<void>;
  observe?(turnId: string, event: RuntimeObservation): void;
  models?: ReturnType<typeof createModelService>;
  integrationKey?: ReturnType<typeof createIntegrationKeyService>;
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
  keyStore: CredentialKeyStore;
  memoryCurator?: MemoryCurator;
  onboardingCurator?: MemoryCurator;
  messaging?: MessagingTransport;
  linkPreviews?: LinkPreviewProvider;
  feedback?: FeedbackDelivery;
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
  const keyStore = checkedKeyStore(
    pool,
    env.OTTO_VAULT_KEY
      ? createEnvironmentKeyStore(env.OTTO_VAULT_KEY)
      : process.platform === 'darwin'
        ? createKeychainKeyStore({ canCreate: async () => !(await sealedDataExists(pool)) })
        : createEnvironmentKeyStore(),
  );
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
  const selectedCurator = createPiMemoryCurator({
    get provider() {
      return models.current.provider;
    },
    resolve: async () => {
      const access = await models.resolve();
      return { ...access, effort: lightestEffort(access.definition.choice.efforts) };
    },
    configured: () => models.configured,
  });
  const authConfigs: Partial<Record<IntegrationService, string>> = {
    gmail: env.COMPOSIO_GMAIL_AUTH_CONFIG_ID,
    googlecalendar: env.COMPOSIO_CALENDAR_AUTH_CONFIG_ID,
    googledrive: env.COMPOSIO_DRIVE_AUTH_CONFIG_ID,
    googlesheets: env.COMPOSIO_SHEETS_AUTH_CONFIG_ID,
    googledocs: env.COMPOSIO_DOCS_AUTH_CONFIG_ID,
    slack: env.COMPOSIO_SLACK_AUTH_CONFIG_ID,
  };
  const integrations = createComposioProvider({
    apiKey: env.COMPOSIO_API_KEY,
    webhookSecret: env.COMPOSIO_WEBHOOK_SECRET,
    webhooksVerified: runtimeMode === 'tenant' && env.OTTO_COMPOSIO_WEBHOOKS === 'gateway',
    webhookUrl: env.OTTO_COMPOSIO_WEBHOOK_URL,
    authConfigs,
  });
  const integrationKey =
    runtimeMode === 'local' && !desktopMode
      ? createIntegrationKeyService({
          database: pool,
          ownerId,
          keyStore,
          provider: integrations,
          changed: refresh,
        })
      : undefined;
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
  const cloudflare =
    computerProvider === 'cloudflare'
      ? createCloudflareAdapters({
          ownerId,
          generation: runtimeGeneration,
          workspaceRoot: join(dataRoot, 'workspaces'),
        })
      : undefined;
  const remote = cloudflare ?? e2b;
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
      await integrationKey?.initialize();
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
      configRoot: join(dataRoot, 'pi'),
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
    integrations,
    ...(integrationKey ? { integrationKey } : {}),
    keyStore,
    memoryCurator: modelCurator,
    onboardingCurator: selectedCurator,
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
    feedback: createN8nFeedback({
      url: env.OTTO_FEEDBACK_URL ?? 'https://internal.users.n8n.cloud/webhook/otto/feedback',
      token: env.OTTO_FEEDBACK_TOKEN,
    }),
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
  const secrets = Object.entries(process.env)
    .filter(([key]) =>
      /(?:API_KEY|SECRET|PASSWORD|VAULT_KEY|BOT_TOKEN|ACCESS_TOKEN|DESKTOP_AUTH_TOKEN|FEEDBACK_TOKEN)$/.test(
        key,
      ),
    )
    .flatMap(([, value]) => (value ? [value] : []));
  if (process.env.DATABASE_URL) {
    secrets.push(process.env.DATABASE_URL);
    try {
      const password = decodeURIComponent(new URL(process.env.DATABASE_URL).password);
      if (password) secrets.push(password);
    } catch {}
  }
  adapters.models?.onSecrets((values) => secrets.push(...values));
  adapters.integrationKey?.onSecrets((values) => secrets.push(...values));
  const memoryCurator =
    adapters.memoryCurator ?? createPiMemoryCurator({ provider: adapters.model.provider });
  const ledger = createLedger({ pool, ownerId });
  await ledger.initialize();
  const { computer, workspace } = adapters;
  const curator = ledger.curator(memoryCurator);
  const onboardingCurator = adapters.onboardingCurator
    ? ledger.curator(adapters.onboardingCurator)
    : curator;
  const runtime = createAgentRuntime({
    agent: ledger.agent(adapters.agent),
    skills: createSkillLibrary(
      fileURLToPath(new URL('../runtime/skills/', import.meta.url)),
      coreSkills,
    ),
    computer,
    workspace,
    redactError: createErrorRedactor(secrets),
    observe: adapters.observe,
  });
  const speech = createSpeech(adapters.speech);
  let memoryStore = adapters.objectStore;
  if (!memoryStore) {
    const objects = createPostgresObjectStore({ database: pool, ownerId });
    await objects.initialize();
    await importMemoryFile(objects, join(dataRoot, 'objects', 'memory'));
    memoryStore = objects;
  }
  const memory = createMemoryService({ pool, ownerId, store: memoryStore });
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
  await personal.initialize({ workers: options.workers });
  const tasks = createTasks({ pool, ownerId, refresh });
  await tasks.initialize();
  const triage = createTriage({
    consumers,
    connectedApps: () => integrations.connectedApps(ownerId, true),
    sweep: () => vault.forgetExpiredHolds(),
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
    oauth: createDiscoveredOAuth(),
    runCli: workspace.connectedCliAvailable
      ? async (threadId, cli, args, environment, timeoutSeconds, signal) => {
          const session = workspace.open({
            threadId,
            workspacePath: join(dataRoot, 'workspaces', threadId),
            signal: signal ?? new AbortController().signal,
          });
          if (!session.runConnectedCli) throw new Error('Connected CLI commands are unavailable.');
          return session.runConnectedCli(cli, args, environment, timeoutSeconds);
        }
      : undefined,
    resumeConnection: resumeAfterConnection,
    refresh,
  });
  let vault!: Awaited<ReturnType<typeof createVault>>;
  let vaultAccess!: Awaited<ReturnType<typeof createVaultAccess>>;
  let payments!: Awaited<ReturnType<typeof createPayments>>;
  let browserConnections!: Awaited<ReturnType<typeof createBrowserConnections>>;
  const icon = adapters.linkPreviews?.icon
    ? cachedIcons((origin) => adapters.linkPreviews!.icon!(origin))
    : undefined;
  const integrations = await createIntegrations(pool, {
    admission,
    ownerId,
    provider: adapters.integrations,
    readWorkspaceFile: (turn, path, maxBytes) =>
      workspace.readArtifact(turn.threadId, path, maxBytes, 'attachment'),
    resumeConnection: resumeAfterConnection,
    learnWritingStyle: (read, stop) => learnWritingStyle({ memory, curator }, read, stop),
    wake: triage.triageEvent,
    refresh,
    baseUrl: publicOrigin,
    callbackReturnTo: desktopMode ? 'window' : undefined,
    discovered,
    browserAccounts: () => vault.list(ownerId),
    browserConnections: () => browserConnections.list(),
    icon,
  });
  vault = await createVault(pool, {
    refresh,
    keyStore: adapters.keyStore,
    resume: resumeAfterCredentials,
    retry: retryCredentials,
    inject: computer.injectCredentials,
    page: computer.currentPage,
    emailCode: (input, signal) => integrations.emailCode(ownerId, input, signal),
    icon,
    securityCodes: runtimeMode === 'local',
    onOwnerUse: (entry, client) => vaultAccess.ownerUse(entry, client),
    onUse: (use, client) =>
      vaultAccess.used(
        { threadId: use.threadId, turnId: use.turnId },
        {
          origin: use.origin,
          reason: use.reason,
          ...(use.entryId ? { itemId: use.entryId } : {}),
        },
        client,
      ),
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
    submitPayment: (turnId, code, paymentId) => payments.submitCode(turnId, code, paymentId),
    refresh,
  });
  const approvals = await createApprovals(
    (action, args, provenance) =>
      action === 'OTTO_vault_allow'
        ? vaultAccess.allow(args)
        : action === 'OTTO_payment_setting'
          ? payments.setting(provenance, args, true)
          : action === 'OTTO_payment_approve'
            ? payments.approve(provenance, args)
            : action.startsWith('OTTO_')
              ? personal.manage(action.slice('OTTO_'.length), args, provenance)
              : (async () => {
                  const result = await integrations.executeApproved(ownerId, action, args, {
                    threadId: provenance.threadId,
                    turnId: provenance.turnId,
                  });
                  await ledger.action(provenance.turnId, action);
                  return (
                    await saveIntegrationFiles(result, async (file) => {
                      const name = `${randomUUID()}-${basename(file.name)}`;
                      await workspace.writeArtifact(provenance.threadId, name, file.bytes);
                      return name;
                    })
                  ).value;
                })(),
    async (action, args) => {
      if (['OTTO_vault_allow', 'OTTO_payment_approve', 'OTTO_payment_setting'].includes(action))
        return;
      if (action.startsWith('OTTO_'))
        await personal.validateReview(action.slice('OTTO_'.length), args);
      else await integrations.prepare(ownerId, action, args);
    },
    (reply) => trust.answer(reply),
  );
  const reactions = createAgentReactionService({ pool, ownerId, refresh });
  const localAccounts = runtimeMode === 'local' ? createAccountStore(pool) : null;
  const accountProfiles = createAccountProfileStore(pool, ownerId);
  await (localAccounts ?? accountProfiles).initialize();
  const onboardingSuggestions = createOnboardingSuggestions({
    ownerId,
    curator: onboardingCurator,
    answers: async () =>
      (await memory.load()).entries
        .filter((entry) => entry.origin === 'stated' && entry.slug.startsWith('onboarding-'))
        .map((entry) => entry.text),
    gmail: async () =>
      (await integrations.connectedApps()).some(
        (app) => app.slug === 'gmail' && app.status === 'connected',
      ),
    inbox: integrations.inboxSnippets,
    telegram: async () =>
      Boolean(
        (await channelSettings?.status())?.channels.some(
          (channel) => channel.provider === 'telegram' && channel.enabled && channel.allowedUserId,
        ),
      ),
  });
  analytics.setUsageData(
    ownerId,
    localAccounts
      ? (await localAccounts.read(ownerId)).usageData
      : ((await accountProfiles.read())?.usageData ?? false),
  );
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
  async function permitVault(
    turn: TurnRef,
    target: {
      origin: string;
      kind: 'sign_in' | 'session' | 'form';
      account?: string;
      itemId?: string;
    },
  ): Promise<{ reason: VaultActivityReason } | { question: string }> {
    const access = await vaultAccess.authorize(turn, target);
    if (access.ok) return { reason: access.reason };
    const result = await approvals.request(turn, 'OTTO_vault_allow', access.args, {
      question: access.question,
    });
    if (result && typeof result === 'object' && 'requiresConfirmation' in result)
      return { question: String(result.question) };
    return { reason: 'allowed' };
  }
  const trust = createTrust({
    pool,
    ownerId,
    review: async (instructions, input) =>
      onboardingCurator.configured
        ? onboardingCurator.curate({ task: 'review', instructions, input })
        : undefined,
  });
  vaultAccess = await createVaultAccess(pool, {
    ownerId,
    check: trust.check,
    refresh,
  });
  payments = await createPayments(pool, {
    ownerId,
    uses: vault.uses,
    local: runtimeMode === 'local',
    inOtto: trust.inOtto,
    page: (threadId) => computer.currentPage(threadId),
    destinations: (threadId, fields) => computer.cardDestinations(threadId, fields),
    capture: (threadId) => computer.checkoutImage(threadId),
    cards: () => vault.paymentCards(),
    card: (id, version, client) => vault.paymentCard(id, version, client),
    remember: vault.setDoItForMe,
    keepCode: vault.keepSecurityCode,
    fill: (input) => computer.fillCard(input),
    resume: resumeAfterPayment,
    record: (turn, entry, client) => vaultAccess.record(turn, entry, client),
  });
  const userMessages = createUserMessageService({ confirmAction: approvals.chat });
  if (options.workers !== false) {
    await triage.initializeHeartbeat();
    await initializeMemoryLearning({ boss, consumers, run: learning.run });
    await startThreadWorkers({
      analytics: captureAnalytics,
      consumers,
      artifacts,
      writeArtifact: workspace.writeArtifact.bind(workspace),
      readArtifact: workspace.readArtifact.bind(workspace),
      executeConfirmation: approvals.executeConfirmed,
      reactToMessage: reactions.react,
      runTurn: (context) => ledger.withTurn(context.turnId, () => runtime.runTurn(context)),
      spendingLimitReached: ledger.limitReached,
      skipTurn: triage.staleCheck,
      accountProfile,
      connectedApps: integrations.connectedApps,
      memoryContext: memory.context,
      task: async (turn, input) => {
        const result = await withTurnLock(turn.turnId, (client) => tasks.act(client, turn, input));
        refresh();
        return result;
      },
      startTurn: tasks.inherit,
      connections: integrations.manageConnections,
      browserConnection: async (request, turn, signal, launch) => {
        const target = await browserConnections.target(request);
        if (!target) return browserConnections.request(request, turn, signal, launch);
        const access = await permitVault(turn, target);
        if ('question' in access) return { [appConfirmation]: access.question };
        const result = await browserConnections.request(request, turn, signal, launch);
        if (result.status === 'session_opened')
          await vaultAccess.record(turn, {
            action: 'session',
            origin: target.origin,
            reason: access.reason,
            itemId: result.connectionId,
            itemKind: 'session',
          });
        return result;
      },
      speech,
      manage: async (turn, action, args, { admit, ...provenance }) => {
        if (
          [
            'notification_preferences_update',
            'schedule_create',
            'schedule_update',
            'schedule_cancel',
          ].includes(action)
        ) {
          const input = await personal.validateReview(action, args);
          if (action === 'schedule_cancel') {
            const schedule = await personal.getSchedule(String(input.id));
            if (!schedule.enabled) return schedule;
          }
          const verdict = await trust.check(turn, `OTTO_${action}`, input);
          return approvals.request(turn, `OTTO_${action}`, input, {
            ...provenance,
            allowed: !verdict.confirm,
            admit,
          });
        }
        await admit?.(false);
        if (['memory_forget', 'memory_learn', 'memory_control'].includes(action)) {
          return withTurnLock(turn.turnId, () =>
            personal.manage(action, args, { ...provenance, turnId: turn.turnId }),
          );
        }
        if (action === 'usage_get') return ledger.read();
        return personal.manage(action, args, { ...provenance, turnId: turn.turnId });
      },
      paymentSetting: async (turn, input) => {
        const { args, question } = await payments.requestSetting(turn, input);
        if (!args.doItForMe) return payments.setting(turn, args, true);
        const result = await approvals.request(turn, 'OTTO_payment_setting', args, { question });
        if (result && typeof result === 'object' && 'requiresConfirmation' in result)
          return { [appConfirmation]: String(result.question) };
        return String(result);
      },
      requestPayment: async (turn, input, show) => {
        const result = await payments.request(turn, input);
        await show(result.image);
        if (!result.paymentId) return { question: result.question, url: result.url };
        const confirmation = await approvals.request(
          turn,
          'OTTO_payment_approve',
          { paymentId: result.paymentId },
          { question: result.question },
        );
        if (
          confirmation &&
          typeof confirmation === 'object' &&
          'requiresConfirmation' in confirmation
        )
          return { [appConfirmation]: String(confirmation.question) };
        throw new Error('This payment needs a fresh approval. Call pay again.');
      },
      requestCredential: async (turn, input) => {
        const { savedLoginId, ...request } = input;
        if (savedLoginId !== undefined && request.kind === 'otp')
          throw new Error('Saved logins cannot supply verification codes.');
        const origin = credentialOrigin(request.origin);
        const saved = (await vault.list(ownerId)).filter((entry) => entry.origin === origin);
        const chosen =
          savedLoginId !== undefined
            ? saved.find((entry) => entry.id === savedLoginId)
            : saved.length === 1
              ? saved[0]
              : undefined;
        const access = await permitVault(turn, {
          origin,
          kind:
            request.kind === 'otp'
              ? request.emailCode
                ? 'sign_in'
                : 'form'
              : chosen
                ? 'sign_in'
                : 'form',
          ...(chosen
            ? {
                itemId: chosen.id,
                ...(chosen.usernameHint ? { account: chosen.usernameHint } : {}),
              }
            : {}),
        });
        if ('question' in access) return { [appConfirmation]: access.question };
        const filled = async (itemId?: string) => {
          await vaultAccess.record(turn, {
            action: request.kind === 'otp' ? 'code' : 'sign_in',
            origin,
            reason: request.kind === 'otp' ? 'mailbox' : access.reason,
            ...(itemId ? { itemId, itemKind: 'login' as const } : {}),
          });
          return { filled: true as const };
        };
        if (request.kind === 'otp')
          return (await vault.fillEmailCode(turn, ownerId, request))
            ? filled()
            : vault.request(turn, ownerId, request);
        if (savedLoginId !== undefined)
          return (await vault.fillSaved(turn, ownerId, savedLoginId, request))
            ? filled(savedLoginId)
            : vault.request(turn, ownerId, request);
        const selected = await vault.fillSelected(turn, ownerId, request);
        if (selected) return filled();
        if (selected === undefined && chosen) {
          if (await vault.fillSaved(turn, ownerId, chosen.id, request)) return filled(chosen.id);
        }
        return vault.request(turn, ownerId, request);
      },
      integration: async (turn, action, args, options) => {
        const verdict =
          action === 'SEARCH_TOOLS'
            ? ({ confirm: false } as const)
            : await trust.check(turn, action, args);
        await options.admit?.(verdict.confirm);
        if (hasWorkspaceFiles(args))
          args = await withTurnLock(turn.turnId, () =>
            integrations.prepare(ownerId, action, args, turn, options.signal),
          );
        if (verdict.confirm) {
          const prepared = await integrations.prepare(ownerId, action, args);
          const account = (await integrations.list(ownerId, { refresh: false })).find(
            (item) => item.connectionId === prepared.connectionId,
          );
          const path = account?.accessPaths?.find((item) => item.id === prepared.pathId);
          const result = await approvals.request(turn, action, prepared, {
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
        const result = await integrations.execute(ownerId, action, args, turn, options?.signal);
        if (action !== 'SEARCH_TOOLS') await ledger.action(turn.turnId, action);
        return result;
      },
    });
  }
  const welcome = async (name?: string) => {
    if (adapters.model.configured) await onboardingSuggestions.complete(name);
  };
  const app = await createApp({
    analytics: captureAnalytics,
    admission,
    deploymentDrain,
    artifacts,
    submitMessage: userMessages.submit,
    verification: chatVerification,
    startOnboarding: welcome,
    planningTasks: onboardingSuggestions.planning,
    messageCosts: ledger.messageCosts,
    computer,
    configuration: () =>
      configuration({
        provider: adapters.model.provider,
        model: adapters.model.name,
        llmReady: adapters.model.configured,
        integrationsReady: adapters.integrations.configured,
      }),
  });
  adapters.models?.register(app);
  if (adapters.integrationKey) adapters.integrationKey.register(app);
  else if (runtimeMode === 'local' && desktopMode)
    registerIntegrationKeyRoutes(app, adapters.integrations);
  app.addHook('preClose', async () => {
    await adapters.models?.close();
  });
  const feedbackReportOptions: FeedbackReportOptions = {
    pool,
    ownerId,
    secrets,
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
  };
  await registerFeedback(app, {
    pool,
    ownerId,
    context: await feedbackContext({ runtimeMode, environment: process.env }),
    delivery: adapters.feedback ?? {
      configured: false,
      submit: async (input) => ({ submissionId: input.submissionId, status: 'rejected' }),
      status: async (submissionId) => ({ submissionId, status: 'rejected' }),
    },
    buildReport: () => buildFeedbackReport(feedbackReportOptions),
  });
  if (localAccounts) {
    registerPrivacyNotice(app, privacyNotice);
    createAccountSession({
      analytics,
      accounts: localAccounts,
      origin: publicOrigin,
      localUser: { id: ownerId, name: 'You', email: null, avatarUrl: null },
      developerIds: desktopMode ? new Set() : new Set([ownerId]),
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
      analytics.setUsageData(ownerId, (await accountProfiles.save(request.body)).usageData);
      return { ok: true };
    });
  }
  ledger.registerRoutes(app);
  if (adapters.linkPreviews) {
    const previews = adapters.linkPreviews;
    createLinkPreviews({
      metadata: (url) => previews.metadata(url),
      image: (url) => previews.image(url),
    }).registerRoutes(app);
  }
  vault.registerRoutes(app);
  payments.registerRoutes(app);
  vaultAccess.registerRoutes(app);
  browserConnections.registerRoutes(app);
  integrations.registerRoutes(app);
  personal.registerRoutes(app);
  createOnboardingInterview({ curator: onboardingCurator, memory }).registerRoutes(app);
  onboardingSuggestions.registerRoutes(app);
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
        verifier: setup.verifier,
        apply: async (environment) => {
          if (!channels) throw new Error('Messaging is not ready.');
          await channels.replaceTransport(setup.create(environment));
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
      transport: messaging,
      acceptVerification: (text, input) => chatVerification.accept(text, input),
      activeThread: (client) => activeThread(client),
      commandReply: async (command, client, threadId, link) => {
        const now = new Date();
        if (command === 'usage') {
          const report = await ledger.report();
          const file = threadId
            ? await artifacts.storeArtifact(
                usagePdf(report, now),
                usageFileName(now),
                'application/pdf',
                threadId,
                client,
              )
            : null;
          return {
            text: usageDigest(report, link),
            attachments: file ? [file] : [],
          };
        }
        const view = await personal.memoryView();
        const file = threadId
          ? await artifacts.storeArtifact(
              Buffer.from(memoryMarkdown(view, now)),
              memoryFileName(now),
              'text/markdown',
              threadId,
              client,
            )
          : null;
        return { text: memoryDigest(view, link), attachments: file ? [file] : [] };
      },
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
      submit: async (text, sourceId, client, channel, messageId, answer) =>
        (
          await userMessages.submit(text, [], {
            sourceId,
            channel,
            client,
            clientMessageId: messageId,
            answer,
          })
        ).turnId,
      answer: (text, channel) => userMessages.answer(text, { channel }),
    });
    channels.registerRoutes(app);
    await channelSettings?.recover();
  }
  await onboardingSuggestions.initialize();
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
    memory,
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

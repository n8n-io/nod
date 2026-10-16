import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  appConfirmation,
  type Agent,
  type BrowserStep,
  type RuntimeObservation,
} from '../ports/agent.ts';
import { lightestEffort } from '../shared/models.ts';
import type { ProductAnalytics } from '../ports/analytics.ts';
import { createPostHogAnalytics } from '../providers/posthog/analytics.ts';
import {
  analyticsEnabled,
  analyticsEnvironment,
  createAnalytics,
  type CaptureAnalytics,
} from './analytics.ts';
import { captureConnectionInventory } from './analytics-connections.ts';
import { createConversationAnalytics } from './conversation-analytics.ts';
import {
  BrowserActionError,
  type BrowserAction,
  type Computer,
  type Workspace,
} from '../ports/computer.ts';
import { fileBytes } from '../shared/files.ts';
import type { IntegrationProvider, IntegrationService } from '../ports/integrations.ts';
import { hasWorkspaceFiles, saveIntegrationFiles } from './integration-files.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { MemoryCurator } from '../ports/memory-curator.ts';
import type { DecisionModel, ModelReview } from '../ports/decisions.ts';
import { createDecisionModel } from '../providers/decisions.ts';
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
import { createApprovals, turnOrigin } from './approvals.ts';
import { createCommunication, publicText } from './communication.ts';
import { createTrust } from './trust.ts';
import { createArtifactService, localArtifacts } from './artifacts.ts';
import { memoryFileName, memoryMarkdown } from '../shared/memory-export.ts';
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
import {
  createTenantControl,
  createTenantChannelRegistry,
  createTenantAnalytics,
} from './tenant-control.ts';
import { createHostedWebhooks } from './hosted-webhooks.ts';
import { loadPrivacyNoticeFile, registerPrivacyNotice } from './privacy.ts';
import { createPool, initializeDatabase, pool } from './db.ts';
import { events, refresh } from './events.ts';
import { createIntegrations } from './integrations.ts';
import { createErrorRedactor } from './redaction.ts';
import { createLedger, limitsInput } from './ledger.ts';
import { usageFileName, usagePdf } from './usage-report.ts';
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
  reactToAssistantMessage,
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
  analyticsCurator?: MemoryCurator;
  onboardingCurator?: MemoryCurator;
  decisions?: DecisionModel;
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
  const defaultFeedbackUrl = 'https://internal.users.n8n.cloud/webhook/otto/feedback';
  const feedbackUrl = env.OTTO_FEEDBACK_URL ?? defaultFeedbackUrl;
  const feedbackEnabled = env.OTTO_FEEDBACK_ENABLED !== 'false';
  if (
    feedbackEnabled &&
    feedbackUrl &&
    feedbackUrl !== defaultFeedbackUrl &&
    !env.OTTO_FEEDBACK_RECEIPT_URL_PREFIX
  )
    throw new Error('Set OTTO_FEEDBACK_RECEIPT_URL_PREFIX when using a custom feedback intake.');
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
  const decisions = createDecisionModel({
    resolve: async () => {
      if (env.TYPESAFE_API_KEY?.trim())
        return { provider: 'typesafe', key: env.TYPESAFE_API_KEY.trim() };
      if (!models.configured) return;
      const access = await models.resolve();
      if (access.method === 'subscription' || access.provider === 'anthropic') return;
      const credential = await access.read();
      if (credential?.type !== 'api_key') throw new Error('The model connection is unavailable.');
      return { provider: access.provider, key: credential.key };
    },
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
    ...(analyticsEnabled(env)
      ? {
          analytics:
            runtimeMode === 'tenant'
              ? createTenantAnalytics({
                  origin: env.OTTO_CONTROL_URL!,
                  ownerId,
                  environment: env.OTTO_ENVIRONMENT!,
                  generation: env.OTTO_RUNTIME_GENERATION!,
                  secret: env.OTTO_RUNTIME_SECRET!,
                })
              : createPostHogAnalytics(),
        }
      : {}),
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
    analyticsCurator: selectedCurator,
    onboardingCurator: selectedCurator,
    decisions,
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
      enabled: feedbackEnabled,
      url: feedbackUrl,
      token: env.OTTO_FEEDBACK_TOKEN,
      receiptUrlPrefix:
        feedbackUrl === defaultFeedbackUrl ? undefined : env.OTTO_FEEDBACK_RECEIPT_URL_PREFIX,
      recipient: feedbackUrl === defaultFeedbackUrl ? 'n8n' : undefined,
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
    appVersion:
      process.env.OTTO_APP_VERSION || process.env.OTTO_IMAGE_RELEASE || process.env.OTTO_RELEASE,
  });
  let observeConnections: (() => Promise<void>) | undefined;
  const captureAnalytics: CaptureAnalytics = (event, delivery) => {
    analytics.capture(ownerId, event, delivery);
    if (
      event.event === 'otto_connection_changed' &&
      ['connected', 'disconnected'].includes(event.properties.status)
    )
      void observeConnections?.();
  };
  const analyticsConsent = () => analytics.consent(ownerId);
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
  const decisions = adapters.decisions && ledger.decisions(adapters.decisions);
  const review: ModelReview = async (instructions, input, signal, question) => {
    if (question) {
      const result = await decisions?.check({ instructions, input, question }, signal);
      if (result !== undefined) return result;
      const values =
        question.name === 'run' ? [true, false] : question.choices.map(({ value }) => value);
      instructions += `\nReply with only JSON with one property, ${JSON.stringify(question.name)}. Its value must be one of: ${values.map((value) => JSON.stringify(value)).join(', ')}.`;
    }
    return onboardingCurator.configured
      ? onboardingCurator.curate({ task: 'review', instructions, input }, signal)
      : undefined;
  };
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
  const communication = createCommunication({
    pool,
    ownerId,
    review,
    preferences: async () =>
      (await memory.load()).entries
        .filter(
          (entry) =>
            entry.area === 'preferences' &&
            entry.origin === 'stated' &&
            (!entry.expires || entry.expires >= new Date().toISOString().slice(0, 10)),
        )
        .map((entry) => entry.text),
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
  await personal.initialize({ workers: options.workers });
  const tasks = createTasks({
    pool,
    ownerId,
    refresh,
    discardBrowser: (id) => adapters.computer.discard(id),
  });
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
    analytics: captureAnalytics,
    analyticsConsent,
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
    analytics: captureAnalytics,
    analyticsConsent,
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
    analytics: captureAnalytics,
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
    analytics: captureAnalytics,
    analyticsConsent,
    ownerId,
    computer,
    refresh,
  });
  const chatVerification = await createChatVerification(pool, {
    ownerId,
    present: communication.present,
    keyStore: adapters.keyStore,
    submitCode: vault.submitChatCode,
    submitPayment: (turnId, code, paymentId) => payments.submitCode(turnId, code, paymentId),
    refresh,
  });
  const browserStepArgs = ({ step, page, typed }: BrowserStep) => {
    const {
      timeZone: _timeZone,
      locale: _locale,
      expectOrigin: _expectOrigin,
      readOnly: _readOnly,
      expectUrl: _expectUrl,
      ...command
    } = step as BrowserAction;
    return {
      website: page.origin,
      page: page.url,
      step: step.action,
      ...(page.controls?.length ? { control: page.controls } : {}),
      ...(page.dropTarget?.length ? { dropTarget: page.dropTarget } : {}),
      ...(page.dialog !== undefined ? { dialog: page.dialog } : {}),
      ...(step.action === 'upload' ? { file: basename(step.path) } : {}),
      ...(typed.length ? { typedOnPage: typed } : {}),
      command,
    };
  };
  const replayBrowserStep = async (
    args: Record<string, unknown>,
    provenance: { threadId: string; turnId: string },
  ) => {
    const command = args.command as Omit<BrowserAction, 'action'> & {
      action: BrowserAction['action'] | 'upload';
      path?: string;
    };
    const expectOrigin = String(args.website);
    const browserId = (
      await pool.query<{ session_id: string }>(
        'SELECT session_id FROM turns WHERE id=$1 AND owner_id=$2',
        [provenance.turnId, ownerId],
      )
    ).rows[0]?.session_id;
    const notRun = () =>
      Object.assign(new BrowserActionError('browser_target_changed'), { notRun: true });
    if (!browserId) throw notRun();
    const current = await computer
      .currentPage(
        browserId,
        command.action === 'accept_dialog' ? (command as BrowserAction) : undefined,
      )
      .catch(() => undefined);
    if (
      current?.origin !== expectOrigin ||
      current.url !== args.page ||
      current.dialog !== args.dialog
    )
      throw notRun();
    try {
      const page =
        command.action === 'upload'
          ? await computer.upload(browserId, {
              selector: String(command.selector),
              name: basename(String(command.path)),
              bytes: await workspace.readArtifact(
                provenance.threadId,
                String(command.path),
                fileBytes,
              ),
              expectOrigin,
              expectUrl: String(args.page),
            })
          : await computer.act(browserId, {
              ...(command as BrowserAction),
              expectOrigin,
              expectUrl: String(args.page),
            });
      return { url: page.url, page: page.text };
    } catch (error) {
      if (error instanceof BrowserActionError && error.code === 'browser_target_changed')
        throw notRun();
      throw error;
    }
  };
  const approvals = await createApprovals(
    (action, args, provenance) =>
      action === 'OTTO_browser'
        ? replayBrowserStep(args, provenance)
        : action === 'OTTO_vault_allow'
          ? vaultAccess.allow(args)
          : action === 'OTTO_payment_setting'
            ? payments.setting(provenance, args, true)
            : action === 'OTTO_payment_approve'
              ? payments.approve(provenance, args)
              : action === 'OTTO_limits_update'
                ? ledger.setLimits(args)
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
    async (action, args, expectedRevision) => {
      if (
        [
          'OTTO_browser',
          'OTTO_vault_allow',
          'OTTO_payment_approve',
          'OTTO_payment_setting',
        ].includes(action)
      )
        return;
      if (action === 'OTTO_limits_update') limitsInput.parse(args);
      else if (action.startsWith('OTTO_')) {
        if (
          ['OTTO_schedule_update', 'OTTO_schedule_cancel'].includes(action) &&
          expectedRevision === undefined
        )
          throw Object.assign(new Error('This schedule needs a fresh approval.'), {
            statusCode: 409,
          });
        await personal.validateReview(action.slice('OTTO_'.length), args, expectedRevision);
      } else await integrations.prepare(ownerId, action, args);
    },
    (reply) => trust.answer(reply),
    communication.describe,
  );
  let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
  const reactions = createAgentReactionService({
    pool,
    ownerId,
    refresh,
    deliver: async (messageId, reaction, signal) =>
      channels ? channels.react(messageId, reaction, signal) : 'absent',
  });
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
  const localConsent = await localAccounts?.readConsent(ownerId);
  analytics.setUsageData(
    ownerId,
    runtimeMode === 'tenant'
      ? Boolean(
          (await accountProfiles.read())?.usageData &&
          (await adapters.analytics?.permitted?.().catch(() => false)),
        )
      : localConsent
        ? localConsent.enabled
        : ((await accountProfiles.read())?.usageData ?? false),
    localConsent?.revision,
  );
  let pendingInventory = Promise.resolve();
  observeConnections = () =>
    (pendingInventory = pendingInventory
      .then(() =>
        captureConnectionInventory(analytics, ownerId, async () =>
          (
            await Promise.all([
              integrations.analyticsConnections(),
              discovered.analyticsConnections(),
              browserConnections.analyticsConnections(),
            ])
          ).flat(),
        ),
      )
      .catch(() => {}));
  const stopConnectionInventory = analytics.subscribe(ownerId, (enabled) => {
    if (enabled) void observeConnections?.();
  });
  void observeConnections();
  const conversationAnalytics = createConversationAnalytics({
    pool,
    ownerId,
    analytics,
    curator: adapters.analyticsCurator ? ledger.curator(adapters.analyticsCurator) : curator,
    secrets,
  });
  await conversationAnalytics.initialize();
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
      sessionOrigin?: string;
    },
  ): Promise<{ reason: VaultActivityReason } | { question: string }> {
    const access = await vaultAccess.authorize(turn, target);
    if (access.ok) return { reason: access.reason };
    const result = await approvals.request(turn, 'OTTO_vault_allow', access.args, {
      details: access.details,
    });
    if (result && typeof result === 'object' && 'requiresConfirmation' in result)
      return { question: String(result.question) };
    return { reason: 'allowed' };
  }
  const trust = createTrust({
    pool,
    ownerId,
    review,
  });
  vaultAccess = await createVaultAccess(pool, {
    ownerId,
    check: trust.check,
    refresh,
  });
  payments = await createPayments(pool, {
    ownerId,
    present: (turn, input) => communication.present(turn.threadId, input),
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
  const userMessages = createUserMessageService({
    confirmAction: approvals.chat,
    taskReply: tasks.resolveReply,
  });
  if (options.workers !== false) {
    await triage.initializeHeartbeat();
    await initializeMemoryLearning({ boss, consumers, run: learning.run });
    await startThreadWorkers({
      present: communication.present,
      analytics: captureAnalytics,
      observeTurn: conversationAnalytics.observe,
      consumers,
      artifacts,
      writeArtifact: workspace.writeArtifact.bind(workspace),
      readArtifact: workspace.readArtifact.bind(workspace),
      executeConfirmation: approvals.executeConfirmed,
      reactToMessage: reactions.react,
      runTurn: (context) => ledger.withTurn(context.turnId, () => runtime.runTurn(context)),
      spendingLimitReached: ledger.limitReached,
      checkIn: ledger.checkIn,
      skipTurn: triage.staleCheck,
      accountProfile,
      connectedApps: integrations.connectedApps,
      memoryContext: memory.context,
      taskContext: tasks.context,
      taskLedger: tasks.read,
      task: tasks.execute,
      startTurn: tasks.inherit,
      connections: async (...args) => {
        const result = await integrations.manageConnections(...args);
        if (!('url' in result) || !('name' in result) || typeof result.name !== 'string')
          return result;
        const turn = args[2];
        if (!turn) throw new Error('The connection needs an active conversation.');
        const message = await communication.present(turn.threadId, {
          kind: 'connection',
          app: result.name,
          next: 'connect_account_then_continue',
        });
        return { ...result, message };
      },
      browserStep: async (turn, request, signal) => {
        const args = browserStepArgs(request);
        const verdict = await trust.check(turn, 'OTTO_browser', args);
        if (!verdict.confirm) return 'run';
        if (request.subagent) return 'refused';
        const visible =
          turn.browserId &&
          (await computer
            .act(
              turn.browserId,
              {
                action: 'evaluate',
                script: 'document.body.innerText',
                readOnly: true,
                expectOrigin: request.page.origin,
                expectUrl: request.page.url,
              },
              signal,
            )
            .then(
              (page) => {
                try {
                  return JSON.parse(page.text.slice(page.text.indexOf('\n') + 1)) as unknown;
                } catch {
                  return undefined;
                }
              },
              () => undefined,
            ));
        const result = await approvals.request(turn, 'OTTO_browser', args, {
          signal,
          details: {
            reason: verdict.reason,
            ...(typeof visible === 'string' && visible.trim()
              ? { pageText: publicText(visible.slice(0, 20_000)) }
              : {}),
          },
        });
        return result && typeof result === 'object' && 'requiresConfirmation' in result
          ? { [appConfirmation]: String(result.question) }
          : { result };
      },
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
        if (action === 'limits_update') {
          const input = limitsInput.parse(args);
          const verdict = await trust.check(turn, 'OTTO_limits_update', input);
          return approvals.request(turn, 'OTTO_limits_update', input, {
            ...provenance,
            allowed: !verdict.confirm,
            admit,
            details: {
              current: await ledger.limits(),
              ...(verdict.confirm ? { reason: verdict.reason } : {}),
            },
          });
        }
        if (
          [
            'notification_preferences_update',
            'schedule_create',
            'schedule_update',
            'schedule_cancel',
          ].includes(action)
        ) {
          const input = await personal.validateReview(action, args);
          const schedule =
            action === 'schedule_cancel' || action === 'schedule_update'
              ? await personal.getSchedule(String(input.id))
              : undefined;
          if (action === 'schedule_cancel' && schedule && !schedule.enabled) return schedule;
          const current = schedule
            ? {
                title: schedule.title,
                prompt: schedule.prompt,
                cron: schedule.cron,
                runAt: schedule.runAt,
                timeZone: schedule.timeZone,
              }
            : undefined;
          const verdict = await trust.check(
            turn,
            `OTTO_${action}`,
            current ? { ...input, currentSchedule: current } : input,
          );
          return approvals.request(turn, `OTTO_${action}`, input, {
            ...provenance,
            allowed: !verdict.confirm,
            admit,
            expectedRevision: schedule?.revision,
            validate: schedule
              ? async (client) => {
                  const current = (
                    await client.query(
                      'SELECT revision FROM schedules WHERE id=$1 AND owner_id=$2 FOR SHARE',
                      [schedule.id, ownerId],
                    )
                  ).rows[0];
                  if (current?.revision !== schedule.revision)
                    throw Object.assign(
                      new Error('The schedule changed. Review it before asking again.'),
                      { statusCode: 409 },
                    );
                }
              : undefined,
            details: {
              ...(verdict.confirm ? { reason: verdict.reason } : {}),
              ...(current ? { schedule: current } : {}),
            },
          });
        }
        await admit?.(false);
        if (['memory_forget', 'memory_learn', 'memory_control'].includes(action)) {
          const origin = await turnOrigin(turn.turnId);
          return withTurnLock(turn.turnId, () =>
            personal.manage(action, args, {
              ...provenance,
              turnId: turn.turnId,
              ownerRooted: origin?.source === 'user',
            }),
          );
        }
        if (action === 'usage_get') return ledger.read();
        return personal.manage(action, args, { ...provenance, turnId: turn.turnId });
      },
      paymentSetting: async (turn, input) => {
        const { args, details } = await payments.requestSetting(turn, input);
        if (!args.doItForMe) return payments.setting(turn, args, true);
        const result = await approvals.request(turn, 'OTTO_payment_setting', args, { details });
        if (result && typeof result === 'object' && 'requiresConfirmation' in result)
          return { [appConfirmation]: String(result.question) };
        return String(result);
      },
      requestPayment: async (turn, input, show) => {
        const result = await payments.request(turn, input);
        await show(result.image);
        if (result.paymentId === undefined) return { question: result.question, url: result.url };
        const confirmation = await approvals.request(
          turn,
          'OTTO_payment_approve',
          { paymentId: result.paymentId },
          { details: result.details },
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
            signal: options.signal,
            details: {
              reason: verdict.reason,
              ...(account
                ? {
                    account: {
                      name: account.name,
                      identity: account.accountEmail ?? account.accountName,
                      ...(path ? { method: path.kind, endpoint: path.endpoint } : {}),
                    },
                  }
                : {}),
            },
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
    taskLedger: tasks.read,
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
      recipient: null,
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
      present: communication.present,
      appOrigin: runtimeMode === 'tenant' ? publicOrigin : undefined,
      resolveAttachments: artifacts.readThreadArtifacts,
      ...(channelSettings ? { pair: channelSettings.pair } : {}),
      transport: messaging,
      acceptVerification: (text, input) => chatVerification.accept(text, input),
      reacted: (messageId, reaction) =>
        reactToAssistantMessage(messageId, reaction, adapters.model.configured),
      activeThread: (client) => activeThread(client),
      taskCommand: tasks.chatCommand,
      commandReply: async (command, client, threadId) => {
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
            text: '',
            presentation: {
              kind: 'command',
              command,
              data: {
                week: report.view.week,
                month: report.view.month,
                limit: report.view.limit,
                timeZone: report.timeZone,
              },
            },
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
        return {
          text: '',
          presentation: { kind: 'command', command: 'memory', data: view },
          attachments: file ? [file] : [],
        };
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
      submit: async (text, sourceId, client, channel, messageId, answer, replyToMessageId) =>
        (
          await userMessages.submit(text, [], {
            sourceId,
            channel,
            client,
            clientMessageId: messageId,
            replyToMessageId,
            answer,
          })
        ).turnId,
      answer: (text, channel, replyToMessageId) =>
        userMessages.answer(text, { channel, replyToMessageId }),
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
    stopConnectionInventory();
    const failures: unknown[] = [];
    for (const close of [
      () => channels?.close(),
      () => stopThreadWorkers(),
      () => conversationAnalytics.close(),
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
  const accounts = createAccountStore(authenticationDatabase);
  const analytics = await createAnalytics({
    provider: analyticsEnabled(env)
      ? createPostHogAnalytics({
          permitted: async (distinctId, revision) => {
            if (!distinctId.startsWith('hosted:') || revision === undefined) return false;
            const current = await accounts.readConsent(distinctId.slice(7));
            return current.enabled && current.revision === revision;
          },
        })
      : undefined,
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
        analytics: {
          consent: async (owner) => {
            const current = await accounts.readConsent(owner);
            return { ...current, enabled: analyticsEnabled(env) && current.enabled };
          },
          capture: (owner, event, delivery) => {
            analytics.setUsageData(owner, true, delivery?.consentRevision);
            analytics.capture(owner, event, delivery);
          },
        },
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

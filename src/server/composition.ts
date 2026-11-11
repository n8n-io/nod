import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  appConfirmation,
  type Agent,
  type BrowserStep,
  type RuntimeObservation,
} from '../ports/agent.ts';
import {
  apiKeyConnectionProviders,
  lightestEffort,
  modelProviderInfo,
  modelProviders,
  modelSource,
} from '../shared/models.ts';
import type { ProductAnalytics } from '../ports/analytics.ts';
import { createPostHogAnalytics } from '../providers/posthog/analytics.ts';
import type { OnboardingEmailDelivery } from '../ports/onboarding-email.ts';
import { createN8nOnboardingEmail } from '../providers/n8n/onboarding-email.ts';
import {
  analyticsEnabled,
  analyticsEnvironment,
  createAnalytics,
  snapshotAnalytics,
  toolUsed,
  type CaptureAnalytics,
} from './analytics.ts';
import { clearConversationAnalytics } from './conversation-analytics.ts';
import { createTaskClassification } from './task-classification.ts';
import { captureConnectionInventory } from './analytics-connections.ts';
import {
  BrowserActionError,
  type BrowserAction,
  type Computer,
  type Workspace,
} from '../ports/computer.ts';
import { fileBytes } from '../shared/files.ts';
import type { ObservationProvider, ObservationSource } from '../ports/proactivity.ts';
import type { IntegrationProvider } from '../ports/integrations.ts';
import { hasWorkspaceFiles, saveIntegrationFiles } from './integration-files.ts';
import { privateEmailResult } from './integration-result.ts';
import { createMailCheck } from './mail-check.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { PasswordManager } from '../ports/password-manager.ts';
import type { Trash } from '../ports/trash.ts';
import { desktopTrash } from '../providers/trash.ts';
import type { MemoryCurator } from '../ports/memory-curator.ts';
import type { DecisionModel, ModelReview } from '../ports/decisions.ts';
import { createDecisionModel, createOpenRouterDecisionCatalog } from '../providers/decisions.ts';
import type { SpeechProvider, LocalSpeechControls } from '../ports/speech.ts';
import { createLocalSpeechProvider } from '../providers/local-speech/index.ts';
import type { MessagingTransport } from '../ports/messaging.ts';
import type { ChannelSetupVerifier } from '../ports/channel-settings.ts';
import type { LinkPreviewProvider } from '../ports/link-preview.ts';
import type { FeedbackDelivery } from '../ports/feedback.ts';
import { createN8nFeedback } from '../providers/n8n/feedback.ts';
import { createN8nTraces } from '../providers/n8n/traces.ts';
import { createOtlpTelemetry } from '../providers/otlp/telemetry.ts';
import type { UsageTelemetry } from '../ports/provider-usage.ts';
import { agentModels } from '../shared/model-defaults.ts';
import { createChatSdkTransport } from '../providers/chat-sdk/index.ts';
import { createWhatsAppLinkedTransport } from '../providers/chat-sdk/whatsapp.ts';
import { combineMessagingTransports } from '../providers/chat-sdk/combined.ts';
import { createChatSdkSetupVerifier } from '../providers/chat-sdk/settings.ts';
import { createContainerBrowserComputer } from '../providers/container-browser/index.ts';
import {
  createOnePassword,
  desktopOnePassword,
  forkedOnePassword,
} from '../providers/onepassword/index.ts';
import { createComposioProvider } from '../providers/composio/integrations.ts';
import { createComposioProxy } from '../providers/composio/proxy.ts';
import {
  createDiscoveredTransport,
  ownerAddress,
  ownerFetch,
} from '../providers/discovered/remote.ts';
import { createDiscoveredOAuth } from '../providers/discovered/oauth.ts';
import { createDiscoveredConnections } from './discovered-connections.ts';
import { createLocalFiles, isLocalFilesAction } from './local-files.ts';
import { createAppGrantVault } from './vault-app-grants.ts';
import { createDockerWorkspace } from '../providers/docker/index.ts';
import { createEnvironmentKeyStore } from '../providers/environment/key-store.ts';
import { createKeychainKeyStore } from '../providers/keychain/key-store.ts';
import { createFilesystemKeyStore } from '../providers/filesystem/key-store.ts';
import { createOpenAISpeechProvider } from '../providers/openai/speech.ts';
import { createElevenLabsSpeechProvider } from '../providers/elevenlabs/speech.ts';
import {
  createOpenRouterTranscriptionProvider,
  createOpenRouterSpeechProvider,
} from '../providers/openrouter/speech.ts';
import { createPreferencesStore } from './preferences.ts';
import { registerSpeechSettings } from './speech-settings.ts';
import { createImageAnalysis } from './images.ts';
import { createPiModelBackend } from '../providers/pi/models.ts';
import { createModelService, endpointAddress, modelKeyCredential } from './models.ts';
import { createIntegrationBrowser } from './integration-browser.ts';
import { createIntegrationIdentityCheckpoint } from './integration-identity.ts';
import { createPiAgent } from '../providers/pi/index.ts';
import { createSkillLibrary } from '../providers/pi/skills.ts';
import { createFeedbackActivity, parseFeedbackActivity } from '../shared/feedback-activity.ts';
import { createFeedbackLog } from './feedback-log.ts';
import { createFeedbackRedactor } from './feedback-redaction.ts';
import { withFailureLog, type FailureLogSink } from './failure-log.ts';
import { createPiMemoryCurator } from '../providers/pi/memory-curator.ts';
import { createPublicLinkPreviewProvider } from '../providers/public-web/link-preview.ts';
import { createAgentRuntime } from '../runtime/index.ts';
import { coreSkills } from '../runtime/prompt.ts';
import { createApp } from './app.ts';
import { credentialRequestKey } from './access.ts';
import { createWorkAdmission, createWorkConsumers } from './work-admission.ts';
import { createWritingStyleLearning } from './writing-style.ts';
import { createChatVerification } from './chat-verification.ts';
import { createAgentReactionService } from './agent-reactions.ts';
import { createApprovals, turnOrigin } from './approvals.ts';
import { createCommunication, publicText } from './communication.ts';
import { logFailure } from './failure-log.ts';
import { createTrust } from './trust.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import { createProactivity } from './proactivity.ts';
import {
  connectionSources,
  createConnectionSources,
  type AppAccount,
  type AppTool,
} from './app-reads.ts';
import { lockProactivity } from './locks.ts';
import { createObservationSources } from './observation-sources.ts';
import { createTaskObservations } from './task-observations.ts';
import type { TrustBasis } from './trust-basis.ts';
import { localArtifacts } from './artifacts.ts';
import { memoryFileName, memoryMarkdown } from '../shared/memory-export.ts';
import { createChannels } from './channels.ts';
import { createChannelSettings, managedChannelEnvironment } from './channel-settings.ts';
import { createChannelMedia } from './channel-media.ts';
import { createChannelSessionStore } from './channel-session.ts';
import { configuration, dataRoot, desktopMode, ownerId, publicOrigin } from './config.ts';
import { createAccountStore } from './account-store.ts';
import { createModelTraces, type ModelTraceGate } from './traces.ts';
import { runtimeAccount } from './account-profile.ts';
import { createAccountSession } from './account.ts';
import { connectedGmail } from '../shared/onboarding.ts';
import { createPostgresObjectStore } from './object-storage.ts';
import { loadPrivacyNoticeFile, registerPrivacyNotice } from './privacy.ts';
import { initializeDatabase, pool } from './db.ts';
import { events, refresh } from './events.ts';
import { createIntegrations } from './integrations.ts';
import {
  createErrorRedactor,
  createRedactor,
  createTextRedactor,
  environmentSecrets,
} from './redaction.ts';
import { createLedger, limitsInput } from './ledger.ts';
import { usageFileName, usagePdf } from './usage-report.ts';
import { buildFeedbackReport, type FeedbackReportOptions } from './bug-report.ts';
import { registerFeedback } from './feedback.ts';
import { feedbackContext } from './feedback-context.ts';
import { createPersonalService } from './personal.ts';
import { createOnboardingSuggestions } from './onboarding-suggestions.ts';
import { createOnboardingProfile } from './onboarding-profile.ts';
import { createMemoryLearning, initializeMemoryLearning } from './memory-learning.ts';
import { createMemoryService, importMemoryFile } from './memory.ts';
import { createMemoryRecall } from './memory-recall.ts';
import { createLearnedSkills } from './learned-skills.ts';
import { automaticSpeechVoice, createSpeech } from './speech.ts';
import {
  activeThread,
  boss,
  createUserMessageService,
  enqueueTurn,
  initializeThreads,
  lockThread,
  reactToAssistantMessage,
  resumeAfterConnection,
  resumeAfterCredentials,
  resumeAfterPayment,
  retryCredentials,
  startThreadWorkers,
  stopSignal,
  stopThreadWorkers,
  withTurnLock,
  type TurnRef,
} from './thread.ts';
import type { VaultActivityReason } from '../shared/contracts.ts';
import { createTriage, getPreferences } from './triage.ts';
import { createTasks } from './tasks.ts';
import { createActivity } from './activity.ts';
import { checkedKeyStore, createVault, credentialOrigin, sealedDataExists } from './vault.ts';
import { createVaultAccess } from './vault-access.ts';
import { createPayments } from './payments.ts';
import { BrowserConnectionError, createBrowserConnections } from './browser-connections.ts';
import { cachedIcons, registerLinkOpened } from './link-previews.ts';
export interface ApplicationAdapters {
  analytics?: ProductAnalytics;
  onboardingEmail?: OnboardingEmailDelivery;
  initialize?(): Promise<void>;
  observe?(turnId: string, event: RuntimeObservation): void;
  models?: ReturnType<typeof createModelService>;
  integrationBrowser?: ReturnType<typeof createIntegrationBrowser>;
  agent: Agent;
  computer: Computer;
  workspace: Workspace;
  speech: SpeechProvider;
  localSpeech?: LocalSpeechControls;
  speechInputFormat?: (voice: string | null) => 'wav' | undefined;
  integrations: IntegrationProvider;
  observations?: ObservationProvider[];
  keyStore: CredentialKeyStore;
  passwordManager?: PasswordManager;
  trash?: Trash;
  localFilesHome?: string;
  memoryCurator?: MemoryCurator;
  classificationCurator?: MemoryCurator;
  imageCurator?: MemoryCurator;
  onboardingCurator?: MemoryCurator;
  decisions?: DecisionModel;
  trustModel?: 'selected' | 'llm' | 'decision';
  trustDecisions?: DecisionModel;
  trustCurator?: MemoryCurator;
  messaging?: MessagingTransport;
  linkPreviews?: LinkPreviewProvider;
  feedback?: FeedbackDelivery;
  traces?: ModelTraceGate;
  telemetry?: UsageTelemetry;
  messagingSetup?: {
    verifier: ChannelSetupVerifier;
    managed?: ReturnType<typeof managedChannelEnvironment>;
    create(environment: Record<string, string>): MessagingTransport;
  };
  model: { provider: string; name: string; configured: boolean; reconnect?: boolean };
}

export function modelEnvironment(
  env: Record<string, string | undefined>,
): NonNullable<Parameters<typeof createModelService>[0]['bootstrap']> {
  const provider = z.enum(modelProviders).parse(env.LLM_PROVIDER || 'openai');
  const endpoint =
    env.OPENAI_COMPATIBLE_BASE_URL && endpointAddress(env.OPENAI_COMPATIBLE_BASE_URL);
  if (env.OPENAI_COMPATIBLE_BASE_URL && !endpoint)
    throw new Error(
      'OPENAI_COMPATIBLE_BASE_URL must be a plain http or https address, such as http://localhost:11434/v1.',
    );
  return {
    provider,
    model: env.LLM_MODEL || undefined,
    credentials: {
      ...Object.fromEntries(
        apiKeyConnectionProviders.flatMap((id) => {
          const key = env[modelProviderInfo[id].env]?.trim();
          if (!key) return [];
          try {
            return [
              [
                id,
                modelKeyCredential(id, key, {
                  region: env.AWS_REGION,
                  url: env.AZURE_OPENAI_ENDPOINT,
                  model: env.AZURE_OPENAI_MODEL,
                  deployment: env.AZURE_OPENAI_DEPLOYMENT,
                  accountId: env.CLOUDFLARE_ACCOUNT_ID,
                  gatewayId: env.CLOUDFLARE_GATEWAY_ID,
                  workspaceId: env.ANTHROPIC_WORKSPACE_ID,
                }),
              ],
            ];
          } catch (error) {
            if (id === 'anthropic')
              throw new Error(
                'ANTHROPIC_WORKSPACE_ID must be a Workspace ID from the Claude Console.',
              );
            throw error;
          }
        }),
      ),
      ...(endpoint && {
        compatible: {
          type: 'endpoint',
          url: endpoint,
          ...(env.OPENAI_COMPATIBLE_API_KEY && { key: env.OPENAI_COMPATIBLE_API_KEY }),
        },
      }),
    },
  };
}

export function createDefaultAdapters(
  env: Record<string, string | undefined> = process.env,
): ApplicationAdapters {
  const defaultFeedbackUrl = 'https://internal.users.n8n.cloud/webhook/nod/feedback';
  const feedbackUrl = env.NOD_FEEDBACK_URL ?? defaultFeedbackUrl;
  const feedbackEnabled = env.NOD_FEEDBACK_ENABLED !== 'false';
  if (
    feedbackEnabled &&
    feedbackUrl &&
    feedbackUrl !== defaultFeedbackUrl &&
    !env.NOD_FEEDBACK_RECEIPT_URL_PREFIX
  )
    throw new Error('Set NOD_FEEDBACK_RECEIPT_URL_PREFIX when using a custom feedback intake.');
  const bootstrap = modelEnvironment(env);
  const { provider } = bootstrap;
  const model = bootstrap.model || agentModels[provider];
  const keyStore = checkedKeyStore(
    pool,
    env.NOD_VAULT_KEY
      ? createEnvironmentKeyStore(env.NOD_VAULT_KEY)
      : desktopMode
        ? createEnvironmentKeyStore()
        : process.platform === 'darwin'
          ? createKeychainKeyStore({ canCreate: async () => !(await sealedDataExists(pool)) })
          : process.platform === 'linux'
            ? createFilesystemKeyStore({
                dataRoot,
                canCreate: async () => !(await sealedDataExists(pool)),
              })
            : createEnvironmentKeyStore(),
  );
  const models = createModelService({
    database: pool,
    ownerId,
    keyStore,
    backend: createPiModelBackend(),
    origin: publicOrigin,
    bootstrap,
    changed: refresh,
  });
  const localSpeech = createLocalSpeechProvider({ cacheDir: join(dataRoot, 'speech') });
  const voicePreferences = createPreferencesStore(pool, ownerId);
  const openAISpeech = createOpenAISpeechProvider({
    apiKey: () => models.apiKey('openai'),
    configured: () => models.hasApiKey('openai'),
    speechModel: env.TTS_MODEL,
    transcriptionModel: env.STT_MODEL,
    voice: env.TTS_VOICE,
  });
  const openRouterSpeech = createOpenRouterSpeechProvider({
    apiKey: () => models.apiKey('openrouter'),
    configured: () => models.hasApiKey('openrouter'),
  });
  const elevenLabsSpeech = createElevenLabsSpeechProvider({
    apiKey: () => models.apiKey('elevenlabs'),
    configured: () => models.hasApiKey('elevenlabs'),
  });
  const openRouterTranscription = createOpenRouterTranscriptionProvider({
    apiKey: () => models.apiKey('openrouter'),
    configured: () => models.hasApiKey('openrouter'),
    model:
      env.STT_MODEL && (env.STT_MODEL.includes('/') ? env.STT_MODEL : `openai/${env.STT_MODEL}`),
  });
  const traces = createModelTraces(
    createN8nTraces({
      url: env.NOD_TRACES_URL ?? 'https://internal.users.n8n.cloud/webhook/nod/traces',
      token: env.NOD_TRACES_TOKEN,
    }),
  );
  const modelCurator = createPiMemoryCurator({
    get provider() {
      return models.current.provider;
    },
    resolve: () => models.resolve(true),
    configured: () => models.configured,
    traces,
  });
  const selectedCurator = createPiMemoryCurator({
    get provider() {
      return models.current.provider;
    },
    resolve: async () => {
      const access = await models.resolve();
      return {
        ...access,
        effort: lightestEffort(access.definition.choice.efforts),
        ...(access.textModel
          ? {
              textModel: {
                ...access.textModel,
                effort: lightestEffort(access.textModel.definition.choice.efforts),
              },
            }
          : {}),
      };
    },
    configured: () => models.configured,
    traces,
  });
  const decisions = createDecisionModel({
    configured: () => {
      if (env.TYPESAFE_API_KEY?.trim()) return true;
      if (!models.configured) return false;
      const { connections, selection } = models.view();
      const connection = connections.find((entry) => entry.id === selection?.connectionId);
      return (
        !connection ||
        (connection.method !== 'subscription' &&
          (connection.provider === 'openai' || connection.provider === 'openrouter'))
      );
    },
    resolve: async () => {
      if (env.TYPESAFE_API_KEY?.trim())
        return { provider: 'typesafe', key: env.TYPESAFE_API_KEY.trim() };
      if (!models.configured) return;
      const access = await models.resolve();
      if (
        access.method === 'subscription' ||
        (access.provider !== 'openai' && access.provider !== 'openrouter')
      )
        return;
      const credential = await access.read();
      if (credential?.type !== 'api_key') throw new Error('The model connection is unavailable.');
      return { provider: access.provider, key: credential.key };
    },
  });
  const trustModel = z
    .enum(['selected', 'llm', 'decision'])
    .parse(env.NOD_TRUST_MODEL ?? 'selected');
  const decisionCatalog = createOpenRouterDecisionCatalog();
  const trustDecisions = createDecisionModel({
    configured: () =>
      Boolean(env.TYPESAFE_API_KEY?.trim()) ||
      models.hasApiKey('openrouter') ||
      models.hasApiKey('openai'),
    resolve: async (signal) => {
      if (env.TYPESAFE_API_KEY?.trim())
        return { provider: 'typesafe', key: env.TYPESAFE_API_KEY.trim(), model: 'jev-1.14.0' };
      let routerKey: string | undefined;
      let available: Set<string> | undefined;
      if (models.hasApiKey('openrouter')) {
        routerKey = await models.apiKey('openrouter');
        if (!routerKey) throw new Error('The trust model connection is unavailable.');
        available = await decisionCatalog(routerKey, signal);
        for (const model of ['typesafe/jev-1.14', 'perplexity/pplx-decider-v1.2'])
          if (available.has(model)) return { provider: 'openrouter', key: routerKey, model };
      }
      if (models.hasApiKey('openai')) {
        const key = await models.apiKey('openai');
        if (!key) throw new Error('The trust model connection is unavailable.');
        return { provider: 'openai', key };
      }
      if (routerKey && available?.has('openai/gpt-6-luna-decisions'))
        return { provider: 'openrouter', key: routerKey, model: 'openai/gpt-6-luna-decisions' };
    },
  });
  const integrationBrowser = createIntegrationBrowser(
    desktopMode ? undefined : { origin: publicOrigin },
  );
  const integrationProxy = createComposioProxy({
    dataRoot,
    ownerId,
    keyStore,
    checkpoint: createIntegrationIdentityCheckpoint(pool, ownerId),
    browser: integrationBrowser,
    url: !desktopMode || env.NOD_DESKTOP_USER_DATA ? env.NOD_COMPOSIO_PROXY_URL : undefined,
  });
  const integrations = createComposioProvider({ proxy: integrationProxy });
  return {
    ...(analyticsEnabled(env) ? { analytics: createPostHogAnalytics() } : {}),
    telemetry: createOtlpTelemetry(env.OTEL_EXPORTER_OTLP_ENDPOINT),
    initialize: async () => {
      await models.initialize();
      await integrationProxy.initialize();
    },
    models,
    agent: createPiAgent({
      resolve: () => models.resolve(),
      provider,
      model,
      sessionRoot: join(dataRoot, 'sessions'),
      configRoot: join(dataRoot, 'pi'),
      traces,
    }),
    computer: createContainerBrowserComputer({ dataRoot, container: env.BROWSER_CONTAINER }),
    passwordManager: createOnePassword({
      open: desktopMode ? desktopOnePassword() : forkedOnePassword(env.NOD_APP_VERSION || 'source'),
    }),
    trash: desktopMode ? desktopTrash() : undefined,
    workspace: createDockerWorkspace({
      container: env.WORKSPACE_CONTAINER || 'nod-workspace',
      workspaceRoot: join(dataRoot, 'workspaces'),
    }),
    localSpeech,
    speechInputFormat: (voice) => {
      const { connections, selection } = models.view();
      const selected = connections
        .find((connection) => connection.id === selection?.connectionId)
        ?.models.find((model) => model.id === selection?.modelId);
      return selected?.audio ||
        voice?.startsWith('local:') ||
        (!openAISpeech.configured &&
          !openRouterTranscription.configured &&
          !elevenLabsSpeech.configured)
        ? 'wav'
        : undefined;
    },
    speech: {
      ...openAISpeech,
      get defaultVoice() {
        return openRouterSpeech.configured
          ? openRouterSpeech.defaultVoice
          : openAISpeech.configured
            ? openAISpeech.defaultVoice
            : elevenLabsSpeech.configured
              ? elevenLabsSpeech.defaultVoice
              : localSpeech.defaultVoice;
      },
      get configured() {
        return (
          openRouterSpeech.configured ||
          openAISpeech.configured ||
          elevenLabsSpeech.configured ||
          localSpeech.configured
        );
      },
      get transcriptionConfigured() {
        return (
          openAISpeech.configured ||
          openRouterTranscription.configured ||
          elevenLabsSpeech.configured ||
          localSpeech.transcriptionConfigured === true
        );
      },
      get voices() {
        return [
          ...(elevenLabsSpeech.configured ? (elevenLabsSpeech.voices ?? []) : []),
          ...(openRouterSpeech.configured ? (openRouterSpeech.voices ?? []) : []),
          ...(openAISpeech.configured ? (openAISpeech.voices ?? []) : []),
          ...(localSpeech.configured ? (localSpeech.voices ?? []) : []),
        ];
      },
      refreshVoices: (signal, force) => elevenLabsSpeech.refreshVoices!(signal, force),
      synthesize: (text, signal, report, options) => {
        const selected = options?.voice?.startsWith('local:')
          ? localSpeech
          : options?.voice?.startsWith('elevenlabs-direct:')
            ? elevenLabsSpeech
            : options?.voice?.startsWith('openai:')
              ? openAISpeech
              : options?.voice
                ? openRouterSpeech
                : openRouterSpeech.configured
                  ? openRouterSpeech
                  : openAISpeech.configured
                    ? openAISpeech
                    : elevenLabsSpeech.configured
                      ? elevenLabsSpeech
                      : localSpeech;
        return selected.synthesize(text, signal, report, options);
      },
      transcribe: async (audio, signal, report) => {
        const voice = (await voicePreferences.get()).speechVoice;
        const local = voice?.startsWith('local:');
        signal?.throwIfAborted();
        return local
          ? localSpeech.transcribe!(audio, signal, report)
          : voice?.startsWith('elevenlabs-direct:')
            ? elevenLabsSpeech.transcribe!(audio, signal, report)
            : openAISpeech.configured
              ? openAISpeech.transcribe!(audio, signal, report)
              : openRouterTranscription.configured
                ? openRouterTranscription.transcribe(audio, signal, report)
                : elevenLabsSpeech.configured
                  ? elevenLabsSpeech.transcribe!(audio, signal, report)
                  : localSpeech.transcribe!(audio, signal, report);
      },
    },
    integrations,
    integrationBrowser,
    keyStore,
    memoryCurator: modelCurator,
    trustCurator: createPiMemoryCurator({
      get provider() {
        return models.current.provider;
      },
      resolve: () => models.resolveClassification(true),
      configured: () => models.hasClassificationModel(true),
    }),
    classificationCurator: createPiMemoryCurator({
      get provider() {
        return models.current.provider;
      },
      resolve: () => models.resolveClassification(),
      configured: () => models.hasClassificationModel(),
    }),
    imageCurator: createPiMemoryCurator({
      get provider() {
        return models.current.provider;
      },
      configured: () => models.hasImageModel(),
      resolve: () => models.resolveImage(),
      traces,
    }),
    onboardingCurator: selectedCurator,
    decisions,
    trustModel,
    trustDecisions,
    messagingSetup: {
      verifier: createChatSdkSetupVerifier(),
      managed: managedChannelEnvironment(env),
      create: (environment) => {
        const configured = { ...env, ...environment };
        const mode =
          environment.WHATSAPP_MODE ??
          (environment.WHATSAPP_ENABLED === 'true' && environment.WHATSAPP_ACCESS_TOKEN
            ? 'cloud'
            : configured.WHATSAPP_MODE);
        if (
          configured.WHATSAPP_ENABLED !== 'true' ||
          configured.WHATSAPP_POLICY_CONFIRMED !== 'true' ||
          (mode !== 'bot' && mode !== 'self-chat') ||
          (mode === 'bot' && !/^\d{7,15}$/.test(configured.WHATSAPP_ALLOWED_NUMBER ?? ''))
        )
          return createChatSdkTransport(pool, configured);
        return combineMessagingTransports(
          createChatSdkTransport(pool, { ...configured, WHATSAPP_ENABLED: 'false' }),
          createWhatsAppLinkedTransport({
            mode,
            allowedNumber: configured.WHATSAPP_ALLOWED_NUMBER,
            store: createChannelSessionStore({ pool, ownerId, keyStore }),
          }),
        );
      },
    },
    linkPreviews: createPublicLinkPreviewProvider(),
    onboardingEmail: createN8nOnboardingEmail({
      url:
        env.NOD_ONBOARDING_EMAIL_URL ??
        'https://internal.users.n8n.cloud/webhook/nod/onboarding-updates',
    }),
    feedback: createN8nFeedback({
      enabled: feedbackEnabled,
      url: feedbackUrl,
      token: env.NOD_FEEDBACK_TOKEN,
      receiptUrlPrefix:
        feedbackUrl === defaultFeedbackUrl ? undefined : env.NOD_FEEDBACK_RECEIPT_URL_PREFIX,
      recipient: feedbackUrl === defaultFeedbackUrl ? 'n8n' : undefined,
    }),
    traces,
    get model() {
      return models.current;
    },
  };
}

export async function createApplication(
  adapters: ApplicationAdapters,
  options: {
    workers?: boolean;
    channels?: boolean;
    heartbeat?: boolean;
    runtimeReady?: Promise<void>;
  } = {},
) {
  const diagnostics: {
    log?: Awaited<ReturnType<typeof createFeedbackLog>>;
    failure: FailureLogSink;
  } = {
    failure: (event, error, context) =>
      diagnostics.log?.record('failure', { event, error, context }, context),
  };
  try {
    return await withFailureLog(diagnostics.failure, () =>
      initializeApplication(adapters, options, diagnostics),
    );
  } catch (error) {
    await diagnostics.log?.close().catch(() => {});
    try {
      await adapters.analytics?.shutdown();
    } catch {}
    try {
      await adapters.telemetry?.shutdown();
    } catch {}
    throw error;
  }
}

async function initializeApplication(
  adapters: ApplicationAdapters,
  options: {
    workers?: boolean;
    channels?: boolean;
    heartbeat?: boolean;
    runtimeReady?: Promise<void>;
  },
  diagnostics: { log?: Awaited<ReturnType<typeof createFeedbackLog>>; failure: FailureLogSink },
) {
  const analytics = await createAnalytics({
    provider: adapters.analytics,
    environment: analyticsEnvironment(process.env),
    dataRoot,
    installationId: process.env.NOD_ANALYTICS_ID,
    appVersion: process.env.NOD_APP_VERSION,
  });
  let observeConnections: ((only?: 'apps' | 'models') => Promise<void>) | undefined;
  let observeChannels: (() => Promise<void>) | undefined;
  const feedbackActivity = createFeedbackActivity('runtime');
  const captureAnalytics: CaptureAnalytics = (event, delivery) => {
    feedbackActivity.record(event.event, 'properties' in event ? event.properties : undefined);
    const activity = parseFeedbackActivity([
      {
        source: 'runtime',
        ageMs: 0,
        event: event.event,
        properties: 'properties' in event ? event.properties : undefined,
      },
    ])[0];
    if (activity) diagnostics.log?.record('activity', activity);
    analytics.capture(ownerId, event, delivery);
    if (
      event.event === 'connection_changed' &&
      ['connected', 'disconnected'].includes(event.properties.status)
    )
      void observeConnections?.('apps');
    if (
      (event.event === 'model_connection_changed' && event.properties.status !== 'failed') ||
      (event.event === 'settings_updated' && event.properties.section === 'models')
    )
      void observeConnections?.('models');
    if (event.event === 'settings_updated' && event.properties.section === 'channels')
      void observeChannels?.();
  };
  captureAnalytics.snapshot = () => {
    const consent = analytics.consent(ownerId);
    return (event, delivery) => {
      if (
        consent.enabled &&
        !consent.signal.aborted &&
        consent.version === analytics.consent(ownerId).version
      )
        captureAnalytics(event, delivery);
    };
  };
  const analyticsConsent = () => analytics.consent(ownerId);
  const admission = createWorkAdmission();
  const consumers = createWorkConsumers();
  const closing = new AbortController();
  if (options.runtimeReady) await consumers.pause();
  const runtimeReady =
    options.runtimeReady?.then(() => {
      if (!closing.signal.aborted) return consumers.resume();
    }) ?? Promise.resolve();
  void runtimeReady.catch(() => {});
  async function prepareRuntime(signal: AbortSignal) {
    const lifetime = AbortSignal.any([signal, closing.signal]);
    lifetime.throwIfAborted();
    let aborted: () => void;
    try {
      await Promise.race([
        runtimeReady,
        new Promise<never>((_, reject) => {
          aborted = () => reject(lifetime.reason);
          lifetime.addEventListener('abort', aborted, { once: true });
        }),
      ]);
    } finally {
      lifetime.removeEventListener('abort', aborted!);
    }
  }
  const privacyNotice = await loadPrivacyNoticeFile(process.env.NOD_PRIVACY_NOTICE_FILE);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await initializeDatabase();
  await adapters.initialize?.();
  await initializeThreads();
  const artifacts = localArtifacts;
  async function sweepArtifacts() {
    try {
      const result = await artifacts.sweep();
      if (result.removed || result.orphans || result.failed)
        console.info(JSON.stringify({ event: 'artifact_cleanup', ...result }));
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      logFailure('artifact_cleanup', {
        name: 'ArtifactCleanupError',
        code: typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN',
      });
    }
  }
  await sweepArtifacts();
  const secrets = environmentSecrets(process.env);
  adapters.models?.onSecrets((values) => {
    for (const value of values) if (!secrets.includes(value)) secrets.push(value);
  });
  const memoryCurator =
    adapters.memoryCurator ?? createPiMemoryCurator({ provider: adapters.model.provider });
  const ledger = createLedger({
    pool,
    ownerId,
    analytics: captureAnalytics,
    telemetry: adapters.telemetry,
  });
  await ledger.initialize();
  const { computer, workspace } = adapters;
  const curator = ledger.curator(memoryCurator);
  const taskClassification = createTaskClassification({
    pool,
    ownerId,
    curator: adapters.classificationCurator && ledger.curator(adapters.classificationCurator),
    analytics: captureAnalytics,
    consent: analyticsConsent,
    secrets,
    signal: closing.signal,
  });
  await taskClassification.initialize();
  const onboardingCurator = adapters.onboardingCurator
    ? ledger.curator(adapters.onboardingCurator)
    : curator;
  const decisions = adapters.decisions && ledger.decisions(adapters.decisions);
  const review: ModelReview = async (instructions, input, signal, question) => {
    if (question) {
      const result = await decisions?.check({ instructions, input, question }, signal);
      if (result !== undefined) return result;
      const values = question.choices.map(({ value }) => value);
      instructions += `\nReply with only JSON with one property, ${JSON.stringify(question.name)}. Its value must be one of: ${values.map((value) => JSON.stringify(value)).join(', ')}.`;
    }
    return onboardingCurator.configured
      ? onboardingCurator.curate({ task: 'review', instructions, input }, signal)
      : undefined;
  };
  const mailCheck = createMailCheck({ curator, decisions });
  const skillLibrary = createSkillLibrary(
    fileURLToPath(new URL('../runtime/skills/', import.meta.url)),
    coreSkills,
  );
  const analyzeImages =
    adapters.imageCurator && createImageAnalysis(ledger.curator(adapters.imageCurator));
  const runtime = createAgentRuntime({
    agent: ledger.agent(adapters.agent),
    withExecution: ledger.withExecution,
    prepareMemory: (context, execution, canContinue) =>
      ledger.withExecution(execution, () => memoryRecall.prepare(context, canContinue)),
    analyzeImages:
      analyzeImages &&
      ((images, request, signal, execution) =>
        ledger.withExecution(execution, () => analyzeImages(images, request, signal))),
    skills: skillLibrary,
    computer,
    workspace,
    redactError: createErrorRedactor(secrets),
    keepWarm: async (threadId) =>
      !(await ledger.reachedLimit()) && (await activeThread(pool, ownerId)).id === threadId,
    observe: (turnId, event) => {
      const { execution, id, type, name } = event;
      diagnostics.log?.record(
        type,
        type === 'tool_start'
          ? { tool: name, input: event.input }
          : {
              tool: name,
              status: event.status,
              output: event.output,
              error: event.error,
              durationMs: event.durationMs,
            },
        {
          turnId,
          sessionId: execution?.sessionId,
          runId: execution?.runId,
          parentRunId: execution?.parentRunId,
          callId: id,
        },
      );
      if (event.type === 'tool_end') captureAnalytics(toolUsed(event));
      adapters.observe?.(turnId, event);
    },
  });
  const speechPreferences = createPreferencesStore(pool, ownerId);
  const speechProvider = ledger.speech(adapters.speech);
  const speech = createSpeech({
    ...speechProvider,
    get configured() {
      return speechProvider.configured;
    },
    get transcriptionConfigured() {
      return speechProvider.transcriptionConfigured;
    },
    get voices() {
      return speechProvider.voices;
    },
    get defaultVoice() {
      return speechProvider.defaultVoice;
    },
    async synthesize(text, signal, report, options) {
      const voice =
        options?.voice ??
        (await speechPreferences.get()).speechVoice ??
        (await automaticSpeechVoice(speechProvider, text, review, signal));
      return speechProvider.synthesize(text, signal, report, voice ? { voice } : undefined);
    },
  });
  const memoryStore = createPostgresObjectStore({ database: pool, ownerId });
  await memoryStore.initialize();
  await importMemoryFile(memoryStore, join(dataRoot, 'objects', 'memory'));
  const memory = createMemoryService({
    pool,
    ownerId,
    store: memoryStore,
    analytics: captureAnalytics,
  });
  const onboardingProfile = createOnboardingProfile({
    memory,
    profileAnalytics: analytics.personProfileAvailable
      ? {
          enabled: () => analytics.consent(ownerId).enabled,
          version: () => analytics.consent(ownerId).version,
          submit: (profile) => analytics.setOnboardingProfileAnswers(ownerId, profile),
        }
      : undefined,
    updatesEmail:
      analytics.personProfileAvailable && adapters.onboardingEmail?.configured
        ? {
            enabled: () => analytics.consent(ownerId).enabled,
            submit: async (email, profile) => {
              const consent = analytics.consent(ownerId);
              if (!consent.enabled) return false;
              const currentConsent = () => {
                const current = analytics.consent(ownerId);
                return (
                  current.enabled &&
                  !consent.signal.aborted &&
                  current.signal === consent.signal &&
                  current.version === consent.version &&
                  current.revision === consent.revision
                );
              };
              if (profile) {
                const shared = await analytics.setOnboardingProfileProperties(
                  ownerId,
                  profile,
                  consent,
                );
                if (!shared || !currentConsent()) return false;
              }
              const consentAt = new Date().toISOString();
              const saved = await analytics.setUpdatesEmail(ownerId, email, consentAt, consent);
              if (!saved || !currentConsent()) return false;
              return adapters.onboardingEmail!.submit(
                { email, ...(profile ? { profile } : {}) },
                consent.signal,
              );
            },
          }
        : undefined,
  });
  const memoryRecall = createMemoryRecall({ pool, ownerId, memory, curator });
  const writingStyle = createWritingStyleLearning({ memory, curator });
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
  const learning = createMemoryLearning({
    pool,
    ownerId,
    memory,
    curator,
    analytics: captureAnalytics,
  });
  const learnedSkills = createLearnedSkills({
    memory,
    curator,
    builtIn: [...skillLibrary.catalog.map((skill) => skill.name), ...coreSkills],
    redact: createErrorRedactor(secrets),
    analytics: captureAnalytics,
  });
  let retireScheduleConfirmations:
    | ((client: import('pg').PoolClient, id: string, waitForSend: boolean) => Promise<void>)
    | undefined;
  const personal = createPersonalService({
    analytics: captureAnalytics,
    pool,
    ownerId,
    scheduler: boss,
    enqueueTurn,
    refresh,
    retireScheduleConfirmations: (client, id, waitForSend) => {
      if (!retireScheduleConfirmations) throw new Error('Approvals are not ready.');
      return retireScheduleConfirmations(client, id, waitForSend);
    },
    memory,
    learnedSkills,
    models: adapters.models,
    consumers,
    stopConsumer: (id) => boss.offWork('scheduled-task', { id, wait: true }),
    sessionCosts: ledger.sessionCosts,
    recentTurnCost: ledger.recentTurnCost,
    watchable: async (connectionIds) => integrations.watchable(connectionIds),
    watchState: async (connectionIds) => integrations.watchState(connectionIds),
  });
  await personal.initialize({ workers: options.workers });
  const tasks = createTasks({
    pool,
    ownerId,
    analytics: captureAnalytics,
    refresh,
    clearBrowser: (id) => adapters.computer.clear(id),
  });
  await tasks.initialize();
  const activity = createActivity({ pool, ownerId });
  const observedSource = (catalog: ObservationSource[], id: string) =>
    catalog.find((source) => source.id === id) ??
    catalog.find((source) => source.id === `${connectionSources}:${id}`);
  let proactivity!: ReturnType<typeof createProactivity>;
  let privateReady = false;
  const triage = createTriage({
    analytics: captureAnalytics,
    consumers,
    signal: async (sourceId, client, summary) => {
      if (!privateReady) throw new Error('Background sources are starting.');
      const source = observedSource(await observations.sources(client), sourceId);
      if (source) await proactivity.signal(source.id, client, summary);
    },
    sweep: async () => {
      await sweepArtifacts();
      await tasks.wakeDue().catch((error) => logFailure('task_wake', error));
      await vault.forgetExpiredHolds().catch((error) => logFailure('vault_expiry', error));
    },
    due: () => proactivity.due(),
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
    local: (origin) => {
      const fetch = ownerFetch(origin);
      const check = ownerAddress(origin);
      return {
        transport: createDiscoveredTransport(fetch, async (endpoint) => {
          const { url } = await check(endpoint);
          if (url.hash || url.search) throw new Error('Use an address without a query.');
          return url.href;
        }),
        oauth: createDiscoveredOAuth(fetch, async (link) => (await check(link)).url.href),
      };
    },
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
  const previews = adapters.linkPreviews;
  const icon = previews ? cachedIcons((origin) => previews.icon(origin)) : undefined;
  const localFiles = createLocalFiles(pool, ownerId, {
    dataRoot,
    home: adapters.localFilesHome,
    trash: adapters.trash,
    available: Boolean(adapters.trash),
  });
  const integrations = await createIntegrations(pool, {
    localFiles,
    mailCheck,
    paused: async () => (await speechPreferences.get()).proactivePaused,
    analytics: captureAnalytics,
    analyticsConsent,
    admission,
    ownerId,
    provider: adapters.integrations,
    readWorkspaceFile: (turn, path, maxBytes) =>
      workspace.readArtifact(turn.threadId, path, maxBytes, 'attachment'),
    resumeConnection: resumeAfterConnection,
    writingStyle: {
      ...writingStyle,
      learn: (...args) =>
        analytics.withSystemWork(ownerId, 'writing_style', () => writingStyle.learn(...args)),
    },
    wake: triage.recordEvent,
    settle: () => proactivity.due(),
    lockActivity: (client) => lockProactivity(client, ownerId),
    removeActivity: (id, client) => proactivity.forgetSource(`connections:${id}`, client),
    refresh,
    baseUrl: publicOrigin,
    callbackReturnTo: desktopMode ? 'window' : undefined,
    discovered,
    browserAccounts: (client) => vault.list(ownerId, client),
    browserConnections: (client) => browserConnections.list(client),
    icon,
  });
  vault = await createVault(pool, {
    analytics: captureAnalytics,
    refresh,
    keyStore: adapters.keyStore,
    requestKey: Buffer.from(await credentialRequestKey(dataRoot), 'base64url'),
    resume: resumeAfterCredentials,
    retry: retryCredentials,
    inject: computer.injectCredentials,
    page: computer.currentPage,
    signInMethods: computer.signInMethods,
    selectSignInMethod: computer.selectSignInMethod,
    checkMethods: async (turn, methods) => {
      for (const { selector, page } of methods) {
        const step = { action: 'click' as const, selector };
        const verdict = await trust.check(
          turn,
          'NOD_browser',
          browserStepArgs({ step, page, typed: [], subagent: false }),
        );
        if (verdict.confirm)
          throw new Error(
            'This control needs the normal browser confirmation before it can run. Choose only sign-in methods covered by the owner’s request.',
          );
      }
    },
    emailCode: (input, signal) => integrations.emailCode(ownerId, input, signal),
    icon,
    passwordManager: adapters.passwordManager,
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
      expectTarget: _expectTarget,
      ...command
    } = step as BrowserAction;
    return {
      website: page.origin,
      page: page.url,
      ...(page.target ? { target: page.target } : {}),
      step: step.action,
      ...(page.controls?.length ? { control: page.controls } : {}),
      ...(page.submits ? { submits: page.submits } : {}),
      ...(page.dropTarget?.length ? { dropTarget: page.dropTarget } : {}),
      ...(page.dialog !== undefined ? { dialog: page.dialog } : {}),
      ...(step.action === 'upload' ? { file: basename(step.path) } : {}),
      ...(typed.length ? { typedOnPage: typed } : {}),
      command,
    };
  };
  const formSent = (value: unknown) => {
    const form = value as { method?: unknown; to?: unknown } | string | undefined;
    return typeof form === 'object' ? `${String(form.method)} ${String(form.to)}` : String(form);
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
        command.action === 'upload'
          ? { action: 'click', selector: String(command.selector) }
          : (command as BrowserAction),
      )
      .catch(() => undefined);
    if (
      current?.origin !== expectOrigin ||
      current.url !== args.page ||
      current.dialog !== args.dialog ||
      current.target !== args.target ||
      !isDeepStrictEqual(current.controls?.length ? current.controls : undefined, args.control) ||
      !isDeepStrictEqual(
        current.dropTarget?.length ? current.dropTarget : undefined,
        args.dropTarget,
      ) ||
      formSent(current.submits) !== formSent(args.submits)
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
              ...(args.target ? { expectTarget: String(args.target) } : {}),
            })
          : await computer.act(browserId, {
              ...(command as BrowserAction),
              expectOrigin,
              expectUrl: String(args.page),
              ...(args.target ? { expectTarget: String(args.target) } : {}),
            });
      return { url: page.url, page: page.text };
    } catch (error) {
      if (error instanceof BrowserActionError && error.code === 'browser_target_changed')
        throw notRun();
      throw error;
    }
  };
  const approvals = await createApprovals(
    async (action, args, provenance) => {
      if (
        action !== 'NOD_read_source' &&
        (
          await pool.query('SELECT proactive FROM turns WHERE id=$1 AND owner_id=$2', [
            provenance.turnId,
            ownerId,
          ])
        ).rows[0]?.proactive
      )
        throw Object.assign(
          new Error(
            'This background session can only read and prepare private work. Start an ordinary request to take this action.',
          ),
          { notRun: true },
        );
      const turnLock = provenance.signal
        ? { turnId: provenance.turnId, signal: provenance.signal }
        : provenance.turnId;
      const scheduleWrite = [
        'NOD_schedule_pause',
        'NOD_schedule_cancel',
        'NOD_schedule_create',
        'NOD_schedule_update',
      ].includes(action);
      const lockedWrite =
        action === 'NOD_limits_update' ||
        action === 'NOD_model_select' ||
        action.startsWith('NOD_memory_') ||
        action === 'NOD_notification_preferences_update';
      const result = await (action === 'NOD_browser'
        ? replayBrowserStep(args, provenance)
        : action === 'NOD_vault_allow'
          ? vaultAccess.allow(args)
          : action === 'NOD_limits_update'
            ? withTurnLock(turnLock, (client) => ledger.setLimits(args, 'agent', client))
            : scheduleWrite
              ? withTurnLock(turnLock, (client) =>
                  personal.manage(action.slice('NOD_'.length), args, provenance, { client }),
                )
              : lockedWrite
                ? withTurnLock(turnLock, (client) =>
                    personal.manage(action.slice('NOD_'.length), args, provenance, {
                      client,
                      ...(provenance.details?.currentRules === undefined
                        ? {}
                        : { expectedRules: String(provenance.details.currentRules) }),
                    }),
                  )
                : action.startsWith('NOD_')
                  ? personal.manage(action.slice('NOD_'.length), args, provenance)
                  : (async () => {
                      const turn = { threadId: provenance.threadId, turnId: provenance.turnId };
                      const ready = hasWorkspaceFiles(args)
                        ? await integrations
                            .prepare(ownerId, action, args, turn, provenance.signal)
                            .catch((error: unknown) => {
                              throw Object.assign(
                                error instanceof Error ? error : new Error(String(error)),
                                { notRun: true },
                              );
                            })
                        : args;
                      const result = await integrations.executeApproved(
                        ownerId,
                        action,
                        ready,
                        turn,
                        provenance.signal,
                      );
                      await ledger.action(provenance.turnId, action, { kind: 'approved' });
                      return privateEmailResult(
                        (
                          await saveIntegrationFiles(result, async (file) => {
                            const name = `${randomUUID()}-${basename(file.name)}`;
                            await workspace.writeArtifact(provenance.threadId, name, file.bytes);
                            return name;
                          })
                        ).value,
                        mailCheck,
                      );
                    })());
      return result;
    },
    async (action, args, expectedRevision, client) => {
      if (['NOD_browser', 'NOD_vault_allow'].includes(action)) return;
      if (action === 'NOD_limits_update') limitsInput.parse(args);
      else if (action.startsWith('NOD_')) {
        if (
          ['NOD_schedule_update', 'NOD_schedule_pause', 'NOD_schedule_cancel'].includes(action) &&
          expectedRevision === undefined
        )
          throw Object.assign(new Error('This schedule needs a fresh approval.'), {
            statusCode: 409,
          });
        await personal.validateReview(action.slice('NOD_'.length), args, expectedRevision, client);
      } else await integrations.prepare(ownerId, action, args, undefined, undefined, false, client);
    },
    (reply) => trust.answer(reply),
    communication.describe,
    captureAnalytics,
  );
  retireScheduleConfirmations = approvals.retireScheduleConfirmations;
  let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
  const reactions = createAgentReactionService({
    pool,
    ownerId,
    refresh,
    deliver: async (messageId, reaction, signal) =>
      channels ? channels.react(messageId, reaction, signal) : 'absent',
  });
  const localAccounts = createAccountStore(pool, { onboard: ledger.onboard });
  const ownerNames = async () =>
    (await integrations.list(ownerId, { refresh: false }))
      .filter(connectedGmail)
      .flatMap((connection) => (connection.accountName ? [connection.accountName] : []));
  await localAccounts.initialize();
  const appReads = {
    accounts: async (client?: import('pg').PoolClient) => {
      const connected = (await integrations.list(ownerId, { refresh: false, client })).filter(
        (account) =>
          account.status === 'connected' &&
          !account.savedLogin &&
          !account.disconnectPending &&
          account.connectionId,
      );
      const accounts = await Promise.all(
        connected.map(async (account) => {
          const binding = await integrations.binding(account.connectionId!, client);
          return binding
            ? {
                connectionId: account.connectionId!,
                binding,
                slug: account.slug,
                name: account.name,
                ...(account.accountEmail ? { email: account.accountEmail } : {}),
              }
            : undefined;
        }),
      );
      return accounts.filter((account) => account !== undefined);
    },
    search: async (account: AppAccount, query: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      if ((await integrations.binding(account.connectionId)) !== account.binding)
        throw new Error('This connected account changed.');
      return integrations.execute(
        ownerId,
        'SEARCH_TOOLS',
        { connectionId: account.connectionId, query },
        undefined,
        signal,
      );
    },
    read: async (
      account: AppAccount,
      tool: AppTool,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (
        (await integrations.binding(account.connectionId)) !== account.binding ||
        !(await trust.readOnly(
          tool.action,
          args,
          { description: tool.description, inputSchema: tool.schema },
          signal,
        ))
      )
        throw Object.assign(new Error('This action is not a read, so nothing ran.'), {
          refused: true,
        });
      signal.throwIfAborted();
      if ((await integrations.binding(account.connectionId)) !== account.binding)
        throw new Error('This connected account changed.');
      return integrations.execute(ownerId, tool.action, args, undefined, signal, account.binding);
    },
    current: async (accounts: AppAccount[], client?: import('pg').PoolClient) => {
      for (const account of accounts)
        if ((await integrations.binding(account.connectionId, client)) !== account.binding)
          return false;
      return true;
    },
  };
  const onboardingSuggestions = createOnboardingSuggestions({
    ownerId,
    observe: (run) => analytics.withSystemWork(ownerId, 'onboarding', run),
    curator: onboardingCurator,
    timeZone: async () => (await getPreferences()).timeZone,
    mailCheck,
    answers: async () =>
      (await memory.load()).entries
        .filter((entry) => entry.origin === 'stated' && entry.slug === 'onboarding')
        .map((entry) => entry.text),
    signal: closing.signal,
    discovery: {
      ...appReads,
      search: (account, signal) =>
        appReads.search(
          account,
          `${account.name} recent activity messages events tasks projects documents`,
          signal,
        ),
    },
    telegram: async () =>
      Boolean(
        (await channelSettings?.status())?.channels.some(
          (channel) => channel.provider === 'telegram' && channel.enabled && channel.allowedUserId,
        ),
      ),
  });
  const localConsent = await localAccounts.readConsent(ownerId);
  analytics.setUsageData(ownerId, localConsent?.enabled ?? false, localConsent?.revision);
  const ownerProfile = async () => {
    const [connections, preferences] = await Promise.all([
      integrations.list(ownerId, { refresh: false }),
      getPreferences(),
    ]);
    return {
      names: connections.flatMap((connection) =>
        connection.status === 'connected' &&
        connection.accountId &&
        connection.accountName &&
        !connection.accessPaths?.length
          ? [connection.accountName]
          : [],
      ),
      region: preferences.locale
        ? new Intl.Locale(preferences.locale).maximize().region
        : undefined,
    };
  };
  let feedbackProfileRead: ReturnType<typeof ownerProfile> | undefined;
  let feedbackRedaction:
    | {
        profile: Awaited<ReturnType<typeof ownerProfile>>;
        redact: ReturnType<typeof createFeedbackRedactor>;
      }
    | undefined;
  const feedbackSecrets = [ownerId, ...secrets];
  diagnostics.log = await createFeedbackLog({
    dataRoot,
    ownerId,
    sanitize: async (value) => {
      const profile = await (feedbackProfileRead ??= ownerProfile().finally(() => {
        feedbackProfileRead = undefined;
      }));
      for (let index = feedbackSecrets.length - 1; index < secrets.length; index++)
        feedbackSecrets.push(secrets[index]);
      if (
        !feedbackRedaction ||
        feedbackRedaction.profile.region !== profile.region ||
        feedbackRedaction.profile.names.length !== profile.names.length ||
        feedbackRedaction.profile.names.some((name, index) => name !== profile.names[index])
      )
        feedbackRedaction = {
          profile,
          redact: createFeedbackRedactor({ secrets: feedbackSecrets, profile }),
        };
      const { redact } = feedbackRedaction;
      if (!redact.isReady()) throw new Error('Diagnostic redaction unavailable.');
      return redact.value(value);
    },
  });
  adapters.traces?.configure({
    enabled: (await localAccounts.read(ownerId)).traces,
    secrets,
    profile: ownerProfile,
  });
  let pendingInventory = Promise.resolve();
  observeConnections = (only) =>
    (pendingInventory = pendingInventory
      .then(() =>
        captureConnectionInventory(
          analytics,
          ownerId,
          async () =>
            only === 'models'
              ? []
              : (
                  await Promise.all([
                    integrations.analyticsConnections(),
                    discovered.analyticsConnections(),
                    browserConnections.analyticsConnections(),
                  ])
                ).flat(),
          () => (only === 'apps' ? [] : (adapters.models?.analyticsConnections() ?? [])),
          only !== 'models',
        ),
      )
      .catch(() => {}));
  const stopConnectionInventory = analytics.subscribe(ownerId, (enabled) => {
    if (enabled) {
      void observeConnections?.();
      void observeChannels?.();
    }
  });
  void observeConnections();
  await clearConversationAnalytics(pool, ownerId);
  const accountProfile = async () =>
    runtimeAccount({
      name: null,
      givenName: null,
      email: null,
      preferredName: (await ownerNames())[0] ?? null,
    });
  async function permitVault(
    turn: TurnRef,
    target: {
      origin: string;
      kind: 'sign_in' | 'session' | 'form';
      account?: string;
      itemId?: string;
      sessionOrigin?: string;
    },
  ): Promise<{ reason: VaultActivityReason; basis?: TrustBasis } | { question: string }> {
    const access = await vaultAccess.authorize(turn, target);
    if (access.ok)
      return { reason: access.reason, ...(access.basis ? { basis: access.basis } : {}) };
    const result = await approvals.request(turn, 'NOD_vault_allow', access.args, {
      details: access.details,
    });
    if (result && typeof result === 'object' && appConfirmation in result)
      return { question: result[appConfirmation] };
    return { reason: 'allowed', basis: { kind: 'approved' } };
  }
  const trustCurator =
    (adapters.trustModel ?? 'selected') === 'selected'
      ? onboardingCurator
      : adapters.trustCurator
        ? ledger.curator(adapters.trustCurator)
        : adapters.classificationCurator
          ? ledger.curator(adapters.classificationCurator)
          : curator;
  const trust = createTrust({
    pool,
    ownerId,
    review: async (instructions, input, signal, question) => {
      if (question) {
        const values = question.choices.map(({ value }) => JSON.stringify(value)).join(', ');
        instructions +=
          question.name === 'retiredReply'
            ? `\nReply with only JSON containing exactly two properties: ${JSON.stringify(question.name)} set to one of ${values}, and "probability" set to a number from 0 to 1 expressing confidence in that label.`
            : `\nReply with only JSON with one property, ${JSON.stringify(question.name)}. Its value must be one of: ${values}.`;
      }
      return trustCurator.configured
        ? trustCurator.curate({ task: 'review', instructions, input }, signal)
        : undefined;
    },
    ...(adapters.trustModel === 'decision' && adapters.trustDecisions
      ? { decisions: ledger.decisions(adapters.trustDecisions) }
      : {}),
  });
  const observations = createObservationSources(
    [
      createConnectionSources({
        recorded: integrations.activitySources,
        readRecorded: (connectionId, input, signal) =>
          integrations.readActivity({ connectionId, ...input }, signal),
        ...appReads,
      }),
      createTaskObservations(pool, ownerId, createRedactor(secrets)),
      ...(adapters.observations ?? []),
    ],
    { secrets, check: mailCheck, analytics: captureAnalytics },
  );
  proactivity = createProactivity({
    pool,
    ownerId,
    analytics: captureAnalytics,
    redact: createTextRedactor(secrets),
    sources: (client) => observations.sources(client),
    read: async (turn, input, signal) => {
      const source = (await observations.sources()).find(
        (item) => item.id === input.sourceId && item.readable,
      );
      if (!source) throw new Error('This source has no supported activity reader.');
      const bound = { ...input, revision: source.revision };
      if (source.tools) {
        const result = await observations.read(bound, signal);
        await ledger.action(turn.turnId, 'NOD_read_source', { kind: 'read' });
        return result;
      }
      const verdict = await trust.check(
        turn,
        'NOD_read_source',
        {
          ...bound,
          source: source.label,
          description: source.description,
          operation: 'Read current records from this registered read-only source.',
        },
        signal,
      );
      if (verdict.confirm)
        throw Object.assign(
          new Error(
            verdict.reason === 'rule'
              ? "The owner's rules ask before reading this source, so private preparation skips it."
              : 'The trust check did not allow this read. Private preparation will try again later.',
          ),
          { blocked: verdict.reason === 'rule' },
        );
      const result = await observations.read(bound, signal);
      await ledger.action(turn.turnId, 'NOD_read_source', verdict.basis);
      return result;
    },
    curator,
  });
  await proactivity.initialize();
  privateReady = true;
  vaultAccess = await createVaultAccess(pool, {
    ownerId,
    check: trust.check,
    refresh,
  });
  payments = await createPayments(pool, {
    ownerId,
    analytics: captureAnalytics,
    present: (turn, input) => communication.present(turn.threadId, input),
    uses: vault.uses,
    page: (threadId) => computer.currentPage(threadId),
    destinations: (threadId, fields) => computer.cardDestinations(threadId, fields),
    capture: (threadId) => computer.checkoutImage(threadId),
    cards: () => vault.paymentCards(),
    card: (id, version, client) => vault.paymentCard(id, version, client),
    fill: (input) => computer.fillCard(input),
    resume: resumeAfterPayment,
    record: (turn, entry, client) => vaultAccess.record(turn, entry, client),
  });
  const ownerMessageAccepted = () => {
    const capture = snapshotAnalytics(captureAnalytics);
    return (channel: string) => {
      const source = channel.split(':')[0];
      capture?.({
        event: 'owner_message_accepted',
        properties: {
          channel:
            source === 'web' || source === 'telegram' || source === 'whatsapp' ? source : 'other',
        },
      });
    };
  };
  const submittedMessages = createUserMessageService({
    confirmAction: approvals.chat,
    taskReply: tasks.resolveReply,
    accepted: ownerMessageAccepted,
  });
  const userMessages = {
    ...submittedMessages,
    submit: (...args: Parameters<typeof submittedMessages.submit>) => {
      onboardingSuggestions.cancel();
      return submittedMessages.submit(...args);
    },
  };
  if (options.workers !== false) {
    if (options.heartbeat !== false) await triage.initializeHeartbeat();
    await initializeMemoryLearning({
      boss,
      consumers,
      run: () => analytics.withSystemWork(ownerId, 'memory_learning', learning.run),
    });
    await startThreadWorkers({
      present: communication.present,
      taskChecks: tasks.resumeDue,
      analytics: captureAnalytics,
      currentModel: () => adapters.model,
      taskClassification: true,
      observeTurn: (turnId, operation) =>
        analytics
          .withRun(ownerId, async () => {
            try {
              await operation();
            } finally {
              const consent = analytics.currentRun(ownerId)?.consent;
              void admission
                .run(() => ledger.withTurn(turnId, () => taskClassification.run(turnId, consent)))
                ?.catch(() => {});
            }
          })
          .finally(() => {
            void admission
              .run(() => proactivity.due())
              ?.catch((error) => logFailure('proactivity_wake', error));
          }),
      consumers,
      artifacts,
      writeArtifact: workspace.writeArtifact.bind(workspace),
      readArtifact: workspace.readArtifact.bind(workspace),
      mailCheck,
      executeConfirmation: approvals.executeConfirmed,
      stoppedOutcomes: approvals.stoppedOutcomes,
      bindVerificationQuestion: chatVerification.bindQuestion,
      reactToMessage: reactions.react,
      proactivity: proactivity.context,
      runTurn: (context) =>
        ledger.withTurn(
          context.turnId,
          () => runtime.runTurn(context).finally(() => proactivity.release(context.turnId)),
          Boolean(context.spendingLimitReached),
        ),
      spendingLimit: ledger.reachedLimit,
      checkIn: ledger.checkIn,
      skipTurn: async (sourceId) =>
        sourceId.startsWith('proactivity:') && !(await proactivity.canRun()),
      accountProfile,
      connectedApps: integrations.connectedApps,
      mcpServers: discovered.servers,
      memoryContext: memory.context,
      recall: personal.recall,
      learnedSkills: learnedSkills.index,
      taskContext: tasks.context,
      settleTask: tasks.settle,
      taskLedger: tasks.read,
      task: tasks.execute,
      startTurn: tasks.inherit,
      connections: async (...args) => {
        const result = await integrations.manageConnections(...args);
        if (!('url' in result) || !('name' in result) || typeof result.name !== 'string')
          return result;
        const turn = args[2];
        try {
          if (!turn) throw new Error('The connection needs an active conversation.');
          const message = await communication.present(turn.threadId, {
            kind: 'connection',
            app: result.name,
            operation: 'operation' in result ? result.operation : 'connect',
            ...('account' in result ? { account: result.account } : {}),
            next: 'complete_private_sign_in',
          });
          return { ...result, message };
        } catch (error) {
          await integrations
            .abandonSetup(
              createHash('sha256').update(new URL(result.url).href).digest('hex'),
              'unknown',
            )
            .catch((cleanup) => logFailure('connection_abandon', cleanup));
          throw error;
        }
      },
      browserStep: async (turn, request, signal) => {
        const args = browserStepArgs(request);
        const verdict = await trust.check(turn, 'NOD_browser', args, signal);
        if (!verdict.confirm) return 'run';
        if (
          request.step.action === 'click' &&
          request.step.x !== undefined &&
          !request.page.controls?.some(
            ({ role, name }) => name && !['RootWebArea', 'WebArea', 'document'].includes(role),
          )
        )
          throw new Error(
            'The click target is not identified. Inspect a fresh snapshot or screenshot and choose the actual control. Do not ask the owner to approve an unidentified click.',
          );
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
        const result = await approvals.request(turn, 'NOD_browser', args, {
          signal,
          details: {
            reason: verdict.reason,
            ...(typeof visible === 'string' && visible.trim()
              ? { pageText: publicText(visible.slice(0, 20_000)) }
              : {}),
          },
        });
        return result && typeof result === 'object' && appConfirmation in result
          ? result
          : { result };
      },
      browserConnection: async (request, turn, signal, launch) => {
        const target = await browserConnections.target(request);
        if (!target)
          return browserConnections.request(request, turn, signal, launch).catch(async (error) => {
            if (
              error instanceof BrowserConnectionError &&
              error.statusCode === 404 &&
              (await vault.list(ownerId)).some((entry) => entry.id === request.connectionId)
            )
              throw new Error(
                'This ID is a saved Vault login, not a browser profile. Open the sign-in page with browser, then use sign_in with savedLoginId set to this ID.',
              );
            throw error;
          });
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
            ...(access.basis ? { basis: access.basis } : {}),
          });
        return result;
      },
      speech,
      audioReplies: async () => (await speechPreferences.get()).speechReply,
      manage: async (turn, action, args, { admit, ...provenance }) => {
        if (action === 'prepared_list')
          return untrustedBlock('prepared work', JSON.stringify(await proactivity.prepared(args)));
        if (action === 'prepared_update') {
          const { id, state, snoozedUntil, feedback } = await proactivity.control(args, turn);
          return { id, state, snoozedUntil, feedback };
        }
        if (action === 'limits_update') {
          const input = limitsInput.parse(args);
          const verdict = await trust.check(turn, 'NOD_limits_update', input);
          return approvals.request(turn, 'NOD_limits_update', input, {
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
            'model_select',
            'schedule_create',
            'schedule_update',
            'schedule_pause',
          ].includes(action)
        ) {
          if (
            action === 'schedule_create' &&
            (await turnOrigin(turn.turnId))?.source === 'schedule'
          )
            throw new Error(
              'A scheduled run cannot create schedules. Do the work this schedule asks for in this run instead.',
            );
          const input = await personal.validateReview(action, args);
          const schedule =
            action === 'schedule_pause' || action === 'schedule_update'
              ? await personal.getSchedule(String(input.id))
              : undefined;
          if (action === 'schedule_pause' && schedule && !schedule.enabled) return schedule;
          const current = schedule
            ? {
                title: schedule.title,
                prompt: schedule.prompt,
                cron: schedule.cron,
                runAt: schedule.runAt,
                timeZone: schedule.timeZone,
              }
            : undefined;
          const preferences =
            action === 'notification_preferences_update'
              ? await triage.getPreferences()
              : undefined;
          const rule = 'notificationRule' in input ? preferences?.notificationRule : undefined;
          const rules = 'rules' in input ? preferences?.rules : undefined;
          const connection =
            action === 'model_select'
              ? adapters.models?.view().connections.find((item) => item.id === input.connectionId)
              : undefined;
          const targetModel = connection
            ? {
                service: modelSource(connection),
                account: connection.label,
                model: connection.models.find((item) => item.id === input.modelId)!.name,
              }
            : undefined;
          const verdict = await trust.check(turn, `NOD_${action}`, {
            ...input,
            ...(targetModel ? { targetModel } : {}),
            ...(current ? { currentSchedule: current } : {}),
            ...(rule === undefined ? {} : { currentNotificationRule: rule }),
            ...(rules === undefined ? {} : { currentRules: rules }),
          });
          return approvals.request(turn, `NOD_${action}`, input, {
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
              ...(targetModel ? { targetModel } : {}),
              ...(verdict.confirm ? { reason: verdict.reason } : {}),
              ...(current ? { schedule: current } : {}),
              ...(rule === undefined ? {} : { currentNotificationRule: rule }),
              ...(rules === undefined ? {} : { currentRules: rules }),
            },
          });
        }
        if (action === 'memory_forget' || action === 'memory_control') {
          const origin = await turnOrigin(turn.turnId);
          const input = await personal.reviewMemory(action, args, {
            ...provenance,
            turnId: turn.turnId,
            ownerRooted: origin?.source === 'user',
          });
          const verdict = await trust.check(turn, `NOD_${action}`, input);
          return approvals.request(turn, `NOD_${action}`, input, {
            ...provenance,
            allowed: !verdict.confirm,
            admit,
            details: verdict.confirm ? { reason: verdict.reason } : {},
          });
        }
        if (action === 'skill_read') return learnedSkills.read(String(args.name));
        if (action === 'skill_save' || action === 'skill_patch') {
          const origin = await turnOrigin(turn.turnId);
          if (!origin || !['user', 'schedule', 'task'].includes(origin.source))
            throw new Error(
              'Only work the owner started, in chat, a task or a schedule, can save a skill.',
            );
          await admit?.(false);
          return learnedSkills.learn(args, turn.turnId, (write) =>
            withTurnLock(turn.turnId, write),
          );
        }
        await admit?.(false);
        if (action === 'memory_learn') {
          const origin = await turnOrigin(turn.turnId);
          if (!origin || !['user', 'task'].includes(origin.source))
            throw new Error('Only work the owner started, in chat or a task, can save to memory.');
          return learning.remember(args, provenance.sourceMessageId, (write) =>
            withTurnLock(turn.turnId, write),
          );
        }
        if (action === 'usage_get') return ledger.read();
        return personal.manage(action, args, { ...provenance, turnId: turn.turnId });
      },
      requestPayment: async (turn, input, show) => {
        const { image, ...result } = await payments.request(turn, input);
        await show(image);
        return result;
      },
      requestCredential: async (turn, input) => {
        if (input.kind === 'method') {
          const origin = credentialOrigin(input.origin);
          const access = await permitVault(turn, { origin, kind: 'sign_in' });
          if ('question' in access) return { [appConfirmation]: access.question };
          return vault.request(turn, ownerId, {
            origin,
            label: input.label,
            kind: 'method',
            methods: input.methods,
          });
        }
        const { savedLoginId, ...request } = input;
        const origin = credentialOrigin(request.origin);
        if (request.kind === 'otp' && !request.emailCode) {
          const login = await vault.authenticatorLogin(turn, ownerId, origin, savedLoginId);
          if (login) {
            const access = await permitVault(turn, {
              origin,
              kind: 'sign_in',
              itemId: login.id,
              account: [login.label, login.usernameHint].filter(Boolean).join(' · '),
            });
            if ('question' in access) return { [appConfirmation]: access.question };
            if (await vault.fillAuthenticatorCode(turn, ownerId, login.id, request)) {
              await vaultAccess.record(turn, {
                action: 'code',
                origin,
                reason: access.reason,
                itemId: login.id,
                itemKind: 'login',
                ...(access.basis ? { basis: access.basis } : {}),
              });
              return { filled: true as const };
            }
          }
        }
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
                account: [chosen.label, chosen.usernameHint].filter(Boolean).join(' · '),
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
            ...(access.basis ? { basis: access.basis } : {}),
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
      localFiles: localFiles.available,
      integration: async (turn, action, args, options) => {
        if (action === 'LOCAL_FILES_KEEP_OUT') {
          await options.admit?.(false);
          return withTurnLock({ turnId: turn.turnId, signal: options.signal }, async (client) => ({
            keptOut: await localFiles.keepOut(turn, String(args.path ?? ''), client),
          }));
        }
        if (action === 'SEARCH_TOOLS') {
          await options.admit?.(false);
          const result = await integrations.execute(ownerId, action, args, turn, options.signal);
          return result;
        }
        const prepare = () =>
          hasWorkspaceFiles(args)
            ? withTurnLock(turn.turnId, (client) =>
                integrations.prepare(ownerId, action, args, turn, options.signal, true, client),
              )
            : isLocalFilesAction(action)
              ? integrations.prepare(ownerId, action, args, turn, options.signal)
              : integrations.prepare(ownerId, action, args);
        const resolved = isLocalFilesAction(action) ? await prepare() : undefined;
        const verdict = await trust.check(turn, action, resolved ?? args, options.signal);
        await options.admit?.(verdict.confirm);
        const prepared = resolved ?? (await prepare());
        const account =
          verdict.confirm && typeof prepared.connectionId === 'string'
            ? (await integrations.list(ownerId, { refresh: false })).find(
                (item) => item.connectionId === prepared.connectionId,
              )
            : undefined;
        const path = account?.accessPaths?.find((item) => item.id === prepared.pathId);
        const result = await approvals.request(turn, action, prepared, {
          allowed: !verdict.confirm,
          signal: options.signal,
          run: async () => {
            const result = await integrations.execute(
              ownerId,
              action,
              prepared,
              turn,
              options.signal,
            );
            await ledger.action(
              turn.turnId,
              action,
              verdict.confirm ? { kind: 'approved' } : verdict.basis,
            );
            return result;
          },
          details: {
            ...(verdict.confirm ? { reason: verdict.reason } : {}),
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
        return result;
      },
    });
  }
  const welcome = async () => {
    if (adapters.model.configured) {
      void admission.run(integrations.resumeWritingStyle)?.catch(() => {});
      await onboardingSuggestions.complete((await ownerNames().catch(() => []))[0]);
    }
  };
  const app = await createApp({
    failureLog: diagnostics.failure,
    analytics: captureAnalytics,
    admission,
    artifacts,
    submitMessage: userMessages.submit,
    speech,
    attributeAudioUsage: ledger.attributeMediaUsage,
    verification: chatVerification,
    taskLedger: tasks.read,
    activity: activity.current,
    planningTasks: onboardingSuggestions.planning,
    computer,
    configuration: () =>
      configuration({
        provider: adapters.model.provider,
        model: adapters.model.name,
        llmReady: adapters.model.configured,
        modelReconnect: adapters.model.reconnect === true,
        integrationsReady: adapters.integrations.configured,
      }),
  });
  adapters.models?.register(app, captureAnalytics);
  proactivity.registerRoutes(app);

  app.addHook('preClose', async () => {
    await adapters.models?.close();
  });
  const feedbackReportOptions: FeedbackReportOptions = {
    pool,
    ownerId,
    secrets,
    profile: ownerProfile,
    logs: () => diagnostics.log!.snapshot(),
    context: await feedbackContext({ environment: process.env }),
    get provider() {
      return adapters.model.provider;
    },
    get model() {
      return adapters.model.name;
    },
  };
  await registerFeedback(app, {
    pool,
    ownerId,
    context: feedbackReportOptions.context!,
    delivery: adapters.feedback ?? {
      configured: false,
      recipient: null,
      submit: async (input) => ({ submissionId: input.submissionId, status: 'rejected' }),
      status: async (submissionId) => ({ submissionId, status: 'rejected' }),
    },
    buildReport: (activity, errors, errorsAvailable) =>
      buildFeedbackReport({
        ...feedbackReportOptions,
        errors,
        errorsAvailable,
        activity: [...feedbackActivity.snapshot(), ...activity].sort((a, b) => b.ageMs - a.ageMs),
      }),
    analytics: captureAnalytics,
  });
  registerPrivacyNotice(app, privacyNotice);
  createAccountSession({
    analytics,
    model: () => adapters.model,
    accounts: localAccounts,
    origin: publicOrigin,
    localUser: { id: ownerId, name: 'You', email: null, avatarUrl: null },
    developerIds: desktopMode ? new Set() : new Set([ownerId]),
    start: welcome,
    prepare: prepareRuntime,
    onboardingMissing: async () => (adapters.model.configured ? null : 'brain'),
    traces: adapters.traces?.available ?? false,
    onTraces: (enabled) => adapters.traces?.configure({ enabled }),
    updatesEmail: onboardingProfile.available,
  }).register(app);
  ledger.registerRoutes(app);
  registerSpeechSettings(app, {
    speech,
    preferences: speechPreferences,
    local: adapters.localSpeech,
    inputFormat: adapters.speechInputFormat,
  });
  registerLinkOpened(app);
  vault.registerRoutes(app);
  payments.registerRoutes(app);
  vaultAccess.registerRoutes(app);
  browserConnections.registerRoutes(app);
  adapters.integrationBrowser?.registerRoutes(app);
  integrations.registerRoutes(app);
  localFiles.registerRoutes(app);
  personal.registerRoutes(app);
  onboardingSuggestions.registerRoutes(app);
  onboardingProfile.registerRoutes(app);
  tasks.registerRoutes(app);
  triage.registerRoutes(app);
  let channelSettings: Awaited<ReturnType<typeof createChannelSettings>> | undefined;
  let lastChannelObservation: { consentVersion: number; signature: string } | undefined;
  if (options.channels !== false && (adapters.messaging || adapters.messagingSetup)) {
    const setup = adapters.messagingSetup;
    if (setup) {
      channelSettings = await createChannelSettings(pool, {
        ownerId,
        keyStore: adapters.keyStore,
        verifier: setup.verifier,
        managed: setup.managed,
        linkStatus: async () => {
          if (!channels) throw new Error('Messaging is not ready.');
          return channels.pairing();
        },
        unlink: async () => {
          await channels?.unlink();
        },
        cancelPairing: async (pairingId, restart) =>
          (await channels?.cancelPairing(pairingId, restart)) ?? false,
        apply: async (environment) => {
          if (!channels) throw new Error('Messaging is not ready.');
          await channels.replaceTransport(setup.create(environment));
        },
        paired: async (candidate, client) => {
          if (!channels) throw new Error('Messaging is not ready.');
          return channels.announcePairing(candidate, client);
        },
        observed: () => {
          const consent = analytics.consent(ownerId);
          return (states) => {
            if (
              !consent.enabled ||
              consent.signal.aborted ||
              consent.version !== analytics.consent(ownerId).version
            )
              return;
            const signature = JSON.stringify(states);
            if (
              lastChannelObservation?.consentVersion === consent.version &&
              lastChannelObservation.signature === signature
            )
              return;
            for (const properties of states)
              captureAnalytics(
                { event: 'channel_connection_observed', properties },
                { consentRevision: consent.revision },
              );
            lastChannelObservation = { consentVersion: consent.version, signature };
          };
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
      resolveAttachments: artifacts.readThreadArtifacts,
      media: createChannelMedia({ artifacts, speech }),
      modelConfigured: () => adapters.model.configured,
      verificationPending: async (channel) => (await chatVerification.pending(channel)).length > 0,
      attributeMediaUsage: ledger.attributeMediaUsage,
      ...(channelSettings ? { pair: channelSettings.pair } : {}),
      transport: messaging,
      isRetirableScheduleConfirmation: approvals.isRetirableScheduleConfirmation,
      classifyRetiredReply: trust.classifyRetiredReply,
      acceptVerification: (text, input) => chatVerification.accept(text, input),
      reacted: (messageId, reaction) =>
        reactToAssistantMessage(messageId, reaction, adapters.model.configured),
      activeThread: (client) => lockThread(client),
      activity: activity.read,
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
      submit: async (
        text,
        sourceId,
        client,
        channel,
        messageId,
        answer,
        replyToMessageId,
        attachments,
        onInserted,
        stopSignal,
      ) =>
        (
          await userMessages.submit(text, attachments, {
            sourceId,
            channel,
            client,
            clientMessageId: messageId,
            replyToMessageId,
            answer,
            onInserted,
            stopSignal,
          })
        ).turnId,
      stopSignal,
      messageAccepted: ownerMessageAccepted,
      answer: (text, channel, replyToMessageId) =>
        userMessages.answer(text, { channel, replyToMessageId }),
    });
    channels.registerRoutes(app);
    await channelSettings?.recover();
    if (channelSettings) {
      const settings = channelSettings;
      observeChannels = async () => {
        await settings.status().catch(() => {});
      };
      void observeChannels();
    }
  }
  await onboardingSuggestions.initialize();
  if (adapters.model.configured)
    void admission.run(integrations.resumeWritingStyle)?.catch(() => {});
  let closingConsumers: Promise<void> | undefined;
  app.addHook('preClose', async () => {
    closing.abort();
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
  app.addHook('onReady', async () => activity.start());
  app.addHook('onClose', async () => {
    stopConnectionInventory();
    const failures: unknown[] = [];
    for (const close of [
      () => adapters.integrationBrowser?.close(),
      () => adapters.passwordManager?.close(),
      () => adapters.localSpeech?.close(),
      () => channels?.close(),
      () => activity.close(),
      () => stopThreadWorkers(),
      finishWork,
      () => runtime.dispose(),
      () => ledger.flush(),
      () => artifacts.close(),
      () => analytics.shutdown(),
      () => adapters.telemetry?.shutdown(),
      () => diagnostics.log?.close(),
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
    proactivity,
    integrations,
    vault,
    channels,
    channelSettings,
  };
}

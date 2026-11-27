import { transaction } from './transaction.ts';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isEnterKey } from '../shared/browser-keys.ts';
import { z } from 'zod';
import {
  appConfirmation,
  ContextLimitError,
  ModelRequestError,
  OutputLimitError,
  type Agent,
  type BrowserStep,
  type RuntimeObservation,
} from '../ports/agent.ts';
import {
  apiKeyConnectionProviders,
  checkEffort,
  modelProviderInfo,
  modelProviderNames,
  modelProviders,
  modelSource,
  canReuseWorkCost,
  repriceUsd,
  type ModelIssue,
  type ModelSelection,
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
import { localeRegion, timeZoneRegion } from '../shared/date-locale.ts';
import type { ObservationProvider, ObservationSource } from '../ports/proactivity.ts';
import type { IntegrationProvider } from '../ports/integrations.ts';
import { hasWorkspaceFiles, saveIntegrationFiles } from './integration-files.ts';
import { privateEmailResult } from './integration-result.ts';
import { createMailCheck } from './mail-check.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { PasswordManager } from '../ports/password-manager.ts';
import type { Trash } from '../ports/trash.ts';
import type { DesktopControl } from '../ports/desktop.ts';
import { desktopTrash } from '../providers/trash.ts';
import { desktopControl } from '../providers/desktop.ts';
import type { KeepAwake } from '../ports/keep-awake.ts';
import { desktopKeepAwake } from '../providers/keep-awake.ts';
import type { MemoryCurator } from '../ports/memory-curator.ts';
import type { DecisionModel, ModelReview } from '../ports/decisions.ts';
import { createDecisionModel, createOpenRouterDecisionCatalog } from '../providers/decisions.ts';
import type { SpeechProvider, LocalSpeechControls } from '../ports/speech.ts';
import { createLocalSpeechProvider } from '../providers/local-speech/index.ts';
import { createCompatibleTranscriptionProvider } from '../providers/compatible/speech.ts';
import type { MessagingTransport } from '../ports/messaging.ts';
import type { ChannelSetupVerifier } from '../ports/channel-settings.ts';
import type { LinkPreviewProvider } from '../ports/link-preview.ts';
import type { FeedbackDelivery } from '../ports/feedback.ts';
import { createFeedbackDelivery } from './feedback-delivery.ts';
import { createN8nTraces } from '../providers/n8n/traces.ts';
import { createOtlpTelemetry } from '../providers/otlp/telemetry.ts';
import type { UsageTelemetry } from '../ports/provider-usage.ts';
import { agentModels, defaultEffort, defaultModel } from '../shared/model-defaults.ts';
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
  publicHttps,
  safeRemoteFetch,
} from '../providers/discovered/remote.ts';
import { createDiscoveredOAuth } from '../providers/discovered/oauth.ts';
import { createDiscoveredConnections } from './discovered-connections.ts';
import { bundledApps } from './app-catalog.ts';
import { createLocalFiles, isLocalFilesAction } from './local-files.ts';
import { createComputerUse, isComputerAction } from './computer-use.ts';
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
import { createPreferencesStore, isQuietTime } from './preferences.ts';
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
import { createGoogleFlights } from '../providers/google-flights.ts';
import type { FlightSearch } from '../ports/flights.ts';
import { createAgentRuntime } from '../runtime/index.ts';
import { coreSkills } from '../runtime/prompt.ts';
import { createApp } from './app.ts';
import { credentialRequestKey, traceKey } from './access.ts';
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
import {
  validateInstructionRevision,
  validateScheduledInstructions,
  type InstructionRevision,
} from './owner-instructions.ts';
import { localArtifacts } from './artifacts.ts';
import { memoryFileName, memoryMarkdown } from '../shared/memory-export.ts';
import { createChannels } from './channels.ts';
import { createChannelSettings, managedChannelEnvironment } from './channel-settings.ts';
import { createChannelMedia } from './channel-media.ts';
import { createChannelSessionStore } from './channel-session.ts';
import {
  configuration,
  dataRoot,
  desktopMode,
  developmentMode,
  ownerId,
  publicOrigin,
} from './config.ts';
import { createAccountStore } from './account-store.ts';
import { createModelTraces, type ModelTraceGate } from './traces.ts';
import { createTurnTraces } from './turn-traces.ts';
import { runtimeAccount } from './account-profile.ts';
import { createAccountSession } from './account.ts';
import { connectedGmail } from '../shared/onboarding.ts';
import { createPostgresObjectStore } from './object-storage.ts';
import { loadPrivacyNoticeFile, registerPrivacyNotice } from './privacy.ts';
import { createDocumentation } from './documentation.ts';
import { initializeDatabase, pool } from './db.ts';
import { events, refresh } from './events.ts';
import { createIntegrations } from './integrations.ts';
import {
  calendarEventTarget,
  gmailDraftTarget,
  gmailMessageTarget,
  isCalendarEventChange,
} from './action-presentation.ts';
import {
  createErrorRedactor,
  createCommandRedactor,
  createRedactor,
  createTextRedactor,
  environmentSecrets,
} from './redaction.ts';
import { createLedger, limitsInput, spendingLimitReached } from './ledger.ts';
import { createActivityLog } from './activity-log.ts';
import { actionTarget, objectIds, recordedTitle } from './action-presentation.ts';
import { usageFileName, usagePdf } from './usage-report.ts';
import { buildFeedbackReport, type FeedbackReportOptions } from './bug-report.ts';
import { registerFeedback } from './feedback.ts';
import { feedbackContext } from './feedback-context.ts';
import { createPersonalService } from './personal.ts';
import { createOnboardingSuggestions } from './onboarding-suggestions.ts';
import { createOnboardingProfile } from './onboarding-profile.ts';
import { createMemoryLearning, initializeMemoryLearning } from './memory-learning.ts';
import { createProcedureCurator } from './procedure-curator.ts';
import { createScheduleIdeas } from './schedule-ideas.ts';
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
  insertBugReportDraft,
  lockThread,
  reactToAssistantMessage,
  resumeAfterConnection,
  resumeAfterCredentials,
  resumeAfterPayment,
  retryCredentials,
  startThreadWorkers,
  stopSignal,
  stopThreadWorkers,
  sweepExpiredTurns,
  withTurnLock,
  workOrigin,
  type TurnRef,
} from './thread.ts';
import type { VaultActivityReason } from '../shared/contracts.ts';
import { createTriage, getPreferences } from './triage.ts';
import { createTasks } from './tasks.ts';
import { createActivity, createActivityLine } from './activity.ts';
import {
  checkedKeyStore,
  createVault,
  credentialOrigin,
  credentialOrigins,
  sealedDataExists,
} from './vault.ts';
import { createVaultAccess } from './vault-access.ts';
import { createPayments } from './payments.ts';
import { cachedIcons, registerLinkOpened } from './link-previews.ts';
import { appPages } from '../shared/app-links.ts';
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
  desktop?: DesktopControl;
  keepAwake?: KeepAwake;
  localFilesHome?: string;
  memoryCurator?: MemoryCurator;
  recallCurator?: MemoryCurator;
  classificationCurator?: MemoryCurator;
  imageCurator?: MemoryCurator;
  onboardingCurator?: MemoryCurator;
  decisions?: DecisionModel;
  trustModel?: 'selected' | 'llm' | 'decision';
  trustDecisions?: DecisionModel;
  trustCurator?: MemoryCurator;
  messaging?: MessagingTransport;
  linkPreviews?: LinkPreviewProvider;
  flights?: FlightSearch;
  feedback?: FeedbackDelivery;
  traces?: ModelTraceGate;
  telemetry?: UsageTelemetry;
  messagingSetup?: {
    verifier: ChannelSetupVerifier;
    managed?: ReturnType<typeof managedChannelEnvironment>;
    create(environment: Record<string, string>): MessagingTransport;
  };
  model: {
    provider: string;
    name: string;
    configured: boolean;
    reconnect?: boolean;
    issue?: ModelIssue;
  };
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
                  region: id === 'openai' ? env.OPENAI_API_REGION : env.AWS_REGION,
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
  computer?: { ready(signal?: AbortSignal): Promise<void>; available(): boolean },
): ApplicationAdapters {
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
    connection: () => models.apiCredential('openai'),
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
  const compatibleTranscription = createCompatibleTranscriptionProvider({
    connection: () => models.transcriptionServer(),
    configured: () => models.hasTranscriptionServer(),
  });
  const traces = createModelTraces(
    createN8nTraces({
      url: env.NOD_TRACES_URL ?? 'https://internal.users.n8n.cloud/webhook/nod/traces',
      token: env.NOD_TRACES_TOKEN,
    }),
    env.NOD_APP_VERSION,
  );
  const captureOnly = {
    active: () => false,
    record: () => {},
    capturing: () => traces.capturing(),
    capture: (...args: Parameters<typeof traces.capture>) => traces.capture(...args),
  };
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
        effort: checkEffort(access.definition.choice.efforts),
        ...(access.textModel
          ? {
              textModel: {
                ...access.textModel,
                effort: checkEffort(access.textModel.definition.choice.efforts),
              },
            }
          : {}),
      };
    },
    configured: () => models.configured,
    traces,
  });
  const decisions = createDecisionModel({
    reserve: (maximumUsd) => models.reserve(maximumUsd),
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
      return { provider: access.provider, key: credential.key, region: credential.region };
    },
  });
  const trustModel = z
    .enum(['selected', 'llm', 'decision'])
    .parse(env.NOD_TRUST_MODEL ?? 'selected');
  const decisionCatalog = createOpenRouterDecisionCatalog();
  const trustDecisions = createDecisionModel({
    reserve: (maximumUsd) => models.reserve(maximumUsd),
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
        const credential = await models.apiCredential('openai');
        if (!credential) throw new Error('The trust model connection is unavailable.');
        return { provider: 'openai', key: credential.key, region: credential.region };
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
      resolve: (choice) => models.candidates(choice),
      provider,
      model,
      sessionRoot: join(dataRoot, 'sessions'),
      configRoot: join(dataRoot, 'pi'),
      traces,
    }),
    computer: createContainerBrowserComputer({
      dataRoot,
      container: env.BROWSER_CONTAINER,
      ready: computer?.ready,
    }),
    passwordManager: createOnePassword({
      open: desktopMode ? desktopOnePassword() : forkedOnePassword(env.NOD_APP_VERSION || 'source'),
    }),
    trash: desktopMode ? desktopTrash() : undefined,
    desktop: desktopMode ? desktopControl() : undefined,
    keepAwake: desktopMode ? desktopKeepAwake() : undefined,
    workspace: createDockerWorkspace({
      container: env.WORKSPACE_CONTAINER || 'nod-workspace',
      workspaceRoot: join(dataRoot, 'workspaces'),
      ready: computer?.ready,
      available: computer?.available,
    }),
    localSpeech,
    speechInputFormat: (voice) => {
      const { connections, selection } = models.view();
      const selected = connections
        .find((connection) => connection.id === selection?.connectionId)
        ?.models.find((model) => model.id === selection?.modelId);
      return selected?.audio ||
        (!compatibleTranscription.configured &&
          (voice?.startsWith('local:') ||
            (!openAISpeech.configured &&
              !openRouterTranscription.configured &&
              !elevenLabsSpeech.configured)))
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
          compatibleTranscription.configured ||
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
        if (compatibleTranscription.configured)
          return compatibleTranscription.transcribe(audio, signal, report);
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
    recallCurator: createPiMemoryCurator({
      get provider() {
        return models.current.provider;
      },
      resolve: () => models.candidates(undefined, true),
      configured: () => models.configured,
      traces,
    }),
    trustCurator: createPiMemoryCurator({
      get provider() {
        return models.current.provider;
      },
      resolve: () => models.resolveClassification(true),
      configured: () => models.hasClassificationModel(true),
      traces: captureOnly,
    }),
    classificationCurator: createPiMemoryCurator({
      get provider() {
        return models.current.provider;
      },
      resolve: () => models.resolveClassification(),
      configured: () => models.hasClassificationModel(),
      traces: captureOnly,
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
          !['linked', 'bot', 'self-chat'].includes(mode ?? '')
        )
          return createChatSdkTransport(pool, configured);
        return combineMessagingTransports(
          createChatSdkTransport(pool, { ...configured, WHATSAPP_ENABLED: 'false' }),
          createWhatsAppLinkedTransport({
            allowedNumber: configured.WHATSAPP_ALLOWED_NUMBER || undefined,
            allowedLid: configured.WHATSAPP_ALLOWED_LID || undefined,
            store: createChannelSessionStore({ pool, ownerId, keyStore }),
            onDrop: (drop) =>
              logFailure('channel_message_dropped', null, { provider: 'whatsapp', ...drop }),
          }),
        );
      },
    },
    linkPreviews: createPublicLinkPreviewProvider(),
    flights: createGoogleFlights(),
    onboardingEmail: createN8nOnboardingEmail({
      url:
        env.NOD_ONBOARDING_EMAIL_URL ??
        'https://internal.users.n8n.cloud/webhook/nod/onboarding-updates',
    }),
    feedback: createFeedbackDelivery(env),
    traces,
    get model() {
      return models.current;
    },
  };
}

const devTools = developmentMode && !desktopMode;

function alternativeModel(models: ApplicationAdapters['models']) {
  const view = models?.view();
  const other = view?.connections.find(
    (item) =>
      item.id !== view.selection?.connectionId &&
      item.status === 'connected' &&
      item.models.length > 0,
  );
  const choice =
    other && (defaultModel(other.provider, other.models, other.method) ?? other.models[0]);
  return other && choice && !models?.issue({ connectionId: other.id, modelId: choice.id })
    ? {
        connectionId: other.id,
        modelId: choice.id,
        effort: defaultEffort(choice),
        label: `${modelProviderNames[other.provider]} · ${choice.name}`,
      }
    : undefined;
}

export async function createApplication(
  adapters: ApplicationAdapters,
  options: {
    workers?: boolean;
    channels?: boolean;
    heartbeat?: boolean;
    rateLimit?: boolean;
    starting?: (step: string) => void;
  } = {},
) {
  const diagnostics: {
    log?: Awaited<ReturnType<typeof createFeedbackLog>>;
    failures?: Awaited<ReturnType<typeof createFeedbackLog>>;
    failure: FailureLogSink;
  } = {
    failure: (event, error, context) =>
      diagnostics.failures?.record('failure', { event, error, context }, context),
  };
  try {
    return await withFailureLog(diagnostics.failure, () =>
      initializeApplication(adapters, options, diagnostics),
    );
  } catch (error) {
    await diagnostics.log?.close().catch(() => {});
    await diagnostics.failures?.close().catch(() => {});
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
    rateLimit?: boolean;
    starting?: (step: string) => void;
  },
  diagnostics: {
    log?: Awaited<ReturnType<typeof createFeedbackLog>>;
    failures?: Awaited<ReturnType<typeof createFeedbackLog>>;
    failure: FailureLogSink;
  },
) {
  let traceKeyFailure: unknown;
  if (adapters.traces) {
    try {
      adapters.traces.configure({
        conversationKey: Buffer.from(await traceKey(dataRoot), 'base64url'),
      });
    } catch (error) {
      traceKeyFailure = error;
    }
  }
  const analytics = await createAnalytics({
    provider: adapters.analytics,
    environment: analyticsEnvironment(process.env),
    dataRoot,
    installationId: process.env.NOD_ANALYTICS_ID,
    appVersion: process.env.NOD_APP_VERSION,
    withTraceContext:
      adapters.traces &&
      ((operation) => {
        const turnId = randomUUID();
        return adapters.traces!.withTurn({ sessionId: turnId, turnId }, operation);
      }),
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
  const privacyNotice = await loadPrivacyNoticeFile(process.env.NOD_PRIVACY_NOTICE_FILE);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  options.starting?.('database');
  await initializeDatabase();
  await adapters.initialize?.();
  options.starting?.('threads');
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
  const redactIntegrationFailure = createErrorRedactor(secrets);
  const safeIntegrationFailure = (error: unknown) => {
    const status =
      (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ??
      (error as { status?: unknown } | null)?.status;
    const code =
      typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
        ? `HTTP ${status}: `
        : '';
    const upstream = (error as { upstreamStatus?: unknown } | null)?.upstreamStatus;
    const upstreamCode =
      typeof upstream === 'number' &&
      Number.isInteger(upstream) &&
      upstream >= 400 &&
      upstream <= 599 &&
      upstream !== status
        ? `upstream HTTP ${upstream}: `
        : '';
    const message = error instanceof Error ? error.message : String(error);
    return `${code}${upstreamCode}${publicText(redactIntegrationFailure(message)).slice(0, 600)}`;
  };
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
    pricingThresholds: () => adapters.models?.pricingThresholds() ?? [],
  });
  await ledger.initialize();
  adapters.models?.setRequestBudget?.(ledger.reserve);
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
  void adapters.models?.setSelectionCheck(() =>
    onboardingCurator.curate({
      task: 'check',
      instructions: 'Return only {"ok":true}.',
      input: {},
      automatic: false,
    }),
  );
  const decisions = adapters.decisions && ledger.decisions(adapters.decisions);
  const review: ModelReview = async (instructions, input, signal, question, responseSchema) => {
    if (question) {
      const result = await decisions?.check({ instructions, input, question }, signal);
      if (result !== undefined) return result;
      const values = question.choices.map(({ value }) => value);
      instructions += `\nReply with only JSON with one property, ${JSON.stringify(question.name)}. Its value must be one of: ${values.map((value) => JSON.stringify(value)).join(', ')}.`;
    }
    return onboardingCurator.configured
      ? onboardingCurator.curate({ task: 'review', instructions, input, responseSchema }, signal)
      : undefined;
  };
  const mailCheck = createMailCheck({ curator, decisions });
  const skillLibrary = createSkillLibrary(
    [
      fileURLToPath(new URL('../runtime/skills/', import.meta.url)),
      ...[...bundledApps.values()].flatMap((app) => (app.skills ? [app.skills] : [])),
    ],
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
    documentation: createDocumentation(
      fileURLToPath(new URL('../../docs/src/content/docs/', import.meta.url)),
    ),
    flights: adapters.flights,
    computer,
    workspace,
    redactError: createErrorRedactor(secrets),
    redactCommand: createCommandRedactor(secrets),
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
  options.starting?.('memory');
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
  const memoryRecall = createMemoryRecall({
    pool,
    ownerId,
    memory,
    curator: adapters.recallCurator ? ledger.curator(adapters.recallCurator) : curator,
  });
  const writingStyle = createWritingStyleLearning({ memory, curator });
  let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
  const communication = createCommunication({
    pool,
    ownerId,
    review,
    canDeliverLiteral: (channel, text, literal) =>
      channels?.canDeliverLiteral(channel, text, literal) ?? false,
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
  const builtInSkillNames = [...skillLibrary.catalog.map((skill) => skill.name), ...coreSkills];
  const learnedSkills = createLearnedSkills({
    memory,
    curator,
    builtIn: builtInSkillNames,
    redact: createErrorRedactor(secrets),
    analytics: captureAnalytics,
  });
  const procedureCurator = createProcedureCurator({
    pool,
    ownerId,
    memory,
    learnedSkills,
    curator,
    builtIn: builtInSkillNames,
    redact: createErrorRedactor(secrets),
    consumers,
  });
  const turnUsedSkills = new Map<string, Set<string>>();
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
    ownerChannel: (client) => channels?.ownerChannel(client) ?? Promise.resolve('web'),
    retireScheduleConfirmations: (client, id, waitForSend) => {
      if (!retireScheduleConfirmations) throw new Error('Approvals are not ready.');
      return retireScheduleConfirmations(client, id, waitForSend);
    },
    memory,
    learnedSkills,
    models: adapters.models,
    localFilesAvailable: Boolean(adapters.trash),
    consumers,
    stopConsumer: (id) => boss.offWork('scheduled-task', { id, wait: true }),
    clearBrowser: (id) => adapters.computer.clear(id),
    taskModels: {
      list: () => tasks.ownModels(),
      title: (id) => tasks.modelTask(id),
      set: (client, id, model) => tasks.setModel(client ?? pool, id, model, 'agent'),
    },
    modelProjection: async (scope, id, model) => {
      const models = adapters.models;
      if (!models) return null;
      const usage = await ledger.workUsage();
      const spent =
        scope === 'schedule'
          ? usage.schedules[id!]
          : scope === 'task'
            ? usage.tasks[id!]
            : usage.lanes[
                scope === 'schedules' ? 'schedule' : scope === 'background' ? 'background' : 'chat'
              ];
      const last30Usd = spent ? spent.agentUsd + spent.otherUsd : 0;
      if (!spent || last30Usd <= 0) return null;
      const origin =
        scope === 'schedules' || scope === 'schedule'
          ? { kind: 'schedule' as const }
          : scope === 'background'
            ? { kind: 'background' as const }
            : scope === 'task'
              ? ((await tasks.workOf(id!)) ?? { kind: 'chat' as const })
              : { kind: 'chat' as const };
      const target = models.priceOf(
        model === 'light'
          ? (models.light() ?? models.view().selection)
          : (model ?? models.workModel(origin).selection),
      );
      if (!target) return null;
      const withChoiceUsd = canReuseWorkCost(spent, target.modelId, target.pricing)
        ? last30Usd
        : repriceUsd(spent, target.pricing, target.audio);
      return { last30Usd, withChoiceUsd };
    },
    sessionCosts: ledger.sessionCosts,
    sessionUsage: ledger.sessionUsage,
    recentTurnUsage: ledger.recentTurnUsage,
    ...(adapters.models
      ? {
          validateModel: (choice: ModelSelection) => adapters.models!.validateChoice(choice),
          workPricing: (own: ModelSelection | null) => adapters.models!.pricing('schedule', own),
          modelPaused: (model: ModelSelection | null) =>
            adapters.models!.paused({ kind: 'schedule', schedule: model }),
        }
      : {}),
    watchable: (connectionIds, client) => integrations.watchable(connectionIds, client),
    watchState: async (connectionIds) => integrations.watchState(connectionIds),
  });
  await personal.initialize({ workers: options.workers });
  const tasks = createTasks({
    pool,
    ownerId,
    analytics: captureAnalytics,
    refresh,
    clearBrowser: (id) => adapters.computer.clear(id),
    evaluateWakeCheck: async (threadId, taskId, check) => {
      if (check.kind === 'file_exists') {
        const taskRoot = resolve(dataRoot, 'workspaces', threadId, 'tasks', taskId);
        const full = resolve(taskRoot, check.target);
        if (!full.startsWith(`${taskRoot}/`) && full !== taskRoot) return { changed: false };
        const realTaskRoot = await realpath(taskRoot).catch(() => taskRoot);
        const info = await lstat(full).catch(() => null);
        if (!info || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
          return check.baseline === 'absent'
            ? { changed: false, baseline: 'absent' }
            : { changed: false, baseline: 'absent' };
        }
        const realFull = await realpath(full).catch(() => null);
        if (!realFull || (!realFull.startsWith(`${realTaskRoot}/`) && realFull !== realTaskRoot))
          return { changed: false };
        if (check.baseline === 'present') return { changed: false, baseline: 'present' };
        return {
          changed: true,
          baseline: 'present',
          summary: `Workspace path ${check.target} is now present.`,
        };
      }
      const response = await safeRemoteFetch(check.target, {
        method: 'GET',
        headers: { accept: 'text/plain, text/html, application/json;q=0.9, */*;q=0.5' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const fingerprint = `http:${response.status}`;
        if (!check.baseline || check.baseline === fingerprint)
          return { changed: false, baseline: fingerprint };
        return {
          changed: true,
          baseline: fingerprint,
          summary: `URL returned HTTP ${response.status}.`,
        };
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const limit = 65_536;
      if (reader) {
        try {
          while (total < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.byteLength) {
              const take = Math.min(value.byteLength, limit - total);
              chunks.push(take === value.byteLength ? value : value.subarray(0, take));
              total += take;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      const hash = createHash('sha256');
      for (const chunk of chunks) hash.update(chunk);
      const fingerprint = hash.digest('hex');
      if (!check.baseline) return { changed: false, baseline: fingerprint };
      if (fingerprint === check.baseline) return { changed: false, baseline: fingerprint };
      return {
        changed: true,
        baseline: fingerprint,
        summary: `Content at ${check.target} changed.`,
      };
    },
    onTaskDone: (taskId) => {
      if (options.workers !== false) void procedureCurator.enqueue(taskId);
    },
    ...(adapters.models
      ? { validateModel: (choice: ModelSelection) => adapters.models!.validateChoice(choice) }
      : {}),
  });
  await tasks.initialize();
  async function describeModelChoice(input: Record<string, unknown>) {
    const models = adapters.models;
    if (!models) return undefined;
    const view = models.view();
    const scope = String(input.scope ?? 'chat');
    const id = typeof input.id === 'string' ? input.id : undefined;
    const lane = scope === 'schedules' || scope === 'schedule' ? 'schedule' : 'background';
    const choice =
      input.use === 'light'
        ? (view.light ?? view.selection)
        : input.use === 'same'
          ? scope === 'schedule' || scope === 'task'
            ? models.workModel(
                scope === 'task' && id
                  ? ((await tasks.workOf(id)) ?? { kind: 'chat' })
                  : { kind: lane },
              ).selection
            : view.selection
          : { connectionId: String(input.connectionId), modelId: String(input.modelId) };
    const connection = view.connections.find((item) => item.id === choice?.connectionId);
    const model = connection?.models.find((item) => item.id === choice?.modelId);
    if (!connection || !model) return undefined;
    const work =
      scope === 'schedule'
        ? id
          ? `the schedule "${(await personal.getSchedule(id)).title}"`
          : 'the schedule being created'
        : scope === 'task'
          ? id
            ? `the task "${await tasks.modelTask(id)}"`
            : 'the task being started'
          : {
              chat: 'when the owner talks to Nod',
              schedules: 'schedules without their own model',
              background: 'work Nod starts on its own',
            }[scope];
    return {
      service: modelSource(connection),
      account: connection.label,
      model: model.name,
      for: work,
      ...(input.use === 'light' ? { choice: 'the light model' } : {}),
      ...(input.use === 'same' ? { choice: 'back to the default' } : {}),
    };
  }
  const activity = createActivity({
    pool,
    ownerId,
    model: () => adapters.models?.current.label,
    keepAwake: adapters.keepAwake,
  });
  const observedSource = (catalog: ObservationSource[], id: string) =>
    catalog.find((source) => source.id === id) ??
    catalog.find((source) => source.id === `${connectionSources}:${id}`);
  let proactivity!: ReturnType<typeof createProactivity>;
  let privateReady = false;
  const triage = createTriage({
    analytics: captureAnalytics,
    consumers,
    heartbeatKey:
      adapters.integrations.id === 'composio' ? adapters.integrations.configurationId : undefined,
    signal: async (sourceId, client, summary) => {
      if (!privateReady) throw new Error('Background sources are starting.');
      const source = observedSource(await observations.sources(client), sourceId);
      if (source) await proactivity.signal(source.id, client, summary);
    },
    sweep: async () => {
      await sweepArtifacts();
      await sweepExpiredTurns().catch((error) => logFailure('turn_lease_sweep', error));
      await tasks.wakeDue().catch((error) => logFailure('task_wake', error));
      await vault.forgetExpiredHolds().catch((error) => logFailure('vault_expiry', error));
    },
    due: () => proactivity.due(),
  });
  options.starting?.('apps');
  const grantVault = await createAppGrantVault(pool, {
    ownerId,
    keyStore: adapters.keyStore,
  });
  const runConnectedCli: Parameters<typeof createDiscoveredConnections>[1]['runCli'] =
    workspace.connectedCliAvailable
      ? async (threadId, cli, args, environment, timeoutSeconds, signal) => {
          const session = workspace.open({
            threadId,
            workspacePath: join(dataRoot, 'workspaces', threadId),
            signal: signal ?? new AbortController().signal,
          });
          if (!session.runConnectedCli) throw new Error('Connected CLI commands are unavailable.');
          return session.runConnectedCli(cli, args, environment, timeoutSeconds);
        }
      : undefined;
  const discovered = await createDiscoveredConnections(pool, {
    analytics: captureAnalytics,
    analyticsConsent,
    ownerId,
    baseUrl: publicOrigin,
    grantVault,
    transport: createDiscoveredTransport(),
    oauth: createDiscoveredOAuth(),
    local: (origin) => {
      const check = ownerAddress(origin);
      const signIn = ownerAddress(origin, publicHttps);
      return {
        transport: createDiscoveredTransport(ownerFetch(origin), async (endpoint) => {
          const { url } = await check(endpoint);
          if (url.hash || url.search) throw new Error('Use an address without a query.');
          return url.href;
        }),
        oauth: createDiscoveredOAuth(
          ownerFetch(origin, publicHttps),
          async (link) => (await signIn(link)).url.href,
        ),
      };
    },
    runCli: runConnectedCli,
    verifyCli: runConnectedCli
      ? async (cli, args, environment, timeoutSeconds, signal) =>
          runConnectedCli(
            (await activeThread(pool, ownerId)).id,
            cli,
            args,
            environment,
            timeoutSeconds,
            signal,
          )
      : undefined,
    resumeConnection: resumeAfterConnection,
    refresh,
  });
  let vault!: Awaited<ReturnType<typeof createVault>>;
  let vaultAccess!: Awaited<ReturnType<typeof createVaultAccess>>;
  let payments!: Awaited<ReturnType<typeof createPayments>>;
  const previews = adapters.linkPreviews;
  const icon = previews ? cachedIcons((origin) => previews.icon(origin)) : undefined;
  const computerUse = createComputerUse(pool, ownerId, { desktop: adapters.desktop });
  const localFiles = createLocalFiles(pool, ownerId, {
    dataRoot,
    home: adapters.localFilesHome,
    trash: adapters.trash,
    available: Boolean(adapters.trash),
  });
  const preparationBlocked = async () => {
    if ((await ledger.preparationLimit()).reached)
      return 'the monthly preparation allowance is reached';
    const unpriced = adapters.models?.unpricedPreparationModel();
    if (unpriced) return `${unpriced} has no price, so the preparation allowance cannot bound it`;
  };
  const preparationPause = async () => {
    const prefs = await speechPreferences.get();
    if (prefs.proactivePaused) return 'automatic preparation is paused';
    if (isQuietTime(prefs)) return 'it is quiet hours';
    return preparationBlocked();
  };
  const integrations = await createIntegrations(pool, {
    localFiles,
    mailCheck: async (...args) => {
      const pause = await preparationPause();
      if (pause) return args[0].map(() => `background email checks wait because ${pause}`);
      return ledger.withPreparation(randomUUID(), () => mailCheck(...args));
    },
    paused: async () => Boolean(await preparationPause()),
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
    icon,
  });
  const scheduleIdeas = createScheduleIdeas({
    pool,
    ownerId,
    curator,
    memory: () => memory.load(),
    limitReached: async () => Boolean(await ledger.reachedLimit()),
    apps: async () => (await integrations.connectedApps()).map((app) => app.slug),
    run: (work) => analytics.withSystemWork(ownerId, 'schedule_ideas', work),
  });
  await scheduleIdeas.initialize();
  vault = await createVault(pool, {
    signal: closing.signal,
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
    provenance: { threadId: string; turnId: string; signal?: AbortSignal },
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
    if (provenance.signal?.aborted) throw notRun();
    try {
      const page =
        command.action === 'upload'
          ? await computer.upload(
              browserId,
              {
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
              },
              provenance.signal,
            )
          : await computer.act(
              browserId,
              {
                ...(command as BrowserAction),
                expectOrigin,
                expectUrl: String(args.page),
                ...(args.target ? { expectTarget: String(args.target) } : {}),
              },
              provenance.signal,
            );
      return { url: page.url, page: page.text };
    } catch (error) {
      if (error instanceof BrowserActionError && error.code === 'browser_target_changed')
        throw notRun();
      throw error;
    }
  };
  let feedbackDrafts: Awaited<ReturnType<typeof registerFeedback>> | undefined;
  const readyDrafts = () => {
    if (!feedbackDrafts)
      throw Object.assign(new Error('Bug reports are still starting. Try again in a moment.'), {
        notRun: true,
      });
    return feedbackDrafts;
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
      if (isComputerAction(action)) {
        const result = await computerUse.execute(
          { threadId: provenance.threadId, turnId: provenance.turnId },
          action,
          args,
          provenance.signal,
        );
        await ledger.action(
          provenance.turnId,
          action,
          provenance.basis ?? { kind: 'approved' },
          actionTarget(action, args, provenance.details),
        );
        return result;
      }
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
          : action === 'NOD_bug_report_send'
            ? readyDrafts().sendDraft(
                String(args.draftId),
                null,
                () => provenance.signal?.aborted === true,
              )
            : action === 'NOD_limits_update'
              ? withTurnLock(turnLock, (client) => ledger.setLimits(args, 'agent', client))
              : scheduleWrite
                ? transaction(
                    async (client) => {
                      if ((await lockThread(client)).id !== provenance.threadId)
                        throw Object.assign(
                          new Error('The instruction conversation is no longer active.'),
                          { notRun: true },
                        );
                      return withTurnLock(
                        turnLock,
                        (locked) =>
                          personal.manage(action.slice('NOD_'.length), args, provenance, {
                            client: locked,
                          }),
                        client,
                      );
                    },
                    pool,
                    provenance.signal,
                  )
                : lockedWrite
                  ? withTurnLock(turnLock, (client) =>
                      personal.manage(action.slice('NOD_'.length), args, provenance, {
                        client,
                        ...(provenance.details?.currentNotificationRule === undefined
                          ? {}
                          : {
                              expectedNotificationRule: String(
                                provenance.details.currentNotificationRule,
                              ),
                            }),
                        ...(provenance.details?.currentRules === undefined
                          ? {}
                          : { expectedRules: String(provenance.details.currentRules) }),
                      }),
                    )
                  : action.startsWith('NOD_')
                    ? personal.manage(action.slice('NOD_'.length), args, provenance)
                    : (async () => {
                        integrations.serviceWait('action', action);
                        const savedBinding = provenance.details?.verifiedBinding;
                        const verifiedBinding =
                          typeof savedBinding === 'string' ? savedBinding : undefined;
                        if (
                          (action === 'CONNECTED_HTTP' || action === 'CONNECTED_MCP_CALL') &&
                          !verifiedBinding
                        )
                          throw Object.assign(
                            new Error(
                              'The connected app confirmation has no saved account binding. Ask for this action again.',
                            ),
                            { notRun: true },
                          );
                        if (action === 'GMAIL_DELETE_MESSAGE' || action === 'GMAIL_DELETE_DRAFT') {
                          const currentBinding = await integrations
                            .binding(String(args.connectionId ?? ''))
                            .catch((error: unknown) => {
                              throw Object.assign(
                                new Error(
                                  `Nod could not check the selected Gmail account for deletion: ${safeIntegrationFailure(error)}`,
                                ),
                                { notRun: true },
                              );
                            });
                          if (!verifiedBinding || currentBinding !== verifiedBinding)
                            throw Object.assign(
                              new Error('The selected Gmail account changed after confirmation.'),
                              { notRun: true },
                            );
                          if (action === 'GMAIL_DELETE_DRAFT') {
                            const draftId = args.draft_id;
                            const savedMessageId = provenance.details?.verifiedDraftMessageId;
                            if (
                              typeof draftId !== 'string' ||
                              !draftId.trim() ||
                              typeof savedMessageId !== 'string' ||
                              !savedMessageId.trim()
                            )
                              throw Object.assign(
                                new Error(
                                  'The Gmail draft confirmation is missing its verified target.',
                                ),
                                { notRun: true },
                              );
                            const readArgs = {
                              connectionId: args.connectionId,
                              draft_id: draftId,
                              format: 'metadata',
                              ...(typeof args.user_id === 'string'
                                ? { user_id: args.user_id }
                                : {}),
                            };
                            const readVerdict = await trust
                              .check(
                                { threadId: provenance.threadId, turnId: provenance.turnId },
                                'GMAIL_GET_DRAFT',
                                readArgs,
                                provenance.signal,
                              )
                              .catch((error: unknown) => {
                                throw Object.assign(
                                  new Error(
                                    `Nod could not recheck permission to read the Gmail draft before deletion: ${safeIntegrationFailure(error)}`,
                                  ),
                                  { notRun: true },
                                );
                              });
                            if (readVerdict.confirm)
                              throw Object.assign(
                                new Error(
                                  'Nod could not authorize a fresh Gmail draft read before deletion.',
                                ),
                                { notRun: true },
                              );
                            const current = await integrations
                              .execute(
                                ownerId,
                                'GMAIL_GET_DRAFT',
                                readArgs,
                                { threadId: provenance.threadId, turnId: provenance.turnId },
                                provenance.signal,
                                verifiedBinding,
                                'read',
                              )
                              .catch((error: unknown) => {
                                throw Object.assign(
                                  new Error(
                                    `Nod could not recheck the Gmail draft before deletion: ${safeIntegrationFailure(error)}`,
                                  ),
                                  { notRun: true },
                                );
                              });
                            await ledger
                              .action(provenance.turnId, 'GMAIL_GET_DRAFT', readVerdict.basis)
                              .catch((error: unknown) => {
                                throw Object.assign(
                                  new Error(
                                    `Nod could not record the Gmail draft read before deletion: ${safeIntegrationFailure(error)}`,
                                  ),
                                  { notRun: true },
                                );
                              });
                            const currentTarget = gmailDraftTarget(current, draftId);
                            if (!currentTarget)
                              throw Object.assign(
                                new Error(
                                  'Nod could not verify the Gmail draft before deletion. Ask again before deleting it.',
                                ),
                                { notRun: true },
                              );
                            if (currentTarget.messageId !== savedMessageId)
                              throw Object.assign(
                                new Error(
                                  'The Gmail draft changed after confirmation. Ask again before deleting it.',
                                ),
                                { notRun: true },
                              );
                          }
                        }
                        const turn = { threadId: provenance.threadId, turnId: provenance.turnId };
                        let validateCalendar: (() => Promise<void>) | undefined;
                        if (isCalendarEventChange(action)) {
                          const origin = await turnOrigin(provenance.turnId);
                          const saved = provenance.details?.target;
                          const revision = provenance.details?.verifiedCalendarRevision;
                          const instruction = z
                            .object({
                              rules: z.string(),
                              standingInstruction: z.string().optional(),
                              chat: z
                                .object({ threadId: z.uuid(), id: z.uuid() })
                                .strict()
                                .optional(),
                              task: z
                                .object({ id: z.uuid(), revision: z.number().int().nonnegative() })
                                .strict()
                                .optional(),
                            })
                            .strict()
                            .safeParse(provenance.details?.verifiedInstructionRevision);
                          if (
                            !origin ||
                            !verifiedBinding ||
                            typeof revision !== 'string' ||
                            !/^[a-f0-9]{64}$/.test(revision) ||
                            !instruction.success ||
                            (origin.source === 'event' &&
                              instruction.data.standingInstruction === undefined) ||
                            (origin.source === 'schedule' && !origin.scheduleInstruction) ||
                            !saved ||
                            typeof saved !== 'object' ||
                            Array.isArray(saved) ||
                            (saved as Record<string, unknown>).eventId !== args.event_id
                          )
                            throw Object.assign(
                              new Error(
                                'This Calendar confirmation has no verified event. Ask again before changing it.',
                              ),
                              { notRun: true },
                            );
                          try {
                            validateCalendar = () =>
                              transaction(
                                async (client) => {
                                  if ((await lockThread(client)).id !== provenance.threadId)
                                    throw Object.assign(
                                      new Error('This Calendar conversation is no longer active.'),
                                      { notRun: true },
                                    );
                                  await withTurnLock(
                                    turnLock,
                                    async () => {
                                      if (origin.source === 'schedule')
                                        validateScheduledInstructions(origin.scheduleInstruction);
                                      await validateInstructionRevision(
                                        client,
                                        ownerId,
                                        instruction.data,
                                      );
                                      if (
                                        (await integrations.binding(
                                          String(args.connectionId),
                                          client,
                                        )) !== verifiedBinding
                                      )
                                        throw Object.assign(
                                          new Error(
                                            'The selected Calendar account changed after confirmation.',
                                          ),
                                          { notRun: true },
                                        );
                                    },
                                    client,
                                  );
                                },
                                pool,
                                provenance.signal,
                              );
                            await validateCalendar();
                            const readWork =
                              (await turnOrigin(provenance.turnId))?.source === 'user'
                                ? 'read'
                                : 'background';
                            const current = await readCalendarTarget(
                              turn,
                              args,
                              verifiedBinding,
                              provenance.signal,
                              readWork,
                            );
                            if (
                              current.revision !== revision ||
                              !isDeepStrictEqual(current.target, saved)
                            )
                              throw new Error(
                                'The Calendar event changed after confirmation. Ask again before changing it.',
                              );
                            await validateCalendar();
                          } catch (error) {
                            const failed = provenance.signal?.aborted
                              ? provenance.signal.reason
                              : error;
                            throw Object.assign(
                              failed instanceof Error ? failed : new Error(String(failed)),
                              { notRun: true },
                            );
                          }
                        }
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
                          action === 'GMAIL_DELETE_MESSAGE' ||
                            action === 'GMAIL_DELETE_DRAFT' ||
                            action === 'CONNECTED_MCP_CALL' ||
                            action === 'CONNECTED_HTTP' ||
                            isCalendarEventChange(action)
                            ? verifiedBinding
                            : undefined,
                          validateCalendar,
                        );
                        await ledger.action(
                          provenance.turnId,
                          action,
                          provenance.basis ?? { kind: 'approved' },
                          actionTarget(action, args, provenance.details),
                          objectIds(result),
                        );
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
      if (action.startsWith('NOD_') && action !== 'NOD_vault_allow')
        await ledger.action(
          provenance.turnId,
          action,
          provenance.basis ?? { kind: 'approved' },
          actionTarget(action, args, provenance.details),
        );
      return result;
    },
    async (action, args, expectedRevision, client) => {
      if (
        ['NOD_browser', 'NOD_vault_allow', 'NOD_bug_report_send', 'NOD_workspace_command'].includes(
          action,
        ) ||
        isComputerAction(action)
      )
        return;
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
    (reply) => ledger.forOwner(() => trust.answer(reply)),
    communication.describe,
    captureAnalytics,
    createErrorRedactor(secrets),
    (input, signal) => ledger.forOwner(() => trust.classifyRepeatedAction(input, signal)),
  );
  retireScheduleConfirmations = approvals.retireScheduleConfirmations;
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
        undefined,
        'background',
      );
    },
    read: async (
      account: AppAccount,
      tool: AppTool,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      integrations.serviceWait('background', tool.action);
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
      return integrations.execute(
        ownerId,
        tool.action,
        args,
        undefined,
        signal,
        account.binding,
        'background',
      );
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
      region:
        localeRegion(preferences.locale) ??
        timeZoneRegion(preferences.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone) ??
        undefined,
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
  const sanitizeDiagnostics = async (value: unknown) => {
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
  };
  diagnostics.log = await createFeedbackLog({ dataRoot, ownerId, sanitize: sanitizeDiagnostics });
  diagnostics.failures = await createFeedbackLog({
    dataRoot,
    ownerId,
    name: 'failures',
    sanitize: sanitizeDiagnostics,
  });
  if (traceKeyFailure !== undefined)
    logFailure('trace_conversation_key_unavailable', traceKeyFailure);
  adapters.traces?.configure({
    enabled: (await localAccounts.read(ownerId)).traces,
    userId: analytics.distinctId,
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
      kind: 'sign_in' | 'form';
      account?: string;
      itemId?: string;
    },
    admit?: (asks: boolean, read?: boolean) => Promise<void>,
  ): Promise<{ reason: VaultActivityReason; basis?: TrustBasis } | { question: string }> {
    const access = await vaultAccess.authorize(turn, target, admit);
    if (access.ok)
      return { reason: access.reason, ...(access.basis ? { basis: access.basis } : {}) };
    const result = await approvals.request(turn, 'NOD_vault_allow', access.args, {
      admit,
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
          question.name === 'retiredReply' || question.name === 'repeatedAction'
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
  async function readCalendarTarget(
    turn: TurnRef,
    args: Record<string, unknown>,
    binding: string,
    signal: AbortSignal | undefined,
    work: 'read' | 'background',
  ) {
    const eventId = args.event_id;
    const calendarId = args.calendar_id ?? 'primary';
    if (
      typeof eventId !== 'string' ||
      !eventId.trim() ||
      typeof calendarId !== 'string' ||
      !calendarId.trim()
    )
      throw new Error('Nod cannot identify the Calendar event proposed for change.');
    const readAction = 'GOOGLECALENDAR_EVENTS_GET';
    const readArgs = {
      connectionId: args.connectionId,
      calendar_id: calendarId,
      event_id: eventId,
      max_attendees: 1,
    };
    await integrations.assertOffered(ownerId, readAction, signal);
    const verdict = await trust.check(turn, readAction, readArgs, signal);
    if (verdict.confirm)
      throw new Error(
        verdict.reason === 'rule'
          ? 'Your rules require confirmation before reading this Calendar event, so Nod did not identify it or propose a change.'
          : 'Nod could not authorize the Calendar read needed to identify this event, so it did not propose a change.',
      );
    let observed: unknown;
    try {
      observed = await integrations.execute(
        ownerId,
        readAction,
        readArgs,
        turn,
        signal,
        binding,
        work,
      );
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(
        `The Calendar event read failed: ${safeIntegrationFailure(error)} Nod did not change the event.`,
      );
    }
    if ((await integrations.binding(String(args.connectionId ?? ''))) !== binding)
      throw new Error('The selected Calendar account changed while Nod read the event.');
    const target = calendarEventTarget(observed, eventId);
    if (!target)
      throw new Error(
        'Nod cannot verify the Calendar event, its dates and its version, so it did not propose or make a change.',
      );
    await ledger.action(turn.turnId, readAction, verdict.basis);
    signal?.throwIfAborted();
    return target;
  }
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
    curator: adapters.classificationCurator && ledger.curator(adapters.classificationCurator),
    analytics: captureAnalytics,
    modelAvailable: async () =>
      !(await preparationBlocked()) &&
      (adapters.models
        ? await adapters.models.automaticRequestsAllowed({ kind: 'background' }, true)
        : adapters.model.configured),
    redact: createTextRedactor(secrets),
    ownerChannel: (client) => channels?.ownerChannel(client) ?? Promise.resolve('web'),
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
  });
  await proactivity.initialize();
  privateReady = true;
  vaultAccess = await createVaultAccess(pool, {
    ownerId,
    check: trust.check,
    refresh,
  });
  const activityLog = createActivityLog({
    bounds: ledger.bounds,
    within: ledger.within,
    chunk: ledger.chunk,
    vault: vaultAccess.within,
    steps: (turnIds, page) => ledger.steps(turnIds, page),
    vaultPage: vaultAccess.ascending,
  });
  payments = await createPayments(pool, {
    ownerId,
    analytics: captureAnalytics,
    present: (turn, input) =>
      communication.presentPayment(turn.threadId, input, undefined, turn.turnId),
    uses: vault.uses,
    page: (threadId) => computer.currentPage(threadId),
    destinations: (threadId, fields) => computer.cardDestinations(threadId, fields),
    capture: (threadId) => computer.checkoutImage(threadId),
    cards: () => vault.paymentCards(),
    card: (id, version, client) => vault.paymentCard(id, version, client),
    fill: (input, signal) => computer.fillCard(input, signal),
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
  const reactToMessage = (
    messageId: string,
    reaction: Parameters<typeof reactToAssistantMessage>[1],
    wake = adapters.model.configured,
    replyChannel?: string,
  ) => reactToAssistantMessage(messageId, reaction, wake, userMessages, replyChannel);
  let startThreadConsumers: (() => Promise<void>) | undefined;
  if (options.workers !== false) {
    if (options.heartbeat !== false) await triage.initializeHeartbeat();
    await initializeMemoryLearning({
      boss,
      consumers,
      run: () => analytics.withSystemWork(ownerId, 'memory_learning', learning.run),
    });
    await procedureCurator.start();
    startThreadConsumers = startThreadWorkers.bind(undefined, {
      present: communication.present,
      taskChecks: tasks.resumeDue,
      analytics: captureAnalytics,
      currentModel: () => adapters.model,
      ...(adapters.models
        ? {
            workModel: async (turnId: string) => {
              const origin = await workOrigin(turnId);
              if (!origin) return undefined;
              const { selection } = adapters.models!.workModel(origin);
              const { provider, name } = adapters.models!.describe(selection);
              return { selection, provider, name };
            },
          }
        : {}),
      modelAlternative: () => {
        const other = alternativeModel(adapters.models);
        return other
          ? `Your ${other.label} connection is also set up: you can switch to it in ${appPages['/settings/models']}.`
          : undefined;
      },
      desktopRuntime: desktopMode,
      taskClassification: true,
      ...(adapters.classificationCurator
        ? {
            activityLine: (() => {
              const line = createActivityLine(
                ledger.curator(adapters.classificationCurator),
                createTextRedactor(secrets),
              );
              return (
                turnId: string,
                input: { text: string; question?: string },
                signal: AbortSignal,
              ) => ledger.withTurn(turnId, () => line(input, signal));
            })(),
          }
        : {}),
      observeTurn: (turnId, operation, sessionId) => {
        const observe = (ids?: { thread_id: string; turn_id: string }) =>
          analytics
            .withRun(
              ownerId,
              async () => {
                try {
                  await operation();
                } finally {
                  const consent = analytics.currentRun(ownerId)?.consent;
                  void admission
                    .run(() =>
                      ledger.withTurn(turnId, () => taskClassification.run(turnId, consent)),
                    )
                    ?.catch(() => {});
                }
              },
              ids,
            )
            .finally(() => {
              const due = () => proactivity.due();
              void admission
                .run(() => (adapters.traces ? adapters.traces.outsideTurn(due) : due()))
                ?.catch((error) => logFailure('proactivity_wake', error));
            });
        const traces = adapters.traces;
        return traces
          ? traces.captureTurn(turnId, () => traces.withTurn({ turnId, sessionId }, observe))
          : observe();
      },
      consumers,
      artifacts,
      writeArtifact: workspace.writeArtifact.bind(workspace),
      workspaceAvailable: () => workspace.available?.() !== false,
      readArtifact: workspace.readArtifact.bind(workspace),
      cardImage: previews?.image ? (url, signal) => previews.image!(url, signal) : undefined,
      mapTile: previews?.mapTile
        ? (zoom, x, y, signal) => previews.mapTile!(zoom, x, y, signal)
        : undefined,
      mailCheck,
      executeConfirmation: approvals.executeConfirmed,
      stoppedOutcomes: approvals.stoppedOutcomes,
      credentialRequestStatuses: vault.requestStatuses,
      bindVerificationQuestion: chatVerification.bindQuestion,
      reactToMessage: reactions.react,
      proactivity: proactivity.context,
      runTurn: async (context) => {
        const automaticWork =
          !context.currentMessageId &&
          (Boolean(context.proactivity) ||
            Boolean(
              (
                await pool.query(
                  'SELECT 1 FROM tasks WHERE owner_id=$1 AND session_id=$2 AND activity_key IS NOT NULL',
                  [ownerId, context.sessionId],
                )
              ).rowCount,
            ));
        const origin = adapters.models && (await workOrigin(context.turnId));
        const follows = origin ? adapters.models!.workModel(origin).follows : 'chat';
        const modelChosen = follows !== 'chat' && follows !== 'light';
        const delegateModel = modelChosen ? undefined : (adapters.models?.light() ?? undefined);
        const run = () =>
          ledger.withTurn(
            context.turnId,
            () =>
              runtime
                .runTurn({
                  ...context,
                  ...(modelChosen ? { modelChosen } : {}),
                  ...(delegateModel ? { delegateModel } : {}),
                  runtimeHost: desktopMode ? 'desktop' : 'server',
                })
                .then(
                  (result) => {
                    const used = turnUsedSkills.get(context.turnId);
                    if (used?.size) {
                      turnUsedSkills.delete(context.turnId);
                      for (const name of used) void learnedSkills.recordOutcome(name, true);
                    }
                    return result;
                  },
                  (error) => {
                    const used = turnUsedSkills.get(context.turnId);
                    if (used?.size) {
                      turnUsedSkills.delete(context.turnId);
                      const transient =
                        context.signal?.aborted ||
                        error instanceof ModelRequestError ||
                        error instanceof ContextLimitError ||
                        error instanceof OutputLimitError ||
                        (error instanceof Error &&
                          (error.name === 'AbortError' || error.message === spendingLimitReached));
                      if (!transient)
                        for (const name of used) void learnedSkills.recordOutcome(name, false);
                    }
                    throw error;
                  },
                )
                .finally(() => proactivity.release(context.turnId)),
            Boolean(context.spendingLimitReached),
            Boolean(context.automatic),
          );
        return automaticWork ? ledger.withPreparation(context.turnId, run) : run();
      },
      spendingLimit: ledger.reachedLimit,
      checkIn: ledger.checkIn,
      scheduleCache: personal.scheduleCache,
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
      task: async (turn, raw, sourceMessageId, priorMessageId, priorHandoff, sourcePrompt) => {
        const request = raw as { action?: unknown; model?: unknown } | undefined;
        if (request?.action === 'start' && request.model) {
          const current = (
            await pool.query<{ proactive: boolean; chat: boolean }>(
              'SELECT proactive,session_id=thread_id AS chat FROM turns WHERE id=$1 AND owner_id=$2',
              [turn.turnId, ownerId],
            )
          ).rows[0];
          if (!current?.chat || current.proactive)
            throw new Error('Only a task the owner starts from chat can have its own model.');
          const choice = await personal.validateReview('model_select', {
            scope: 'chat',
            ...(request.model as Record<string, unknown>),
          });
          const verdict = await trust.check(turn, 'NOD_model_select', {
            ...choice,
            scope: 'task',
            targetModel: await describeModelChoice({ ...choice, scope: 'task' }),
          });
          if (verdict.confirm)
            throw new Error(
              'The owner did not ask for a model for this task. Start it without model, or ask the owner first.',
            );
          const { connectionId, modelId, effort } = choice as Record<string, unknown>;
          return tasks.execute(
            turn,
            { ...(raw as object), model: { connectionId, modelId, effort } },
            sourceMessageId,
            priorMessageId,
            priorHandoff,
            sourcePrompt,
          );
        }
        return tasks.execute(
          turn,
          raw,
          sourceMessageId,
          priorMessageId,
          priorHandoff,
          sourcePrompt,
        );
      },
      startTurn: async (turn) => {
        const origin = await turnOrigin(turn.turnId);
        if (origin?.source === 'schedule')
          validateScheduledInstructions(origin.scheduleInstruction);
        await tasks.inherit(turn);
      },
      connections: async (...args) => {
        const result = await integrations.manageConnections(...args);
        if (!('url' in result) || !('name' in result) || typeof result.name !== 'string')
          return result;
        const turn = args[2];
        try {
          if (!turn) throw new Error('The connection needs an active conversation.');
          const message = await communication.present(
            turn.threadId,
            {
              kind: 'connection',
              app: result.name,
              operation: 'operation' in result ? result.operation : 'connect',
              ...('account' in result ? { account: result.account } : {}),
              next: 'complete_private_sign_in',
            },
            undefined,
            turn.turnId,
          );
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
      browserStep: async (turn, request, signal, admit) => {
        const args = browserStepArgs(request);
        const verdict = await trust.check(turn, 'NOD_browser', args, signal);
        const prepareConfirmation = async () => {
          const control = request.page.controls?.[0];
          const namedControl =
            control?.name.trim() && !['RootWebArea', 'WebArea', 'document'].includes(control.role);
          const form = request.page.submits;
          const knownForm = typeof form === 'object' && form.method.trim() && form.to.trim();
          const enter =
            (request.step.action === 'press' && isEnterKey(request.step.key)) ||
            (request.step.action === 'type' && /[\r\n]/.test(request.step.text ?? ''));
          if (
            !namedControl &&
            ((request.step.action === 'click' &&
              (request.step.x !== undefined ||
                request.step.y !== undefined ||
                request.step.points !== undefined ||
                !knownForm)) ||
              (enter && !knownForm))
          ) {
            const action =
              request.step.action === 'click'
                ? 'click'
                : request.step.action === 'type'
                  ? 'typed line break'
                  : 'Enter press';
            throw new Error(
              `The ${action} target is not identified. Inspect a fresh snapshot or screenshot and choose the actual control. Do not ask the owner to approve an unidentified ${action}.`,
            );
          }
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
          return typeof visible === 'string' && visible.trim()
            ? { pageText: publicText(visible.slice(0, 20_000)) }
            : {};
        };
        if (!verdict.confirm) {
          if (verdict.basis.kind === 'read') return 'run';
          const basis = verdict.basis;
          const allowed = {
            record: () =>
              ledger.action(turn.turnId, 'NOD_browser', basis, actionTarget('NOD_browser', args)),
          };
          const handoff = await approvals.request(turn, 'NOD_browser', args, {
            allowed: true,
            prepareConfirmation,
            admit: async (asks, read) => {
              if (asks && request.subagent) throw new Error('A subagent cannot ask the owner.');
              await admit?.(asks, read);
            },
            signal,
            run: async () => 'run',
          });
          return handoff === 'run'
            ? allowed
            : handoff && typeof handoff === 'object' && appConfirmation in handoff
              ? handoff
              : { result: handoff };
        }
        if (request.subagent) return 'refused';
        const result = await approvals.request(turn, 'NOD_browser', args, {
          signal,
          admit,
          details: { reason: verdict.reason },
          prepareConfirmation,
        });
        return result && typeof result === 'object' && appConfirmation in result
          ? result
          : { result };
      },
      speech,
      audioReplies: async () => (await speechPreferences.get()).speechReply,
      manage: async (turn, action, args, { admit, signal, ...provenance }) => {
        if (action === 'prepared_list')
          return untrustedBlock('prepared work', JSON.stringify(await proactivity.prepared(args)));
        if (action === 'prepared_update') {
          const { id, state, snoozedUntil, feedback } = await proactivity.control(args, turn);
          return { id, state, snoozedUntil, feedback };
        }
        if (action === 'bug_report_draft' || action === 'bug_report_send') {
          if (!readyDrafts().configured)
            return 'Bug reports cannot be sent from this Nod. Describe the problem in your reply instead.';
        }
        if (action === 'bug_report_draft') {
          const { summary } = z.object({ summary: z.string().trim().min(1).max(4000) }).parse(args);
          await withTurnLock(turn.turnId, (client) =>
            insertBugReportDraft(client, turn, '', summary),
          );
          refresh();
          return 'The owner now sees this bug report with a Send report button, or can reply "send" in a chat app. Do not repeat the summary.';
        }
        if (action === 'bug_report_send') {
          const draft = await readyDrafts().draftFor(turn.threadId, provenance.sourceMessageId);
          if (!draft)
            throw new Error(
              'No unsent bug report is waiting in this conversation. Draft one with bug_report_draft first.',
            );
          if (draft.sent) return { status: 'already_sent', receipt: draft.sent };
          const input = { draftId: draft.id, summary: draft.summary };
          const verdict = await trust.check(turn, 'NOD_bug_report_send', input, signal);
          return approvals.request(turn, 'NOD_bug_report_send', input, {
            ...provenance,
            signal,
            allowed: !verdict.confirm,
            ...(verdict.confirm ? {} : { basis: verdict.basis }),
            admit,
            details: verdict.confirm ? { reason: verdict.reason } : {},
          });
        }
        if (action === 'limits_update') {
          const input = limitsInput.parse(args);
          const verdict = await trust.check(turn, 'NOD_limits_update', input, signal);
          return approvals.request(turn, 'NOD_limits_update', input, {
            ...provenance,
            signal,
            allowed: !verdict.confirm,
            ...(verdict.confirm ? {} : { basis: verdict.basis }),
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
          const prepared = action.startsWith('schedule_')
            ? await personal.prepareScheduleChange(action, args)
            : undefined;
          const input: Record<string, unknown> =
            prepared?.input ?? (await personal.validateReview(action, args));
          const current = prepared?.before ?? undefined;
          if (action === 'schedule_pause' && current?.enabled === false)
            return personal.getSchedule(String(input.id));
          const preferences =
            action === 'notification_preferences_update'
              ? await triage.getPreferences()
              : undefined;
          const rule = 'notificationRule' in input ? preferences?.notificationRule : undefined;
          const rules = 'rules' in input ? preferences?.rules : undefined;
          const targetModel =
            action === 'model_select'
              ? await describeModelChoice(input)
              : action === 'schedule_create' && input.model
                ? await describeModelChoice({
                    scope: 'schedule',
                    ...(input.model as ModelSelection),
                  })
                : undefined;
          const verdict = await trust.check(
            turn,
            `NOD_${action}`,
            {
              ...input,
              ...(targetModel ? { targetModel } : {}),
              ...(current ? { currentSchedule: current } : {}),
              ...(rule === undefined ? {} : { currentNotificationRule: rule }),
              ...(rules === undefined ? {} : { currentRules: rules }),
            },
            signal,
            prepared,
          );
          return approvals.request(turn, `NOD_${action}`, input, {
            ...provenance,
            signal,
            allowed: !verdict.confirm,
            ...(verdict.confirm ? {} : { basis: verdict.basis }),
            admit,
            instructionChange: verdict.instructionChange,
            expectedRevision: prepared?.revision,
            validate: prepared?.before
              ? async (client) => {
                  const current = (
                    await client.query(
                      'SELECT revision FROM schedules WHERE id=$1 AND owner_id=$2 FOR SHARE',
                      [input.id, ownerId],
                    )
                  ).rows[0];
                  if (current?.revision !== prepared.revision)
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
          const verdict = await trust.check(turn, `NOD_${action}`, input, signal);
          return approvals.request(turn, `NOD_${action}`, input, {
            ...provenance,
            signal,
            allowed: !verdict.confirm,
            ...(verdict.confirm ? {} : { basis: verdict.basis }),
            admit,
            details: verdict.confirm ? { reason: verdict.reason } : {},
          });
        }
        if (action === 'skill_read') {
          const name = String(args.name);
          const result = await learnedSkills.read(name);
          let used = turnUsedSkills.get(turn.turnId);
          if (!used) {
            used = new Set();
            turnUsedSkills.set(turn.turnId, used);
          }
          used.add(name);
          return result;
        }
        if (action === 'skill_overlays') {
          const overlays = await learnedSkills.overlayFor(String(args.name));
          if (overlays?.length) {
            let used = turnUsedSkills.get(turn.turnId);
            if (!used) {
              used = new Set();
              turnUsedSkills.set(turn.turnId, used);
            }
            for (const overlay of overlays) used.add(overlay.name);
          }
          return overlays;
        }
        if (action === 'skill_save' || action === 'skill_patch') {
          const origin = await turnOrigin(turn.turnId);
          if (!origin || !['user', 'schedule', 'task'].includes(origin.source))
            throw new Error(
              'Only work the owner started, in chat, a task or a schedule, can save a skill.',
            );
          await admit?.(false);
          return learnedSkills.learn(
            args,
            turn.turnId,
            (write) => withTurnLock({ turnId: turn.turnId, signal }, write),
            signal,
          );
        }
        await admit?.(false);
        if (action === 'memory_learn') {
          const origin = await turnOrigin(turn.turnId);
          if (!origin || !['user', 'task'].includes(origin.source))
            throw new Error('Only work the owner started, in chat or a task, can save to memory.');
          return learning.remember(
            args,
            provenance.sourceMessageId,
            (write) => withTurnLock({ turnId: turn.turnId, signal }, write),
            signal,
          );
        }
        if (action === 'channels_get')
          return untrustedBlock(
            'channels',
            JSON.stringify(
              (await channels?.status())?.map((channel) => ({
                channel: channel.provider,
                connected:
                  channel.status === 'configured' &&
                  channel.ownerLinked &&
                  channel.available !== false,
                ...(channel.error ? { error: channel.error } : {}),
                lastMessageFromOwner: channel.lastMessageAt,
              })) ?? [],
            ),
          );
        if (action === 'usage_get')
          return untrustedBlock(
            'usage',
            JSON.stringify(
              Object.keys(args).length ? await activityLog.read(args, 200) : await ledger.read(),
            ),
          );
        const source = { ...provenance, turnId: turn.turnId };
        if (action === 'schedule_record_observation')
          return withTurnLock({ turnId: turn.turnId, signal }, (client) =>
            personal.manage(action, args, source, { client }),
          );
        return personal.manage(action, args, source);
      },
      requestPayment: async (turn, input, show, admit) => {
        await admit?.(true);
        const { image, ...result } = await payments.request(turn, input);
        await show(image);
        return result;
      },
      requestCredential: async (turn, input, admit) => {
        if (input.kind === 'method') {
          const origin = credentialOrigin(input.origin);
          const access = await permitVault(turn, { origin, kind: 'sign_in' }, admit);
          if ('question' in access) return { [appConfirmation]: access.question };
          await admit?.(true);
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
            const access = await permitVault(
              turn,
              {
                origin,
                kind: 'sign_in',
                itemId: login.id,
                account: [login.label, login.usernameHint].filter(Boolean).join(' · '),
              },
              admit,
            );
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
        const origins = credentialOrigins(origin);
        const saved = (await vault.list(ownerId)).filter((entry) => origins.includes(entry.origin));
        const chosen =
          savedLoginId !== undefined
            ? saved.find((entry) => entry.id === savedLoginId)
            : saved.length === 1
              ? saved[0]
              : undefined;
        const access = await permitVault(
          turn,
          {
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
          },
          admit,
        );
        if ('question' in access) return { [appConfirmation]: access.question };
        const ask = async (entry: typeof request) => {
          await admit?.(true);
          return vault.request(turn, ownerId, entry);
        };
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
          return (await vault.fillEmailCode(turn, ownerId, request)) ? filled() : ask(request);
        if (savedLoginId !== undefined)
          return (await vault.fillSaved(turn, ownerId, savedLoginId, request))
            ? filled(savedLoginId)
            : ask(request);
        const selected = await vault.fillSelected(turn, ownerId, request);
        if (selected) return filled();
        if (selected === undefined && chosen) {
          if (await vault.fillSaved(turn, ownerId, chosen.id, request)) return filled(chosen.id);
        }
        return ask(request);
      },
      localFiles: localFiles.available,
      computerUse: computerUse.available,
      integration: async (turn, action, args, options) => {
        if (action === 'CONNECTED_HTTP') args = structuredClone(args);
        if (isComputerAction(action)) {
          if (action === 'COMPUTER_KEEP_OUT') {
            await options.admit?.(false);
            return withTurnLock(
              { turnId: turn.turnId, signal: options.signal },
              async (client) => ({
                keptOut: await computerUse.keepOut(turn, String(args.bundle ?? ''), client),
              }),
            );
          }
          const prepared = await computerUse.prepare(turn, action, args, options.signal);
          if (!computerUse.needsCheck(action, prepared)) {
            await options.admit?.(false, action !== 'COMPUTER_FOCUS');
            return computerUse.execute(turn, action, prepared, options.signal);
          }
          const verdict = await trust.check(
            turn,
            action,
            computerUse.checked(action, prepared),
            options.signal,
          );
          await options.admit?.(verdict.confirm);
          return approvals.request(turn, action, prepared, {
            allowed: !verdict.confirm,
            signal: options.signal,
            run: async () => {
              const result = await computerUse.execute(turn, action, prepared, options.signal);
              await ledger.action(
                turn.turnId,
                action,
                verdict.confirm ? { kind: 'approved' } : verdict.basis,
                actionTarget(action, prepared),
              );
              return result;
            },
            details: verdict.confirm ? { reason: verdict.reason } : {},
          });
        }
        if (action === 'LOCAL_FILES_KEEP_OUT') {
          await options.admit?.(false);
          return withTurnLock({ turnId: turn.turnId, signal: options.signal }, async (client) => ({
            keptOut: await localFiles.keepOut(turn, String(args.path ?? ''), client),
          }));
        }
        const readWork = (await turnOrigin(turn.turnId))?.source === 'user' ? 'read' : 'background';
        if (action === 'SEARCH_TOOLS') {
          await options.admit?.(false, true);
          const result = await integrations.execute(
            ownerId,
            action,
            args,
            turn,
            options.signal,
            undefined,
            readWork,
          );
          return result;
        }
        if (isLocalFilesAction(action) && localFiles.available && !(await localFiles.enabled())) {
          await localFiles.assertStartedByOwner(turn);
          const input = { localFilesEnabled: true };
          const verdict = await trust.check(turn, 'NOD_notification_preferences_update', input);
          return approvals.request(turn, 'NOD_notification_preferences_update', input, {
            allowed: !verdict.confirm,
            ...(verdict.confirm ? {} : { basis: verdict.basis }),
            signal: options.signal,
            admit: options.admit,
            details: {
              ...(typeof args.path === 'string' ? { requestedPath: args.path } : {}),
              accessScope:
                'Enable local file access in the home folder and external drives for work the owner starts. Hidden files, secrets, private system folders and kept-out folders stay blocked. This enables the setting only; the requested file action has not run.',
            },
          });
        }
        await integrations.assertOffered(ownerId, action, options.signal);
        const prepare = () =>
          hasWorkspaceFiles(args)
            ? withTurnLock(turn.turnId, (client) =>
                integrations.prepare(ownerId, action, args, turn, options.signal, true, client),
              )
            : isLocalFilesAction(action)
              ? integrations.prepare(ownerId, action, args, turn, options.signal)
              : integrations.prepare(ownerId, action, args);
        const resolved =
          isLocalFilesAction(action) || action === 'CONNECTED_HTTP' ? await prepare() : undefined;
        const http =
          action === 'CONNECTED_HTTP'
            ? await discovered.approvalDetails(action, resolved!, options.signal)
            : undefined;
        const verdict = await trust.check(turn, action, resolved ?? args, options.signal);
        const prepared = resolved ?? (await prepare());
        let connected = http;
        let targetBinding: string | undefined;
        let verifiedCalendarRevision: string | undefined;
        let verifiedInstructionRevision: InstructionRevision | undefined;
        const prepareConfirmation = async () => {
          connected ??=
            action === 'CONNECTED_MCP_CALL'
              ? await discovered.approvalDetails(action, prepared, options.signal)
              : undefined;
          const account =
            !connected && typeof prepared.connectionId === 'string'
              ? (await integrations.list(ownerId, { refresh: false })).find(
                  (item) => item.connectionId === prepared.connectionId,
                )
              : undefined;
          const path = account?.accessPaths?.find((item) => item.id === prepared.pathId);
          let target:
            | ReturnType<typeof gmailMessageTarget>
            | NonNullable<ReturnType<typeof calendarEventTarget>>['target']
            | {
                draftId: string;
                subject?: string;
                from?: string;
                to?: string;
                cc?: string;
                bcc?: string;
              };
          let verifiedDraftMessageId: string | undefined;
          const deletingDraft = action === 'GMAIL_DELETE_DRAFT';
          if (action === 'GMAIL_DELETE_MESSAGE' || deletingDraft) {
            const itemId = deletingDraft ? prepared.draft_id : prepared.message_id;
            const item = deletingDraft ? 'draft' : 'message';
            const connectionId = prepared.connectionId;
            if (typeof itemId !== 'string' || !itemId.trim() || typeof connectionId !== 'string')
              throw new Error(`Nod cannot identify the Gmail ${item} proposed for deletion.`);
            targetBinding = await integrations.binding(connectionId);
            if (!targetBinding)
              throw new Error('The selected Gmail account is no longer available for deletion.');
            let boundAccountId: unknown;
            try {
              boundAccountId = JSON.parse(targetBinding)[0];
            } catch {}
            if (!account?.accountId || account.accountId !== boundAccountId)
              throw new Error('The selected Gmail account changed before deletion was proposed.');
            const readAction = deletingDraft
              ? 'GMAIL_GET_DRAFT'
              : 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID';
            const metadataArgs = {
              connectionId,
              format: 'metadata',
              ...(deletingDraft ? { draft_id: itemId } : { message_id: itemId }),
              ...(typeof prepared.user_id === 'string' ? { user_id: prepared.user_id } : {}),
            };
            const readVerdict = await trust.check(turn, readAction, metadataArgs, options.signal);
            if (readVerdict.confirm)
              throw new Error(
                readVerdict.reason === 'rule'
                  ? `Your rules require confirmation before reading this Gmail ${item}, so Nod did not identify it or propose deletion. Allow this read in your rules before asking to delete it.`
                  : deletingDraft
                    ? 'Nod could not authorize the Gmail draft read needed to identify this draft, so it did not propose deletion.'
                    : 'Nod could not authorize the Gmail metadata read needed to identify this message, so it did not propose deletion.',
              );
            let observed: unknown;
            try {
              observed = await integrations.execute(
                ownerId,
                readAction,
                metadataArgs,
                turn,
                options.signal,
                targetBinding,
                readWork,
              );
            } catch (error) {
              options.signal?.throwIfAborted();
              throw new Error(
                `The Gmail ${deletingDraft ? 'draft' : 'metadata'} read failed: ${safeIntegrationFailure(error)} Nod did not ask for approval or delete the ${item}.`,
              );
            }
            await ledger.action(turn.turnId, readAction, readVerdict.basis);
            if (deletingDraft) {
              const draft = gmailDraftTarget(observed, itemId);
              if (draft) {
                const { messageId, ...visible } = draft;
                verifiedDraftMessageId = messageId;
                target = visible;
              }
            } else target = gmailMessageTarget(observed, itemId);
            if (!target)
              throw new Error(
                `Nod cannot verify which Gmail ${item} this would delete, so it did not ask for approval or delete it.`,
              );
          }
          if (isCalendarEventChange(action)) {
            const connectionId = prepared.connectionId;
            if (typeof connectionId !== 'string')
              throw new Error('Nod cannot identify the Calendar account proposed for change.');
            targetBinding = await integrations.binding(connectionId);
            let boundAccountId: unknown;
            try {
              boundAccountId = targetBinding && JSON.parse(targetBinding)[0];
            } catch {}
            if (!targetBinding || !account?.accountId || account.accountId !== boundAccountId)
              throw new Error(
                'The selected Calendar account changed before the change was proposed.',
              );
            const current = await readCalendarTarget(
              turn,
              prepared,
              targetBinding,
              options.signal,
              readWork,
            );
            target = current.target;
            verifiedCalendarRevision = current.revision;
            verifiedInstructionRevision = verdict.instructionRevision;
          }
          const earlierActions = await ledger.earlierActions(
            turn.threadId,
            objectIds(prepared, ''),
          );
          return {
            ...(earlierActions.length
              ? {
                  earlierActions: earlierActions.map((earlier) => ({
                    action: recordedTitle(earlier.action),
                    target: earlier.target,
                  })),
                }
              : {}),
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
            ...(connected ?? {}),
            ...(target ? { target } : {}),
            ...(targetBinding ? { verifiedBinding: targetBinding } : {}),
            ...(verifiedCalendarRevision ? { verifiedCalendarRevision } : {}),
            ...(verifiedInstructionRevision ? { verifiedInstructionRevision } : {}),
            ...(verifiedDraftMessageId ? { verifiedDraftMessageId } : {}),
          };
        };
        const result = await approvals.request(turn, action, prepared, {
          allowed: !verdict.confirm,
          admit: options.admit,
          signal: options.signal,
          validate: async (client) => {
            if (verifiedInstructionRevision)
              await validateInstructionRevision(client, ownerId, verifiedInstructionRevision);
            if (
              connected &&
              (await discovered.binding(String(prepared.connectionId), client)) !==
                connected.verifiedBinding
            )
              throw Object.assign(
                new Error(
                  `This connected account changed before ${verdict.confirm ? 'confirmation' : 'execution'}.`,
                ),
                { notRun: true },
              );
          },
          run: async () => {
            const result = await integrations.execute(
              ownerId,
              action,
              prepared,
              turn,
              options.signal,
              connected?.verifiedBinding ?? targetBinding,
              !verdict.confirm && verdict.basis.kind === 'read' ? readWork : 'action',
            );
            await ledger.action(
              turn.turnId,
              action,
              verdict.confirm ? { kind: 'approved' } : verdict.basis,
              actionTarget(action, prepared),
              objectIds(result),
            );
            return result;
          },
          details: verdict.confirm ? { reason: verdict.reason } : {},
          prepareConfirmation,
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
    rateLimit: options.rateLimit,
    analytics: captureAnalytics,
    admission,
    artifacts,
    submitMessage: userMessages.submit,
    reactToMessage,
    speech,
    attributeAudioUsage: ledger.attributeMediaUsage,
    verification: chatVerification,
    taskLedger: tasks.read,
    forgetLearned: devTools ? async () => void (await memory.control({ clear: true })) : undefined,
    activity: activity.current,
    planningTasks: onboardingSuggestions.planning,
    computer,
    configuration: () => {
      const alternative = alternativeModel(adapters.models);
      return configuration({
        provider: adapters.model.provider,
        model: adapters.model.name,
        llmReady: adapters.model.configured,
        modelReconnect: adapters.model.reconnect === true,
        ...(adapters.models?.current.checking ? { modelChecking: true } : {}),
        ...(adapters.model.issue ? { modelIssue: adapters.model.issue } : {}),
        ...(alternative ? { modelAlternative: alternative } : {}),
        integrationsReady: adapters.integrations.configured,
      });
    },
  });
  adapters.models?.register(app, captureAnalytics);
  proactivity.registerRoutes(app);

  app.addHook('preClose', async () => {
    closing.abort();
    await adapters.models?.close();
  });
  const feedbackReportOptions: FeedbackReportOptions = {
    pool,
    ownerId,
    secrets,
    profile: ownerProfile,
    logs: () => diagnostics.log!.snapshot(),
    failures: () => diagnostics.failures!.snapshot(),
    dataRoot,
    trustModel: adapters.trustModel ?? 'selected',
    context: await feedbackContext({ environment: process.env }),
    get provider() {
      return adapters.model.provider;
    },
    get model() {
      return adapters.model.name;
    },
  };
  feedbackDrafts = await registerFeedback(app, {
    pool,
    ownerId,
    context: feedbackReportOptions.context!,
    delivery: adapters.feedback ?? {
      configured: false,
      recipient: null,
      submit: async (input) => ({ submissionId: input.submissionId, status: 'rejected' }),
      status: async (submissionId) => ({ submissionId, status: 'rejected' }),
    },
    buildReport: (activity, errors, errorsAvailable, client) =>
      buildFeedbackReport({
        ...feedbackReportOptions,
        errors,
        errorsAvailable,
        client,
        activity: [...feedbackActivity.snapshot(), ...activity].sort((a, b) => b.ageMs - a.ageMs),
      }),
    analytics: captureAnalytics,
  });
  registerPrivacyNotice(app, privacyNotice);
  const developerIds = desktopMode ? new Set<string>() : new Set([ownerId]);
  const turnTraceIds = devTools ? developerIds : new Set<string>();
  if (turnTraceIds.has(ownerId)) {
    const turnTraces = createTurnTraces({ pool, ownerId });
    turnTraces.registerRoutes(app);
    adapters.traces?.configure({ capture: turnTraces.record });
  }
  createAccountSession({
    analytics,
    model: () => adapters.model,
    accounts: localAccounts,
    localUser: { id: ownerId, name: 'You', email: null, avatarUrl: null },
    developerIds,
    turnTraceIds,
    start: welcome,
    onboardingMissing: async () => (adapters.model.configured ? null : 'brain'),
    traces: adapters.traces?.available ?? false,
    onTraces: (enabled) => adapters.traces?.configure({ enabled }),
    updatesEmail: onboardingProfile.available,
  }).register(app);
  ledger.registerRoutes(app);
  activityLog.registerRoutes(app);
  registerSpeechSettings(app, {
    speech,
    preferences: speechPreferences,
    local: adapters.localSpeech,
    inputFormat: adapters.speechInputFormat,
    transcriptionServer: () => adapters.models?.hasTranscriptionServer() ?? false,
  });
  registerLinkOpened(app);
  vault.registerRoutes(app);
  payments.registerRoutes(app);
  vaultAccess.registerRoutes(app);
  adapters.integrationBrowser?.registerRoutes(app);
  integrations.registerRoutes(app);
  localFiles.registerRoutes(app);
  computerUse.registerRoutes(app);
  personal.registerRoutes(app);
  scheduleIdeas.registerRoutes(app);
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
      classifyRetiredReply: (reply, expired) =>
        ledger.forOwner(() => trust.classifyRetiredReply(reply, expired)),
      acceptVerification: (text, input) => chatVerification.accept(text, input),
      reacted: (messageId, reaction) => reactToMessage(messageId, reaction),
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
      acceptApproval: async (client, input) => {
        const { threadId, messageId, approvalId, approved, channel, label, stopSignal } = input;
        await userMessages.submit(label ?? (approved ? 'Approve' : 'Cancel'), [], {
          client,
          threadId,
          channel,
          replyToMessageId: messageId,
          approvalAnswer: { approvalId, approved },
          stopSignal,
        });
      },
      acceptInteraction: async (client, input) =>
        (
          await userMessages.submit(input.text, [], {
            threadId: input.threadId,
            sourceId: input.sourceId,
            channel: input.channel,
            client,
            clientMessageId: input.messageId,
            replyToMessageId: input.replyToMessageId,
            questionAnswer: { choiceIds: input.choiceIds },
            stopSignal: input.stopSignal,
          })
        ).turnId,
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
  await startThreadConsumers?.();
  await onboardingSuggestions.initialize();
  if (adapters.model.configured)
    void admission.run(integrations.resumeWritingStyle)?.catch(() => {});
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
  app.addHook('onReady', async () => {
    void discovered.servers().catch((error) => logFailure('mcp_tool_list_preload', error));
    return activity.start();
  });
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
      () => {
        const seconds = process.uptime();
        captureAnalytics({
          event: 'runtime_stopped',
          properties: {
            uptime: seconds < 3600 ? 'under_1h' : seconds < 86_400 ? 'under_1d' : 'over_1d',
          },
        });
      },
      () => analytics.shutdown(),
      () => adapters.telemetry?.shutdown(),
      () => diagnostics.log?.close(),
      () => diagnostics.failures?.close(),
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

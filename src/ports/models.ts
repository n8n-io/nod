import type { ModelChoice, ModelProvider, ModelMethod, ModelEffort } from '../shared/models.ts';

export type ModelCredential =
  | { type: 'api_key'; key: string }
  | { type: 'endpoint'; url: string; key?: string }
  | { type: 'bedrock'; key: string; region: string }
  | { type: 'azure'; url: string; key: string; model: string; deployment: string }
  | {
      type: 'oauth';
      access: string;
      refresh: string;
      expires: number;
      accountId: string;
      clientId: string;
      idToken: string;
      email?: string;
    };

export class ModelAuthError extends Error {
  constructor(
    message: string,
    readonly requiresReconnect = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ModelDefinition {
  choice: ModelChoice;
  spec: Record<string, unknown>;
}

export interface ModelAccess {
  provider: ModelProvider;
  method: ModelMethod;
  definition: ModelDefinition;
  effort: ModelEffort;
  read(): Promise<ModelCredential | undefined>;
  needsReconnect?(credential?: ModelCredential): Promise<void>;
}

export interface ModelBackend {
  signIn(input: { signal: AbortSignal; hostId: string; previous?: ModelCredential }): Promise<{
    url: string;
    state: string;
    result: Promise<ModelCredential>;
    complete(callback: URL): void;
  }>;
  catalog(
    provider: ModelProvider,
    method: ModelMethod,
    credential?: ModelCredential,
  ): Promise<ModelDefinition[]>;
  authorize(input: { provider: 'openrouter'; redirectUri: string }): {
    url: string;
    state: string;
    secret: Record<string, unknown>;
  };
  exchange(
    provider: 'openrouter',
    secret: Record<string, unknown>,
    callback: URL,
  ): Promise<ModelCredential>;
  refresh(credential: ModelCredential): Promise<ModelCredential>;
}

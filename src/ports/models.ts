import type { ModelChoice, ModelProvider, ModelMethod, ModelEffort } from '../shared/models.ts';

export type ModelCredential =
  | { type: 'api_key'; key: string }
  | {
      type: 'oauth';
      access: string;
      refresh: string;
      expires: number;
      clientId: string;
      subject: string;
      idToken: string;
      scopes: string[];
      email?: string;
    };

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
}

export interface ModelBackend {
  catalog(
    provider: ModelProvider,
    method: ModelMethod,
    credential?: ModelCredential,
  ): Promise<ModelDefinition[]>;
  authorize(input: {
    provider: 'openai' | 'openrouter';
    redirectUri: string;
    hostId: string;
    previous?: ModelCredential;
  }): { url: string; state: string; secret: Record<string, unknown> };
  exchange(
    provider: 'openai' | 'openrouter',
    secret: Record<string, unknown>,
    callback: URL,
  ): Promise<ModelCredential>;
  refresh(credential: ModelCredential): Promise<ModelCredential>;
}

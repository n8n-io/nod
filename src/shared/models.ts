export type ModelProvider = 'openai' | 'anthropic' | 'openrouter';
export type ModelMethod = 'api_key' | 'subscription' | 'oauth';
export type ModelEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelChoice {
  id: string;
  name: string;
  efforts: ModelEffort[];
  images: boolean;
  contextWindow: number;
}

export interface ModelSelection {
  connectionId: string;
  modelId: string;
  effort: ModelEffort;
}

export interface ModelConnection {
  id: string;
  provider: ModelProvider;
  method: ModelMethod;
  label: string;
  status: 'connected' | 'loading' | 'reconnect';
  models: ModelChoice[];
  managed: boolean;
}

export interface ModelsResponse {
  connections: ModelConnection[];
  selection: ModelSelection | null;
  subscriptionAvailable: boolean;
}

export const modelProviderNames = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
} as const;

export function modelSource(connection: Pick<ModelConnection, 'provider' | 'method'>) {
  return connection.method === 'subscription'
    ? 'ChatGPT plan'
    : connection.provider === 'openrouter'
      ? 'OpenRouter'
      : `${modelProviderNames[connection.provider]} API`;
}

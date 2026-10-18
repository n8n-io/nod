export type ModelProvider = 'openai' | 'anthropic' | 'openrouter' | 'compatible';
export type ModelMethod = 'api_key' | 'subscription' | 'oauth';
export type ModelEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export function lightestEffort(efforts: ModelEffort[]) {
  return efforts.find((level) => ['off', 'minimal', 'low', 'medium'].includes(level)) ?? efforts[0];
}

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
  local: boolean;
}

export const modelProviderNames = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  compatible: 'OpenAI-compatible',
} as const;

export function modelSource(connection: Pick<ModelConnection, 'provider' | 'method'>) {
  return connection.method === 'subscription'
    ? 'ChatGPT plan'
    : connection.provider === 'openrouter' || connection.provider === 'compatible'
      ? modelProviderNames[connection.provider]
      : `${modelProviderNames[connection.provider]} API`;
}

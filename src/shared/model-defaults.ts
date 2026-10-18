import type { ModelProvider } from './models.ts';

export const agentModels: Partial<Record<ModelProvider, string>> = {
  openai: 'gpt-6.1-sol',
  anthropic: 'claude-opus-5-5',
  openrouter: 'openai/gpt-6.1-sol',
};

export const memoryModels: Partial<Record<ModelProvider, string>> = {
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-4-5',
  openrouter: 'openai/gpt-6-luna',
};

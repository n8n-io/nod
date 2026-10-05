export const agentModels = {
  openai: 'gpt-6.1-sol',
  anthropic: 'claude-opus-5-5',
  openrouter: 'openai/gpt-6.1-sol',
} as const;

export const relevanceModel = 'gpt-6-luna';

export const memoryModels = {
  openai: relevanceModel,
  anthropic: 'claude-haiku-4-5',
  openrouter: 'openai/gpt-6-luna',
} as const;

import type { ModelChoice, ModelEffort, ModelMethod, ModelProvider } from './models.ts';

export const agentModels: Partial<Record<ModelProvider, string>> = {
  'ant-ling': 'Ling-3.1-flash',
  anthropic: 'claude-opus-5-5',
  azure: 'gpt-6.1-sol',
  baseten: 'moonshotai/Kimi-K3',
  cerebras: 'qwen-3.8-27b',
  'cloudflare-ai-gateway': 'gpt-6.1-sol',
  'cloudflare-workers-ai': '@cf/moonshotai/kimi-k2.7-code',
  deepseek: 'deepseek-flash',
  fireworks: 'accounts/fireworks/models/kimi-k3',
  google: 'gemini-3.8-flash',
  'google-vertex': 'gemini-4-argon',
  groq: 'qwen/qwen3.8-27b',
  huggingface: 'moonshotai/Kimi-K3',
  'kimi-coding': 'k3',
  meta: 'muse-spark-1.3',
  minimax: 'MiniMax-M3',
  'minimax-cn': 'MiniMax-M3',
  mistral: 'mistral-large-4',
  moonshotai: 'kimi-k3',
  'moonshotai-cn': 'kimi-k3',
  nvidia: 'z-ai/glm-5.3-flash',
  openai: 'gpt-6.1-sol',
  opencode: 'gpt-6.1-sol',
  'opencode-go': 'kimi-k3',
  openrouter: 'openai/gpt-6.1-sol',
  'qwen-token-plan': 'qwen3.8-max',
  'qwen-token-plan-cn': 'qwen3.8-max',
  'qwen-token-plan-individual': 'qwen3.8-max',
  radius: 'balanced',
  together: 'moonshotai/Kimi-K3',
  'vercel-ai-gateway': 'openai/gpt-6.1-sol',
  xai: 'grok-4.7',
  xiaomi: 'mimo-v2.6-pro',
  'xiaomi-token-plan-ams': 'mimo-v2.6-pro',
  'xiaomi-token-plan-cn': 'mimo-v2.6-pro',
  'xiaomi-token-plan-sgp': 'mimo-v2.6-pro',
  zai: 'glm-5.3-flash',
  'zai-coding-cn': 'glm-5.3-flash',
};

export const memoryModels: Partial<Record<ModelProvider, string>> = {
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-5-5',
  openrouter: 'openai/gpt-6-luna',
  google: 'gemini-3.8-flash',
  'google-vertex': 'gemini-3.8-flash',
  mistral: 'mistral-small-latest',
  opencode: 'gpt-6-luna',
  'vercel-ai-gateway': 'openai/gpt-6-luna',
  radius: 'cheap',
};

export function defaultModel(provider: ModelProvider, models: ModelChoice[], method?: ModelMethod) {
  if (provider === 'amazon-bedrock' && models.length > 1) return undefined;
  const preferred =
    (method === 'subscription' && models.find((model) => model.id === 'gpt-6-sol')) ||
    models.find((model) => model.id === agentModels[provider]);
  if (preferred || provider === 'google') return preferred;
  return models[0];
}

export function defaultEffort(provider: ModelProvider, model: ModelChoice): ModelEffort {
  const preferred =
    provider === 'google' || provider === 'google-vertex' || provider === 'ant-ling'
      ? 'medium'
      : 'high';
  return model.efforts.includes(preferred) ? preferred : model.efforts[0];
}

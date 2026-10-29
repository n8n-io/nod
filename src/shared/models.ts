export const apiKeyModelProviders = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'amazon-bedrock',
  'google-vertex',
  'azure',
  'ant-ling',
  'baseten',
  'cerebras',
  'cloudflare-workers-ai',
  'cloudflare-ai-gateway',
  'deepseek',
  'fireworks',
  'groq',
  'huggingface',
  'kimi-coding',
  'meta',
  'minimax',
  'minimax-cn',
  'mistral',
  'moonshotai',
  'moonshotai-cn',
  'nvidia',
  'opencode',
  'opencode-go',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'radius',
  'together',
  'vercel-ai-gateway',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai',
  'zai-coding-cn',
] as const;

export const apiKeyConnectionProviders = [...apiKeyModelProviders, 'elevenlabs'] as const;
export const modelProviders = [...apiKeyModelProviders, 'compatible'] as const;
export type ModelProvider = (typeof apiKeyConnectionProviders)[number] | 'compatible';
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
  audio?: boolean;
  textModelName?: string;
  contextWindow: number;
  pricing?: { input: number; output: number } | 'variable';
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
  keyEnding?: string;
}

export interface ModelsResponse {
  connections: ModelConnection[];
  selection: ModelSelection | null;
}

export interface ModelWorkspace {
  id: string;
  name: string;
}

export const modelProviderNames = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  elevenlabs: 'ElevenLabs',
  'amazon-bedrock': 'Amazon Bedrock',
  'google-vertex': 'Google Vertex AI',
  azure: 'Azure OpenAI',
  'ant-ling': 'Ant Ling',
  baseten: 'Baseten',
  cerebras: 'Cerebras',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks AI',
  groq: 'Groq',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding China',
  meta: 'Meta',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax China',
  mistral: 'Mistral',
  moonshotai: 'Moonshot AI',
  'moonshotai-cn': 'Moonshot AI China',
  nvidia: 'NVIDIA',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
  'qwen-token-plan': 'Qwen Token Plan',
  'qwen-token-plan-cn': 'Qwen Token Plan China',
  'qwen-token-plan-individual': 'Qwen Token Plan Individual',
  radius: 'Radius',
  together: 'Together AI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  xai: 'xAI',
  xiaomi: 'Xiaomi MiMo',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan Amsterdam',
  'xiaomi-token-plan-cn': 'Xiaomi Token Plan China',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan Singapore',
  zai: 'Z.AI',
  'zai-coding-cn': 'Z.AI Coding China',
  compatible: 'OpenAI-compatible',
} as const satisfies Record<ModelProvider, string>;

export const modelProviderInfo: Record<
  ModelProvider,
  {
    keyUrl: string;
    env: string;
    common?: boolean;
    catalog: 'account' | 'bundled';
    speechOnly?: boolean;
  }
> = {
  openai: {
    keyUrl: 'platform.openai.com/api-keys',
    env: 'OPENAI_API_KEY',
    catalog: 'account',
    common: true,
  },
  anthropic: {
    keyUrl: 'console.anthropic.com/settings/keys',
    env: 'ANTHROPIC_API_KEY',
    catalog: 'account',
    common: true,
  },
  google: {
    keyUrl: 'aistudio.google.com/api-keys',
    env: 'GEMINI_API_KEY',
    catalog: 'account',
    common: true,
  },
  openrouter: {
    keyUrl: 'openrouter.ai/settings/keys',
    env: 'OPENROUTER_API_KEY',
    catalog: 'account',
    common: true,
  },
  elevenlabs: {
    keyUrl: 'elevenlabs.io/app/developers/api-keys',
    env: 'ELEVENLABS_API_KEY',
    catalog: 'account',
    speechOnly: true,
  },
  'amazon-bedrock': {
    keyUrl: 'console.aws.amazon.com/bedrock',
    env: 'AWS_BEARER_TOKEN_BEDROCK',
    catalog: 'account',
  },
  'google-vertex': {
    keyUrl: 'console.cloud.google.com/apis/credentials',
    env: 'GOOGLE_CLOUD_API_KEY',
    catalog: 'account',
  },
  azure: { keyUrl: 'ai.azure.com', env: 'AZURE_OPENAI_API_KEY', catalog: 'account' },
  'ant-ling': { keyUrl: 'chat.ant-ling.com/open', env: 'ANT_LING_API_KEY', catalog: 'bundled' },
  baseten: {
    keyUrl: 'app.baseten.co/settings/api_keys',
    env: 'BASETEN_API_KEY',
    catalog: 'bundled',
  },
  cerebras: { keyUrl: 'cloud.cerebras.ai', env: 'CEREBRAS_API_KEY', catalog: 'account' },
  'cloudflare-workers-ai': {
    keyUrl: 'dash.cloudflare.com',
    env: 'CLOUDFLARE_WORKERS_AI_API_KEY',
    catalog: 'account',
  },
  'cloudflare-ai-gateway': {
    keyUrl: 'dash.cloudflare.com',
    env: 'CLOUDFLARE_AI_GATEWAY_API_KEY',
    catalog: 'account',
  },
  deepseek: {
    keyUrl: 'platform.deepseek.com/api_keys',
    env: 'DEEPSEEK_API_KEY',
    catalog: 'account',
  },
  fireworks: {
    keyUrl: 'app.fireworks.ai/settings/users/api-keys',
    env: 'FIREWORKS_API_KEY',
    catalog: 'bundled',
  },
  groq: { keyUrl: 'console.groq.com/keys', env: 'GROQ_API_KEY', catalog: 'account' },
  huggingface: { keyUrl: 'huggingface.co/settings/tokens', env: 'HF_TOKEN', catalog: 'bundled' },
  'kimi-coding': { keyUrl: 'www.kimi.com/code/console', env: 'KIMI_API_KEY', catalog: 'bundled' },
  meta: { keyUrl: 'dev.meta.ai', env: 'META_API_KEY', catalog: 'bundled' },
  minimax: { keyUrl: 'platform.minimax.io', env: 'MINIMAX_API_KEY', catalog: 'bundled' },
  'minimax-cn': { keyUrl: 'platform.minimaxi.com', env: 'MINIMAX_CN_API_KEY', catalog: 'bundled' },
  mistral: { keyUrl: 'console.mistral.ai/api-keys', env: 'MISTRAL_API_KEY', catalog: 'account' },
  moonshotai: {
    keyUrl: 'platform.moonshot.ai/console/api-keys',
    env: 'MOONSHOT_API_KEY',
    catalog: 'account',
  },
  'moonshotai-cn': {
    keyUrl: 'platform.moonshot.cn/console/api-keys',
    env: 'MOONSHOT_CN_API_KEY',
    catalog: 'account',
  },
  nvidia: { keyUrl: 'build.nvidia.com', env: 'NVIDIA_API_KEY', catalog: 'bundled' },
  opencode: { keyUrl: 'opencode.ai/auth', env: 'OPENCODE_API_KEY', catalog: 'bundled' },
  'opencode-go': { keyUrl: 'opencode.ai/auth', env: 'OPENCODE_GO_API_KEY', catalog: 'bundled' },
  'qwen-token-plan': {
    keyUrl: 'modelstudio.console.alibabacloud.com',
    env: 'QWEN_TOKEN_PLAN_API_KEY',
    catalog: 'bundled',
  },
  'qwen-token-plan-cn': {
    keyUrl: 'bailian.console.aliyun.com',
    env: 'QWEN_TOKEN_PLAN_CN_API_KEY',
    catalog: 'bundled',
  },
  'qwen-token-plan-individual': {
    keyUrl: 'modelstudio.console.alibabacloud.com',
    env: 'QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY',
    catalog: 'bundled',
  },
  radius: { keyUrl: 'radius.earendil.com/enter', env: 'RADIUS_API_KEY', catalog: 'account' },
  together: {
    keyUrl: 'api.together.ai/settings/projects/~current/api-keys',
    env: 'TOGETHER_API_KEY',
    catalog: 'account',
  },
  'vercel-ai-gateway': {
    keyUrl: 'vercel.com/dashboard/ai-gateway',
    env: 'AI_GATEWAY_API_KEY',
    catalog: 'bundled',
  },
  xai: { keyUrl: 'console.x.ai', env: 'XAI_API_KEY', catalog: 'account' },
  xiaomi: { keyUrl: 'platform.xiaomimimo.com', env: 'XIAOMI_API_KEY', catalog: 'bundled' },
  'xiaomi-token-plan-ams': {
    keyUrl: 'platform.xiaomimimo.com',
    env: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
    catalog: 'bundled',
  },
  'xiaomi-token-plan-cn': {
    keyUrl: 'platform.xiaomimimo.com',
    env: 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
    catalog: 'bundled',
  },
  'xiaomi-token-plan-sgp': {
    keyUrl: 'platform.xiaomimimo.com',
    env: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
    catalog: 'bundled',
  },
  zai: { keyUrl: 'z.ai/manage-apikey/apikey-list', env: 'ZAI_API_KEY', catalog: 'bundled' },
  'zai-coding-cn': { keyUrl: 'open.bigmodel.cn', env: 'ZAI_CODING_CN_API_KEY', catalog: 'bundled' },
  compatible: { keyUrl: '', env: 'OPENAI_COMPATIBLE_API_KEY', catalog: 'account' },
};

export const bedrockRegionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
export const azureDeploymentPattern = /^[\w.-]{1,64}$/;
export const cloudflareAccountPattern = /^[a-f0-9]{32}$/i;
export const cloudflareGatewayPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function modelSource(connection: Pick<ModelConnection, 'provider' | 'method'>) {
  return connection.method === 'subscription'
    ? 'ChatGPT plan'
    : connection.provider === 'openai' || connection.provider === 'anthropic'
      ? `${modelProviderNames[connection.provider]} API`
      : modelProviderNames[connection.provider];
}

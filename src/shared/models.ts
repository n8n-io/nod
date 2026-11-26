export const apiKeyModelProviders = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'hostinger',
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

export const openAIRegions = {
  global: 'Global',
  eu: 'Europe (EEA + Switzerland)',
  us: 'United States',
  au: 'Australia',
  ca: 'Canada',
  in: 'India',
  jp: 'Japan',
  sg: 'Singapore',
  kr: 'South Korea',
  ae: 'United Arab Emirates',
  gb: 'United Kingdom',
} as const;

export type OpenAIRegion = keyof typeof openAIRegions;

export function lightestEffort(efforts: ModelEffort[]) {
  return efforts.find((level) => ['off', 'minimal', 'low', 'medium'].includes(level)) ?? efforts[0];
}

export function checkEffort(efforts: ModelEffort[]) {
  return (
    (['medium', 'low', 'minimal'] as const).find((level) => efforts.includes(level)) ?? efforts[0]
  );
}

export interface ModelChoice {
  id: string;
  name: string;
  efforts: ModelEffort[];
  images: boolean;
  audio?: boolean;
  textModelName?: string;
  contextWindow: number;
  pricing?: ModelPricing | 'variable';
}

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  longCacheWrites?: boolean;
  tiers?: Array<Omit<ModelPricing, 'tiers'> & { inputTokensAbove: number }>;
}

export interface ModelSelection {
  connectionId: string;
  modelId: string;
  effort: ModelEffort;
}

export type ModelLane = 'schedule' | 'background';
export type ModelRoute = ModelSelection | 'light';
export type ModelRoutes = Partial<Record<ModelLane, ModelRoute | null>>;
export type WorkKind = 'chat' | ModelLane;

export interface WorkModel {
  selection: ModelSelection;
  follows: 'task' | 'schedule' | 'lane' | 'light' | 'chat';
}

export interface WorkUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  agentUsd: number;
  otherUsd: number;
  models: string[];
  pricingSignatures?: Array<string | null>;
  tokensAbove?: Array<
    [
      threshold: number,
      input: number,
      output: number,
      cacheRead: number,
      cacheWrite: number,
      cacheWrite1h: number,
    ]
  >;
}

export interface WorkUsageResponse {
  lanes: Record<WorkKind, WorkUsage>;
  schedules: Record<string, WorkUsage>;
  tasks: Record<string, WorkUsage>;
  own: Array<
    WorkUsage & { kind: WorkKind; task: ModelSelection | null; schedule: ModelSelection | null }
  >;
}

export function routeModel(
  models: {
    connections: Array<{ id: string }>;
    selection: ModelSelection | null;
    routes?: ModelRoutes;
    light?: ModelSelection | null;
  },
  kind: WorkKind,
  own: { task?: ModelSelection | null; schedule?: ModelSelection | null } = {},
): WorkModel | null {
  const present = (choice: ModelSelection | null | undefined) =>
    choice && models.connections.some((row) => row.id === choice.connectionId) ? choice : undefined;
  const task = present(own.task);
  if (task) return { selection: task, follows: 'task' };
  const schedule = kind === 'schedule' ? present(own.schedule) : undefined;
  if (schedule) return { selection: schedule, follows: 'schedule' };
  const route = kind === 'chat' ? undefined : models.routes?.[kind];
  if (route === 'light' && models.light) return { selection: models.light, follows: 'light' };
  const lane = route === 'light' ? undefined : present(route);
  if (lane) return { selection: lane, follows: 'lane' };
  return models.selection ? { selection: models.selection, follows: 'chat' } : null;
}

export function boundedPrice(cost: ModelChoice['pricing']) {
  if (!cost || cost === 'variable') return false;
  const prices = [cost.input, cost.output, cost.cacheRead ?? 0, cost.cacheWrite ?? 0];
  return prices.every((price) => Number.isFinite(price) && price >= 0) && Math.max(...prices) > 0;
}

export function supportsLongCacheWrites(api: unknown) {
  return api === 'anthropic-messages' || api === 'bedrock-converse-stream';
}

export function modelPricingSignature(
  pricing: ModelChoice['pricing'],
  api?: unknown,
): string | undefined {
  if (!pricing || pricing === 'variable' || !boundedPrice(pricing)) return undefined;
  const rates = (value: Omit<ModelPricing, 'tiers'>) => [
    value.input,
    value.output,
    value.cacheRead ?? value.input,
    value.cacheWrite ?? value.input,
  ];
  const tiers = (pricing.tiers ?? []).map((tier) => [tier.inputTokensAbove, ...rates(tier)]);
  if (tiers.some((tier) => tier.some((value) => !Number.isFinite(value) || value < 0)))
    return undefined;
  const longCacheWrites = pricing.longCacheWrites ?? supportsLongCacheWrites(api);
  return JSON.stringify([...rates(pricing), ...tiers, ...(longCacheWrites ? ['1h'] : [])]);
}

export function canReuseWorkCost(
  usage: WorkUsage,
  modelId: string,
  pricing: ModelChoice['pricing'],
) {
  const signature = modelPricingSignature(pricing);
  return (
    signature !== undefined &&
    usage.models.length === 1 &&
    usage.models[0] === modelId &&
    usage.pricingSignatures?.length === 1 &&
    usage.pricingSignatures[0] === signature
  );
}

export function repriceUsd(usage: WorkUsage, pricing: ModelChoice['pricing'], audio = false) {
  if (audio || !pricing || pricing === 'variable') return null;
  const charge = (
    [input, output, cacheRead, cacheWrite, cacheWrite1h]: [number, number, number, number, number],
    rates: ModelPricing,
  ) => {
    const longWrites = pricing.longCacheWrites ? cacheWrite1h : 0;
    return (
      input * rates.input +
      output * rates.output +
      cacheRead * (rates.cacheRead ?? rates.input) +
      (cacheWrite - longWrites) * (rates.cacheWrite ?? rates.input) +
      longWrites * rates.input * 2
    );
  };
  let total = charge(
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cacheWrite1h ?? 0],
    pricing,
  );
  let rates: ModelPricing = pricing;
  let previousThreshold: number | undefined;
  for (const tier of pricing.tiers?.toSorted((a, b) => a.inputTokensAbove - b.inputTokensAbove) ??
    []) {
    if (tier.inputTokensAbove === previousThreshold) continue;
    const above = usage.tokensAbove?.find(([threshold]) => threshold === tier.inputTokensAbove);
    if (!above) return null;
    const [, ...tokens] = above;
    total += charge(tokens, tier) - charge(tokens, rates);
    rates = tier;
    previousThreshold = tier.inputTokensAbove;
  }
  return usage.otherUsd + total / 1e6;
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
  issue?: ModelIssue;
}

export interface ModelIssue {
  reason: string;
}

export interface ModelsResponse {
  connections: ModelConnection[];
  selection: ModelSelection | null;
  selectionIssue?: ModelIssue;
  routes: ModelRoutes;
  backups: ModelSelection[];
  light: ModelSelection | null;
  unpricedPreparationModel?: string;
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
  hostinger: 'Hostinger AI Router',
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
  hostinger: {
    keyUrl: 'hpanel.hostinger.com/ai-router',
    env: 'HOSTINGER_AI_ROUTER_API_KEY',
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
  nvidia: { keyUrl: 'build.nvidia.com', env: 'NVIDIA_API_KEY', catalog: 'account' },
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

import { modelProviderNames, type ModelProvider } from './models.ts';

const keyFormats: { prefix: string; providers: ModelProvider[]; name?: string }[] = [
  { prefix: 'sk-ant-', providers: ['anthropic'] },
  { prefix: 'sk-or-', providers: ['openrouter'] },
  { prefix: 'sk-proj-', providers: ['openai'] },
  { prefix: 'AIza', providers: ['google', 'google-vertex'], name: 'Google' },
  { prefix: 'ABSK', providers: ['amazon-bedrock'] },
  { prefix: 'bedrock-api-key-', providers: ['amazon-bedrock'] },
  { prefix: 'gsk_', providers: ['groq'] },
  { prefix: 'hf_', providers: ['huggingface'] },
  { prefix: 'xai-', providers: ['xai'] },
];

export function modelKeyError(provider: ModelProvider, key: string) {
  if (provider === 'compatible') return;
  const value = key.trim();
  if (value.length < 8 || value.length > 32000)
    return 'Paste the complete API key from your provider.';
  if (/[\s\x00-\x1f\x7f-\x9f]/.test(value))
    return 'API keys cannot contain spaces or control characters. Paste the key again.';
  const format = keyFormats.find(({ prefix }) => value.startsWith(prefix));
  if (format && value.length < format.prefix.length + 8)
    return 'Paste the complete API key from your provider.';
  if (format && !format.providers.includes(provider)) {
    const name = format.name ?? modelProviderNames[format.providers[0]!];
    return `This looks like a key for ${name}. Choose ${name} or enter a key for ${modelProviderNames[provider]}.`;
  }
}

const known: Array<[RegExp, string, string]> = [
  [/gpt-6\.1-sol/i, 'GPT 6.1 Sol', '#10a37f'],
  [/gpt-6\.1/i, 'GPT 6.1', '#10a37f'],
  [/gpt-6-luna/i, 'GPT 6 Luna', '#14b8a6'],
  [/opus-5-5/i, 'Opus 5.5', '#d4572a'],
  [/sonnet-5-5/i, 'Sonnet 5.5', '#f2a65a'],
  [/kimi-k3/i, 'Kimi K3', '#0f172a'],
  [/deepseek.*v4\.1/i, 'DeepSeek V4.1', '#4d6bfe'],
  [/qwen3\.8/i, 'Qwen 3.8', '#7c3aed'],
  [/fable-5/i, 'Claude Fable 5.1', '#7c2d12'],
  [/gpt-6-astra/i, 'GPT 6 Astra', '#065f46'],
  [/grok-4\.7/i, 'Grok 4.7', '#6b7280'],
  [/glm-5\.3/i, 'GLM 5.3', '#be185d'],
  [/gemini-3\.8-flash/i, 'Gemini 3.8 Flash', '#0891b2'],
  [/space-bunny/i, 'Space Bunny', '#eab308'],
];
const fallback = ['#0891b2', '#be185d', '#65a30d', '#b45309', '#475569'];

export function displayName(model: string) {
  const id = model.split('/').slice(-1)[0];
  return known.find(([pattern]) => pattern.test(model))?.[1] ?? id;
}

export function colorFor(model: string, index: number) {
  return known.find(([pattern]) => pattern.test(model))?.[2] ?? fallback[index % fallback.length];
}

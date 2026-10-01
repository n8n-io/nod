import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { relevanceModel } from '../../shared/model-defaults.ts';

export function createJsonCompletion(options: {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}) {
  const request = options.fetch ?? fetch;
  const model = options.model || relevanceModel;
  const capabilities = openaiProvider()
    .getModels()
    .find((entry) => entry.id === model);
  const reasoningOff = capabilities?.reasoning && capabilities.thinkingLevelMap?.off === 'none';
  const parameters = reasoningOff
    ? { reasoning_effort: 'none', temperature: 0 }
    : capabilities?.reasoning === false
      ? { temperature: 0 }
      : {};
  return async (call: {
    instructions: string;
    input: object;
    maxTokens: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<unknown> => {
    call.signal?.throwIfAborted();
    if (!options.apiKey) throw new Error('The model is not configured.');
    const response = await request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.any([
        AbortSignal.timeout(call.timeoutMs),
        ...(call.signal ? [call.signal] : []),
      ]),
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        ...parameters,
        max_completion_tokens: call.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: call.instructions },
          { role: 'user', content: JSON.stringify(call.input) },
        ],
      }),
    });
    if (!response.ok) throw new Error('The model is unavailable.');
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    try {
      return JSON.parse(data.choices?.[0]?.message?.content || '');
    } catch {
      return null;
    }
  };
}

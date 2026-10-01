import type { MemoryCurator } from '../../ports/memory-curator.ts';
import { createJsonCompletion } from './json-completion.ts';

export function createOpenAIMemoryCurator(options: {
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}): MemoryCurator {
  const complete = createJsonCompletion(options);
  return {
    id: 'openai',
    configured: Boolean(options.apiKey),
    curate: ({ instructions, input }, signal) =>
      complete({ instructions, input, maxTokens: 2048, timeoutMs: 45_000, signal }),
  };
}

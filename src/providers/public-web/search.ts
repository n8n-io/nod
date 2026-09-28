import { search } from 'pi-web-access/gemini-search.ts';
import type { WebSearch } from '../../ports/web-search.ts';

export function createWebSearch(run: typeof search = search): WebSearch {
  return async (query, signal) => {
    try {
      const response = await run(query, { numResults: 8, signal });
      return {
        source: response.provider,
        ...(response.answer ? { answer: response.answer.slice(0, 3000) } : {}),
        results: response.results
          .filter((item) => {
            try {
              const url = new URL(item.url);
              return (
                item.url.length <= 2048 &&
                ['http:', 'https:'].includes(url.protocol) &&
                !url.username &&
                !url.password
              );
            } catch {
              return false;
            }
          })
          .slice(0, 8)
          .map((item) => ({
            title: item.title.slice(0, 200),
            url: item.url,
            snippet: item.snippet.slice(0, 600),
          })),
      };
    } catch {
      signal.throwIfAborted();
      throw new Error('Web search is unavailable. Try the browser.');
    }
  };
}

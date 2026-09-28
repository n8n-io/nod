import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebSearch } from '../src/providers/public-web/search.ts';

test('web search bounds public results and hides provider errors', async () => {
  const signal = new AbortController().signal;
  const search = createWebSearch(async (query, options) => {
    assert.equal(query, 'public documentation');
    assert.ok(options);
    assert.equal(options.numResults, 8);
    assert.equal(options.signal, signal);
    return {
      provider: 'exa',
      answer: 'a'.repeat(4000),
      results: [
        { title: 'private', url: 'https://user:secret@example.com/', snippet: 'hidden' },
        { title: 'too long', url: `https://example.com/${'x'.repeat(2048)}`, snippet: 'hidden' },
        ...Array.from({ length: 10 }, (_, index) => ({
          title: `result ${index}`.padEnd(250, 'x'),
          url: `https://example.com/${index}`,
          snippet: 's'.repeat(700),
        })),
      ],
    };
  });
  const result = await search('public documentation', signal);
  assert.equal(result.source, 'exa');
  assert.equal(result.answer?.length, 3000);
  assert.equal(result.results.length, 8);
  assert.equal(result.results[0]?.title.length, 200);
  assert.equal(result.results[0]?.snippet.length, 600);
  assert.ok(result.results.every((item) => !item.url.includes('secret')));
  assert.ok(result.results.every((item) => !item.url.includes('x'.repeat(100))));

  const failing = createWebSearch(async () => {
    throw new Error('private provider detail');
  });
  await assert.rejects(failing('public documentation', signal), {
    message: 'Web search is unavailable. Try the browser.',
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(failing('public documentation', controller.signal), {
    name: 'AbortError',
  });
});

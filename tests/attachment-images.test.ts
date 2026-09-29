import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Artifact, Message } from '../src/shared/contracts.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { MessageBubble } = await import('../src/web/components/message.tsx');
const { default: AttachmentData } = await import('../src/web/components/attachment-data.tsx');
const { artifactImage, artifactPreview, ImageGallery, ImageViewer } =
  await import('../src/web/components/attachment-images.tsx');
const click = (element: Element) =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const pictures: Artifact[] = Array.from({ length: 6 }, (_, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  name: `Picture ${index + 1}.png`,
  mimeType: 'image/png',
  size: 2048,
  url: `/api/artifacts/00000000-0000-4000-8000-00000000000${index}`,
}));

test('sent images form a capped gallery with overflow, preserve files, and share a keyboard-accessible details viewer', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const message: Message = {
    id: 'fixture',
    role: 'user',
    text: '',
    taskId: 'fixture-task',
    createdAt: '2026-09-25T12:00:00Z',
    attachments: [
      ...pictures,
      {
        ...pictures[0],
        id: 'a',
        name: 'notes.zip',
        mimeType: 'application/zip',
        url: '/api/artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    ],
  };
  try {
    await act(async () => root.render(createElement(MessageBubble, { message })));
    assert.equal(container.querySelectorAll('.attachment-image-tile').length, 4);
    assert.equal(container.querySelector('.attachment-image-more')?.textContent, '+2');
    assert.doesNotMatch(container.textContent ?? '', /Picture 1/);
    assert.match(container.querySelector('.attachment-file')?.textContent ?? '', /notes.zip/);
    assert.equal(
      container.querySelector('.attachment-file')?.getAttribute('href'),
      '/api/artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const first = container.querySelector<HTMLButtonElement>('[aria-label="View image 1 of 6"]')!;
    await act(async () => {
      click(first);
      await tick();
    });
    const viewer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(viewer);
    assert.equal(viewer.querySelector('h2')?.textContent, 'Picture 1.png');
    assert.ok(viewer.querySelector('h2')?.classList.contains('sr-only'));
    assert.doesNotMatch(
      viewer.querySelector('.attachment-viewer-footer')?.textContent ?? '',
      /Picture|KB/,
    );
    const surface = viewer.querySelector<HTMLElement>('.attachment-viewer-surface')!;
    assert.equal(document.activeElement, surface);
    assert.equal(
      viewer.querySelector('[aria-label="Previous image"]')?.getAttribute('aria-disabled'),
      'true',
    );
    for (const [key, expected] of [
      ['ArrowRight', 2],
      ['End', 6],
      ['ArrowRight', 6],
      ['ArrowLeft', 5],
      ['Home', 1],
    ] as const) {
      await act(async () =>
        viewer.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
      );
      assert.equal(viewer.querySelector('img')?.getAttribute('src'), pictures[expected - 1].url);
      assert.equal(viewer.querySelector('[role="status"]')?.textContent, `${expected} / 6`);
      assert.equal(document.activeElement, surface);
    }
    assert.equal(viewer.querySelector('a[download]')?.getAttribute('href'), pictures[0].url);
    await act(async () => {
      viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick();
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, first);
    await act(async () => {
      click(container.querySelector('[aria-label="View image 4 of 6"]')!);
      await tick();
    });
    assert.equal(
      document.querySelector('.attachment-image-viewer h2')?.textContent,
      'Picture 4.png',
    );
    await act(async () => {
      click(document.querySelector('.attachment-image-viewer [aria-label="Close"]')!);
      await tick();
    });
    assert.equal(
      document.activeElement,
      container.querySelector('[aria-label="View image 4 of 6"]'),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('mixed owned media keep visual tiles in the gallery, documents in cards and native media keys', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const media: Artifact[] = [
    'image/png',
    'audio/mpeg',
    'application/pdf',
    'video/mp4',
    'image/gif',
  ].map((mimeType, index) => ({ ...pictures[index], mimeType }));
  const message: Message = {
    id: 'mixed-media',
    role: 'assistant',
    taskId: 'mixed-media-task',
    text: '',
    createdAt: '2026-09-25T12:00:00Z',
    attachments: media,
  };
  try {
    await act(async () => root.render(createElement(MessageBubble, { message })));
    assert.equal(container.querySelectorAll('.attachment-image-tile').length, 3);
    assert.equal(container.querySelector('.attachment-image-more'), null);
    assert.ok(container.querySelector('.attachment-card.is-audio'));
    assert.ok(container.querySelector('.attachment-card.is-pdf'));
    assert.equal(container.querySelector('.attachment-file'), null);
    const card = container.querySelector<HTMLButtonElement>('.is-audio .attachment-card-open')!;
    await act(async () => {
      click(card);
      await tick();
    });
    let viewer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const audio = viewer.querySelector('audio')!;
    assert.ok(audio.controls);
    assert.equal(audio.getAttribute('src'), media[1].url);
    assert.equal(audio.preload, 'metadata');
    assert.equal(audio.autoplay, false);
    await act(async () => {
      audio.focus();
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      });
      audio.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
    });
    assert.equal(viewer.querySelector('[role="status"]')?.textContent, '1 / 2');
    let surface = viewer.querySelector<HTMLElement>('.attachment-viewer-surface')!;
    await act(async () => {
      surface.focus();
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    assert.equal(viewer.querySelector('object'), null);
    assert.ok(viewer.querySelector('.attachment-viewer-surface.is-pdf'));
    assert.equal(viewer.querySelector('a[download]')?.getAttribute('href'), media[2].url);
    await act(async () => {
      viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick();
    });
    assert.equal(document.activeElement, card);
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="View attachment 2 of 3"]',
    )!;
    await act(async () => {
      click(trigger);
      await tick();
    });
    viewer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    surface = viewer.querySelector<HTMLElement>('.attachment-viewer-surface')!;
    const video = viewer.querySelector('video')!;
    assert.ok(video.controls);
    assert.equal(video.getAttribute('src'), media[3].url);
    assert.equal(video.preload, 'metadata');
    assert.equal(video.autoplay, false);
    assert.equal(document.activeElement, surface);
    await act(async () => video.dispatchEvent(new Event('error', { bubbles: false })));
    assert.match(viewer.textContent ?? '', /Preview unavailable/);
    assert.equal(viewer.querySelector('a[download]')?.getAttribute('href'), media[3].url);
    const next = viewer.querySelector<HTMLButtonElement>('[aria-label="Next attachment"]')!;
    await act(async () => {
      next.focus();
      next.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    assert.equal(viewer.querySelector('[role="status"]')?.textContent, '3 / 3');
    assert.equal(viewer.querySelector('video'), null);
    assert.equal(viewer.querySelector('img')?.getAttribute('src'), media[4].url);
    assert.equal(next.getAttribute('aria-disabled'), 'true');
    assert.equal(document.activeElement, next);
    await act(async () => {
      next.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick();
    });
    assert.equal(document.activeElement, trigger);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('media previews reject unsafe URLs and active types, including direct viewer inputs', async () => {
  for (const mimeType of ['text/html', 'application/xhtml+xml', 'video/not-real']) {
    assert.equal(artifactPreview({ ...pictures[0], mimeType }), null);
  }
  for (const mimeType of ['application/pdf', 'audio/mp4', 'video/webm', 'image/svg+xml']) {
    assert.ok(artifactPreview({ ...pictures[0], mimeType }));
    for (const url of [
      'https://example.com/file',
      '//example.com/file',
      'data:application/pdf,test',
      '/api/artifacts/abc?token=private',
    ]) {
      assert.equal(artifactPreview({ ...pictures[0], mimeType, url }), null);
    }
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const item of [
      { ...pictures[0], mimeType: 'application/pdf', url: 'https://example.com/document.pdf' },
      { ...pictures[0], mimeType: 'text/html' },
      { ...pictures[0], mimeType: 'video/mp4', url: 'blob:untrusted' },
      { ...pictures[0], mimeType: 'image/svg+xml', url: 'blob:local-vector', local: true },
    ]) {
      await act(async () =>
        root.render(
          createElement(ImageViewer, {
            images: [item],
            selectedId: item.id,
            onSelect() {},
            onClose() {},
            restoreFocus() {},
            allowLocalPreviews: 'local' in item,
          }),
        ),
      );
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.equal(container.querySelector('img,audio,video,object,iframe'), null);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('owned Markdown and CSV open readable previews with safe links and exact table cells', async () => {
  const originalFetch = globalThis.fetch;
  const markdown: Artifact = {
    ...pictures[0],
    name: 'brief.md',
    mimeType: 'text/markdown',
    url: '/api/artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  const csv: Artifact = {
    ...pictures[1],
    name: 'values.csv',
    mimeType: 'text/csv',
    url: '/api/artifacts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  globalThis.fetch = async (input) =>
    new Response(
      String(input).includes(markdown.url)
        ? '# Brief\n\n| Tool | Result |\n| --- | --- |\n| One | [Source](https://example.com) |\n<script>window.bad = true</script>'
        : 'Company,Note,Source\r\nA,"first, second",https://example.com/research?year=2024&country=DEU\r\nB,"two\nlines",javascript:alert(1)\r\nC,official pages,https://one.example/source;https://two.example/source\r\nD,""',
    );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const message: Message = {
    id: 'document-preview',
    role: 'assistant',
    taskId: 'document-preview-task',
    text: '',
    createdAt: '2026-09-25T12:00:00Z',
    attachments: [markdown, csv],
  };
  try {
    await act(async () => root.render(createElement(MessageBubble, { message })));
    assert.equal(container.querySelectorAll('.attachment-image-tile').length, 0);
    assert.equal(
      container.querySelectorAll('.attachment-cards > .is-markdown, .attachment-cards > .is-csv')
        .length,
      2,
    );
    await act(async () => {
      click(container.querySelector('.is-markdown .attachment-card-open')!);
      await tick();
    });
    let viewer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.match(viewer.textContent ?? '', /Brief/);
    assert.equal(viewer.querySelector('.attachment-markdown script'), null);
    assert.equal(
      viewer.querySelector('.attachment-markdown a')?.getAttribute('href'),
      'https://example.com/',
    );
    assert.equal(viewer.querySelector('a[download]')?.getAttribute('href'), markdown.url);
    await act(async () => {
      click(viewer.querySelector('[aria-label="Next attachment"]')!);
      await tick();
    });
    viewer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.match(viewer.textContent ?? '', /4 rows/);
    assert.deepEqual(
      Array.from(viewer.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent),
      ),
      [
        ['A', 'first, second', 'example.com'],
        ['B', 'two\nlines', 'javascript:alert(1)'],
        ['C', 'official pages', 'one.exampletwo.example'],
        ['D', '', ''],
      ],
    );
    const source = viewer.querySelector<HTMLAnchorElement>('.attachment-table-link')!;
    assert.equal(source.href, 'https://example.com/research?year=2024&country=DEU');
    assert.equal(source.title, source.href);
    assert.equal(source.target, '_blank');
    assert.equal(source.rel, 'noopener noreferrer');
    assert.deepEqual(
      Array.from(viewer.querySelectorAll<HTMLAnchorElement>('.attachment-table-link')).map(
        (link) => link.href,
      ),
      [
        'https://example.com/research?year=2024&country=DEU',
        'https://one.example/source',
        'https://two.example/source',
      ],
    );
    assert.equal(viewer.querySelector('a[download]')?.getAttribute('href'), csv.url);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test('large CSV previews keep the visible rows, columns and cells bounded', async () => {
  const originalFetch = globalThis.fetch;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  globalThis.fetch = async () =>
    new Response(
      [
        Array.from({ length: 120 }, (_, index) => `Column ${index}`).join(','),
        ...Array.from({ length: 300 }, (_, index) =>
          [index === 0 ? 'x'.repeat(20_000) : String(index), ...Array(119).fill('value')].join(','),
        ),
      ].join('\n'),
    );
  try {
    await act(async () => {
      root.render(
        createElement(AttachmentData, {
          url: '/api/artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: 'large.csv',
          kind: 'csv',
          size: 100_000,
        }),
      );
      await tick();
    });
    assert.equal(container.querySelectorAll('tbody tr').length, 200);
    assert.equal(container.querySelectorAll('thead th').length, 100);
    assert.equal(container.querySelector('tbody td')?.textContent?.length, 10_000);
    assert.match(container.textContent ?? '', /Showing the first 200 rows/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test('gallery sources accept owned raster images and reject remote, private and active document URLs', async () => {
  for (const url of [
    'https://example.com/image.png',
    'javascript:alert(1)',
    '/credentials/private',
    '/api/artifacts/abc?token=private',
  ])
    assert.equal(artifactImage({ ...pictures[0], url }), null);
  const vector = artifactImage({ ...pictures[0], mimeType: 'image/svg+xml' });
  assert.ok(vector);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(ImageGallery, {
          images: [{ ...pictures[0], url: 'https://example.com/remote.png' }],
        }),
      ),
    );
    assert.equal(container.querySelector('img'), null);
    assert.equal(container.querySelector('button'), null);
    await act(async () => root.render(createElement(ImageGallery, { images: [vector] })));
    const image = container.querySelector('img')!;
    assert.equal(image.getAttribute('src'), pictures[0].url);
    assert.ok(image.classList.contains('is-vector'));
    assert.equal(container.querySelector('svg,object,iframe,embed'), null);
    await act(async () => {
      click(container.querySelector('button')!);
      await tick();
    });
    const viewer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(viewer.querySelector('.attachment-viewer-surface img.is-vector'));
    assert.equal(viewer.querySelector('.attachment-viewer-surface svg,object,iframe,embed'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

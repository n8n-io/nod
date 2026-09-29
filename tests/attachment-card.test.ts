import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { Artifact } from '../src/shared/contracts.ts';
import type { PreviewPdfLoading } from '../src/web/components/attachment-pdf.tsx';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLCanvasElement',
  'Element',
  'Node',
  'Event',
  'NodeFilter',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({}),
});
const observers: Array<{ callback: IntersectionObserverCallback; observed: Element[] }> = [];
class FakeIntersectionObserver {
  entry: { callback: IntersectionObserverCallback; observed: Element[] };
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, observed: [] };
    observers.push(this.entry);
  }
  observe(target: Element) {
    this.entry.observed.push(target);
  }
  disconnect() {
    this.entry.observed = [];
  }
}
Object.defineProperty(globalThis, 'IntersectionObserver', {
  configurable: true,
  value: FakeIntersectionObserver,
});
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { MessageAttachments, fileSize, fileType } =
  await import('../src/web/components/attachment-card.tsx');
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const artifact = (index: number, name: string, mimeType: string, size = 2048): Artifact => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  name,
  mimeType,
  size,
  url: `/api/artifacts/00000000-0000-4000-8000-00000000000${index}`,
});
const pdf = artifact(1, 'Quarterly plan.pdf', 'application/pdf', 48_000);
const svg = artifact(2, 'Diagram.svg', 'image/svg+xml');
const photo = artifact(3, 'Harbour.jpg', 'image/jpeg', 1_400_000);
const zip = artifact(4, 'Sources.zip', 'application/zip');
const audio = artifact(5, 'Voice note.mp3', 'audio/mpeg');

function fakeLoader(pages = 3) {
  const calls: string[] = [];
  const painted: number[] = [];
  let destroyed = 0;
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => {
      painted.push(1);
      return { promise: Promise.resolve(), cancel() {} } as unknown as RenderTask;
    },
  } as unknown as PDFPageProxy;
  const loadDocument = async (url: string): Promise<PreviewPdfLoading> => {
    calls.push(url);
    return {
      promise: Promise.resolve({ numPages: pages, getPage: async () => page }),
      destroy: async () => {
        destroyed++;
      },
    };
  };
  return { loadDocument, calls, painted, destroyed: () => destroyed };
}

async function mount(attachments: Artifact[], loadDocument?: ReturnType<typeof fakeLoader>) {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      createElement(MessageAttachments, {
        attachments,
        ...(loadDocument ? { loadDocument: loadDocument.loadDocument } : {}),
      }),
    ),
  );
  return {
    element,
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

test('attachments split into an image gallery, document cards and compact file rows', async () => {
  observers.length = 0;
  const loader = fakeLoader();
  const f = await mount([pdf, svg, photo, zip], loader);
  try {
    const tiles = f.element.querySelectorAll('.attachment-image-gallery .attachment-image-tile');
    assert.equal(tiles.length, 2);
    const vector = f.element.querySelector<HTMLImageElement>(
      '.attachment-image-tile img.is-vector',
    )!;
    assert.equal(vector.getAttribute('src'), svg.url);
    assert.equal(f.element.querySelector(`object,iframe,embed,img[src="${pdf.url}"]`), null);
    const card = f.element.querySelector('.attachment-cards > .attachment-card.is-pdf')!;
    assert.match(card.textContent ?? '', /Quarterly plan\.pdf/);
    assert.match(card.textContent ?? '', /PDF · 47 KB/);
    assert.equal(card.querySelector('a[download]')?.getAttribute('href'), pdf.url);
    const file = f.element.querySelector<HTMLAnchorElement>(
      '.attachment-cards > a.attachment-file',
    )!;
    assert.equal(file.getAttribute('href'), zip.url);
    assert.equal(file.getAttribute('download'), zip.name);
    assert.match(file.textContent ?? '', /Sources\.zip/);
    assert.match(file.textContent ?? '', /ZIP · 2 KB/);
    assert.equal(fileSize(1_400_000), '1.3 MB');
    assert.equal(fileType('archive'), 'File');
  } finally {
    await f.close();
  }
});

test('PDF cards draw the first page only after the card scrolls into view, then free the document', async () => {
  observers.length = 0;
  const loader = fakeLoader();
  const f = await mount([pdf], loader);
  try {
    assert.deepEqual(loader.calls, []);
    assert.equal(f.element.querySelector('canvas'), null);
    const observer = observers.at(-1)!;
    const preview = f.element.querySelector('.attachment-card-preview')!;
    assert.deepEqual(observer.observed, [preview]);
    assert.equal(preview.getAttribute('aria-hidden'), 'true');
    await act(async () => {
      observer.callback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      await tick();
    });
    assert.deepEqual(loader.calls, []);
    await act(async () => {
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      await tick();
    });
    assert.deepEqual(loader.calls, [pdf.url]);
    assert.deepEqual(loader.painted, [1]);
    const canvas = f.element.querySelector<HTMLCanvasElement>('.attachment-card-preview canvas')!;
    assert.equal(canvas.hidden, false);
    assert.match(f.element.textContent ?? '', /PDF · 3 pages · 47 KB/);
    assert.equal(loader.destroyed(), 1);
  } finally {
    await f.close();
  }
  assert.equal(loader.destroyed(), 1);
});

test('PDF cards fall back to the compact row when the thumbnail cannot load', async () => {
  observers.length = 0;
  const loadDocument = async (): Promise<PreviewPdfLoading> => {
    throw new Error('PDF worker unavailable.');
  };
  const f = await mount([pdf], { ...fakeLoader(), loadDocument });
  try {
    await act(async () => {
      observers
        .at(-1)!
        .callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      await tick();
    });
    assert.equal(f.element.querySelector('.attachment-card-preview'), null);
    assert.match(f.element.textContent ?? '', /Quarterly plan\.pdf/);
  } finally {
    await f.close();
  }
});

test('document cards open the shared viewer and return focus to the card', async () => {
  observers.length = 0;
  const f = await mount([audio, pdf], fakeLoader(1));
  try {
    const open = f.element.querySelector<HTMLButtonElement>('.is-audio .attachment-card-open')!;
    assert.equal(f.element.querySelector('.is-audio .attachment-card-preview'), null);
    assert.match(open.textContent ?? '', /MP3 · 2 KB/);
    await act(async () => {
      open.click();
      await tick();
    });
    const viewer = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(viewer.querySelector('audio')?.getAttribute('src'), audio.url);
    assert.equal(viewer.querySelector('[role="status"]')?.textContent, '1 / 2');
    await act(async () => {
      viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick();
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, open);
  } finally {
    await f.close();
  }
});

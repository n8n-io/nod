import { apiResponse } from './api';
import { ownedArtifactUrl } from './attachment-url';

export function selectedText(element: HTMLElement | null) {
  const selection = window.getSelection();
  return element &&
    selection &&
    !selection.isCollapsed &&
    element.contains(selection.anchorNode) &&
    element.contains(selection.focusNode)
    ? selection.toString()
    : '';
}

export async function copyContent(text: string, element?: HTMLElement | null) {
  const table = element?.matches('table') ? element : null;
  if (table)
    text = Array.from(table.querySelectorAll('tr'))
      .map((row) =>
        Array.from(row.querySelectorAll('th,td'))
          .map((cell) => (cell.textContent ?? '').replace(/[\t\n]+/g, ' '))
          .join('\t'),
      )
      .join('\n');
  if (element && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
    const clone = element.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('button,time,.copy-block,.browser-handoff,.setup-actions')
      .forEach((node) => node.remove());
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([clone.outerHTML], { type: 'text/html' }),
      }),
    ]);
  } else await navigator.clipboard.writeText(text);
}

export async function copyImage(url: string) {
  if (!ownedArtifactUrl(url)) throw new Error('This image is unavailable.');
  const png = (async () => {
    const response = await apiResponse(url);
    if (!response.ok) throw new Error('The image could not be loaded.');
    const blob = await response.blob();
    if (!/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(blob.type))
      throw new Error('Download this image to use its original format.');
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image copying is unavailable.');
      context.drawImage(bitmap, 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('The image could not be copied.'))),
          'image/png',
        ),
      );
    } finally {
      bitmap.close();
    }
  })();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

import { attachmentKind } from '../../shared/attachment-kind';

export { attachmentKind } from '../../shared/attachment-kind';

export function vectorImage(mimeType: string, name = '') {
  return mimeType.split(';', 1)[0].trim().toLowerCase() === 'image/svg+xml' || /\.svg$/i.test(name);
}

export function localPreviewable(mimeType: string, name = '') {
  const kind = attachmentKind(mimeType, name);
  return (
    Boolean(kind) &&
    kind !== 'html' &&
    kind !== 'sticker' &&
    !/^(?:text\/html|image\/svg\+xml|(?:text|application)\/(?:[\w.-]+\+)?xml)$/.test(
      mimeType.split(';', 1)[0].trim().toLowerCase(),
    ) &&
    !/\.(?:html?|svg|xml|xht|xhtml|xsl|xslt)$/i.test(name)
  );
}

export function previewableImage(mimeType: string, name = '') {
  return attachmentKind(mimeType, name) === 'image';
}

export function fileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileType(name: string) {
  if (/\.n8n\.json$/i.test(name)) return 'n8n workflow';
  return /\.([a-z0-9]{1,10})$/i.exec(name)?.[1].toUpperCase() ?? 'File';
}

export const textPreviewBytes = 4_000_000;

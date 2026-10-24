export type AttachmentKind =
  | 'image'
  | 'sticker'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'markdown'
  | 'html'
  | 'csv'
  | 'spreadsheet'
  | 'document'
  | 'presentation'
  | 'archive'
  | 'n8n-workflow'
  | 'text';

const extensionKinds: Record<string, AttachmentKind> = {
  tgs: 'sticker',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  csv: 'csv',
  tsv: 'csv',
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  xls: 'spreadsheet',
  ods: 'spreadsheet',
  docx: 'document',
  pptx: 'presentation',
  zip: 'archive',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  ogv: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  ...Object.fromEntries(
    ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'].map((value) => [value, 'image']),
  ),
  ...Object.fromEntries(
    (
      'txt log json jsonl ndjson xml yaml yml toml ini cfg conf env js mjs cjs jsx ts tsx py rb ' +
      'go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish ps1 sql css scss sass less ' +
      'graphql gql vue svelte r lua pl dart scala ex exs erl hs clj tf hcl proto diff patch srt ' +
      'vtt ics vcf rst tex bib'
    )
      .split(' ')
      .map((value) => [value, 'text']),
  ),
};

function kindFromType(type: string): AttachmentKind | null {
  if (type === 'application/x-tgsticker') return 'sticker';
  if (/^image\/(?:png|jpeg|webp|gif|avif|bmp|svg\+xml)$/.test(type)) return 'image';
  if (/^audio\/(?:mpeg|wav|x-wav|webm|ogg|mp4|aac|flac|x-m4a)$/.test(type)) return 'audio';
  if (/^video\/(?:mp4|webm|ogg|quicktime)$/.test(type)) return 'video';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (['text/csv', 'application/csv', 'text/tab-separated-values'].includes(type)) return 'csv';
  if (
    /^application\/(?:vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-excel(?:\.sheet\.macroenabled\.12)?|vnd\.oasis\.opendocument\.spreadsheet)$/.test(
      type,
    )
  )
    return 'spreadsheet';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    return 'document';
  if (type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    return 'presentation';
  if (type === 'application/zip' || type === 'application/x-zip-compressed') return 'archive';
  if (
    type.startsWith('text/') ||
    /^application\/(?:json|ld\+json|xml|ya?ml|x-yaml|javascript|x-sh|sql|toml)$/.test(type)
  )
    return 'text';
  return null;
}

export function attachmentKind(mimeType: string, name = ''): AttachmentKind | null {
  const type = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (/\.n8n\.json$/i.test(name)) return 'n8n-workflow';
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
  return Object.hasOwn(extensionKinds, extension) ? extensionKinds[extension] : kindFromType(type);
}

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

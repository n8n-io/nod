export const fileBytes = 90 * 1024 * 1024;

const nameBytes = 255;
const utf8 = new TextEncoder();

export function fileName(name: string) {
  if (utf8.encode(name).byteLength <= nameBytes) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  let room = nameBytes - utf8.encode(extension).byteLength;
  let stem = '';
  for (const character of name.slice(0, name.length - extension.length)) {
    room -= utf8.encode(character).byteLength;
    if (room < 0) break;
    stem += character;
  }
  return stem + extension;
}

export function stagedWorkspaceFile(id: string, name: string) {
  if (
    !id ||
    /[/\\\u0000-\u001f\u007f]/.test(id) ||
    id === '.' ||
    id === '..' ||
    utf8.encode(id).byteLength > nameBytes
  )
    throw new Error('A staged file identifier is required.');
  const clean = name
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .split('/')
    .at(-1)!
    .replace(/[\u0000-\u001f\u007f]/g, '');
  const bounded = fileName(clean);
  const safe = !bounded.trim() || bounded === '.' || bounded === '..' ? 'file' : bounded;
  return `${id}/${safe}`;
}

export function isUploadFileName(name: string) {
  return (
    Boolean(name.trim()) &&
    !/[/\\\u0000-\u001f\u007f]/.test(name) &&
    name !== '.' &&
    name !== '..' &&
    utf8.encode(name).byteLength <= nameBytes
  );
}

export function uploadFileName(name: string) {
  if (!isUploadFileName(name)) throw new Error('A plain upload filename is required.');
  return name;
}

const mimeTypes: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.vcf': 'text/vcard',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.ogv': 'video/ogg',
  '.html': 'text/html',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function fileMimeType(name: string) {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && mimeTypes[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

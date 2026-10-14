export const fileBytes = 90 * 1024 * 1024;

const nameBytes = 255 - 37;

export function fileName(name: string) {
  const encoder = new TextEncoder();
  if (encoder.encode(name).byteLength <= nameBytes) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  let room = nameBytes - encoder.encode(extension).byteLength;
  let stem = '';
  for (const character of name.slice(0, name.length - extension.length)) {
    room -= encoder.encode(character).byteLength;
    if (room < 0) break;
    stem += character;
  }
  return stem + extension;
}

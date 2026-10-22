import { textPreviewBytes } from './attachment-kind';

export const stickerBytes = 64 * 1024;

export async function decodeSticker(bytes: Uint8Array, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > stickerBytes) throw new Error('Sticker preview unavailable.');
  const reader = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > textPreviewBytes) throw new Error('Sticker preview unavailable.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.length;
  }
  const animation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
  if (
    !animation ||
    !Array.isArray(animation.layers) ||
    ![animation.w, animation.h, animation.fr, animation.ip, animation.op].every(Number.isFinite) ||
    animation.w <= 0 ||
    animation.w > 512 ||
    animation.h <= 0 ||
    animation.h > 512 ||
    animation.fr <= 0 ||
    animation.fr > 60 ||
    animation.op <= animation.ip ||
    animation.op - animation.ip > animation.fr * 3 ||
    (animation.fonts && !(Array.isArray(animation.fonts.list) && !animation.fonts.list.length)) ||
    (animation.chars && !(Array.isArray(animation.chars) && !animation.chars.length)) ||
    (animation.segments && !(Array.isArray(animation.segments) && !animation.segments.length)) ||
    (animation.slots &&
      (typeof animation.slots !== 'object' ||
        Array.isArray(animation.slots) ||
        Object.keys(animation.slots).length > 0))
  )
    throw new Error('Sticker preview unavailable.');
  const pending: Array<{ value: unknown; depth: number }> = [{ value: animation, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > 64) throw new Error('Sticker preview unavailable.');
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (
      (!Array.isArray(value) && Object.hasOwn(value, 'length')) ||
      (typeof record.ty === 'string' &&
        !['gr', 'tr', 'sh', 'el', 'rc', 'fl', 'st', 'gf', 'tm', 'rd'].includes(record.ty)) ||
      (typeof record.ty === 'number' && ![0, 3, 4].includes(record.ty)) ||
      (typeof record.ty === 'number' && Object.hasOwn(record, 'layers')) ||
      (record.ef && (!Array.isArray(record.ef) || record.ef.length > 0)) ||
      (record.masksProperties &&
        (!Array.isArray(record.masksProperties) || record.masksProperties.length > 0)) ||
      record.ddd === 1
    )
      throw new Error('Sticker preview unavailable.');
    if (record.g && typeof record.g === 'object') {
      const stops = (record.g as { p?: unknown }).p;
      if (
        typeof stops !== 'number' ||
        !Number.isSafeInteger(stops) ||
        stops < 1 ||
        stops * 4 + nodes > 100_000
      )
        throw new Error('Sticker preview unavailable.');
      nodes += stops * 4;
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const child = (value as Record<string, unknown>)[key];
      if (++nodes > 100_000) throw new Error('Sticker preview unavailable.');
      if (
        key.startsWith('__') ||
        ['prototype', 'constructor', 'completed'].includes(key) ||
        (['tt', 'tp', 'td'].includes(key) && child !== 0) ||
        (['w', 'h'].includes(key) &&
          (typeof child === 'string' ||
            (typeof child === 'number' && (child < 0 || child > 512)))) ||
        (typeof child === 'number' && !Number.isFinite(child)) ||
        (key === 'x' && typeof child === 'string')
      )
        throw new Error('Sticker preview unavailable.');
      if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 });
    }
  }
  if (
    animation.assets &&
    (!Array.isArray(animation.assets) ||
      animation.assets.some(
        (asset: Record<string, unknown>) =>
          !asset || asset.p !== undefined || asset.u !== undefined,
      ))
  )
    throw new Error('Sticker preview unavailable.');
  const assets = new Map<string, unknown>();
  const compositions: Array<Array<Record<string, unknown>>> = [animation.layers];
  for (const asset of animation.assets ?? []) {
    if (typeof asset.id !== 'string' || assets.has(asset.id) || !Array.isArray(asset.layers))
      throw new Error('Sticker preview unavailable.');
    assets.set(asset.id, asset);
    compositions.push(asset.layers);
  }
  for (const layers of compositions) {
    const indices = new Map<number, Record<string, unknown>>();
    for (const layer of layers) {
      if (!layer || typeof layer !== 'object' || Array.isArray(layer))
        throw new Error('Sticker preview unavailable.');
      if (layer.ind !== undefined) {
        if (
          typeof layer.ind !== 'number' ||
          !Number.isSafeInteger(layer.ind) ||
          indices.has(layer.ind)
        )
          throw new Error('Sticker preview unavailable.');
        indices.set(layer.ind, layer);
      }
    }
    for (const layer of layers) {
      const parents = new Set([layer]);
      let current = layer;
      while (current.parent !== undefined) {
        if (typeof current.parent !== 'number' || !Number.isSafeInteger(current.parent))
          throw new Error('Sticker preview unavailable.');
        const parent = indices.get(current.parent);
        if (!parent || parents.has(parent) || parents.size >= 64)
          throw new Error('Sticker preview unavailable.');
        parents.add(parent);
        current = parent;
      }
    }
  }
  let expanded = 0;
  const expand = (
    value: unknown,
    depth: number,
    references: Set<string>,
    shapes = false,
  ): number => {
    expanded += typeof value === 'string' ? value.length + 1 : 1;
    if (expanded > 100_000 || depth > 64) throw new Error('Sticker preview unavailable.');
    let work = typeof value === 'string' ? value.length + 1 : 1;
    if (!value || typeof value !== 'object') return work;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'refId') {
        if (typeof child !== 'string' || references.has(child) || !assets.has(child))
          throw new Error('Sticker preview unavailable.');
        work += expand(assets.get(child), depth + 1, new Set([...references, child]));
      } else work += expand(child, depth + 1, references, key === 'shapes' || key === 'it');
      if (work > 100_000) throw new Error('Sticker preview unavailable.');
    }
    if (shapes && Array.isArray(value)) {
      work *= 1 + value.filter((shape) => ['fl', 'st', 'gf'].includes(shape?.ty)).length;
      for (const shape of value) {
        if (shape?.ty === 'rd') work *= 3;
        if (shape?.ty === 'tm') work *= 5;
        if (work > 100_000) throw new Error('Sticker preview unavailable.');
      }
    }
    if (work > 100_000) throw new Error('Sticker preview unavailable.');
    return work;
  };
  let work = expand(animation.layers, 0, new Set());
  for (const [id, asset] of assets) work += expand(asset, 0, new Set([id]));
  if (work > 100_000) throw new Error('Sticker preview unavailable.');
  return animation as Record<string, unknown>;
}

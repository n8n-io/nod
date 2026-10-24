import { apiBytes } from './api';
import { ownedArtifactUrl } from './attachment-url';

const oggCrc = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  return crc >>> 0;
});

function boundedOpus(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = (prefix: number[], text: string) =>
    [...text].every((value, index) => prefix[index] === value.charCodeAt(0));
  let offset = 0;
  let serial: number | undefined;
  let sequence = 0;
  let packet = 0;
  let packetSize = 0;
  let prefix: number[] = [];
  let durationMs = 0;
  let ended = false;
  while (offset < bytes.length) {
    if (
      ended ||
      offset + 27 > bytes.length ||
      view.getUint32(offset) !== 0x4f676753 ||
      bytes[offset + 4] !== 0
    )
      return false;
    const pageStart = offset;
    const flags = bytes[offset + 5];
    if (
      flags > 7 ||
      Boolean(flags & 1) !== Boolean(packetSize) ||
      Boolean(flags & 2) !== (packet === 0)
    )
      return false;
    const pageSerial = view.getUint32(offset + 14, true);
    serial ??= pageSerial;
    if (pageSerial !== serial || view.getUint32(offset + 18, true) !== sequence++) return false;
    const granule = view.getBigUint64(offset + 6, true);
    const count = bytes[offset + 26];
    if (offset + 27 + count > bytes.length) return false;
    const lacing = bytes.subarray(offset + 27, offset + 27 + count);
    offset += 27 + count;
    const pageEnd = offset + lacing.reduce((sum, value) => sum + value, 0);
    if (pageEnd > bytes.length) return false;
    let crc = 0;
    for (let index = pageStart; index < pageEnd; index++) {
      const value = index >= pageStart + 22 && index < pageStart + 26 ? 0 : bytes[index];
      crc = ((crc << 8) ^ oggCrc[((crc >>> 24) ^ value) & 255]) >>> 0;
    }
    if (crc !== view.getUint32(pageStart + 22, true)) return false;
    for (const length of lacing) {
      if (offset + length > bytes.length) return false;
      const available = Math.min(length, 19 - prefix.length);
      for (let index = 0; index < available; index++) prefix.push(bytes[offset + index]);
      offset += length;
      packetSize += length;
      if (length === 255) continue;
      if (packet === 0) {
        if (
          packetSize !== 19 ||
          !signature(prefix, 'OpusHead') ||
          prefix[8] !== 1 ||
          ![1, 2].includes(prefix[9]) ||
          prefix[18] !== 0
        )
          return false;
      } else if (packet === 1) {
        if (packetSize < 8 || !signature(prefix, 'OpusTags')) return false;
      } else {
        if (!packetSize) return false;
        const config = prefix[0] >> 3;
        const frameMs =
          config >= 16
            ? 2.5 * 2 ** (config & 3)
            : config >= 12
              ? 10 * 2 ** (config & 1)
              : (config & 3) === 3
                ? 60
                : 10 * 2 ** (config & 3);
        const code = prefix[0] & 3;
        if (code === 3 && packetSize < 2) return false;
        const frames = code === 0 ? 1 : code === 3 ? prefix[1] & 63 : 2;
        const packetMs = frameMs * frames;
        if (!frames || packetMs > 120) return false;
        durationMs += packetMs;
        if (durationMs > 600_000) return false;
      }
      packet++;
      packetSize = 0;
      prefix = [];
    }
    if (granule !== 0xffffffffffffffffn && granule > BigInt(Math.ceil(durationMs * 48) + 65535))
      return false;
    ended = Boolean(flags & 4);
  }
  return ended && packet > 2 && packetSize === 0 && durationMs > 0;
}

let previous: Promise<void> = Promise.resolve();

export function loadAudioWaveform(
  url: string,
  size: number,
  duration: number,
  signal: AbortSignal,
) {
  const load = previous.then(async () => {
    signal.throwIfAborted();
    const limit = 25 * 1024 * 1024;
    if (
      !ownedArtifactUrl(url) ||
      !Number.isFinite(size) ||
      size <= 0 ||
      size > limit ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 600
    )
      throw new Error('Waveform unavailable.');
    const bytes = await apiBytes(url, limit, { signal, redirect: 'error' });
    signal.throwIfAborted();
    if (!boundedOpus(bytes)) throw new Error('Waveform unavailable.');
    const decoded = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(bytes.buffer);
    signal.throwIfAborted();
    if (decoded.duration > 600) throw new Error('Waveform unavailable.');
    const channel = decoded.getChannelData(0);
    const width = channel.length / 64;
    const stride = Math.max(1, Math.floor(width / 256));
    const values = Array.from({ length: 64 }, (_, index) => {
      let sum = 0;
      let count = 0;
      for (let sample = Math.floor(index * width); sample < (index + 1) * width; sample += stride) {
        sum += channel[sample] ** 2;
        count++;
      }
      return Math.sqrt(sum / Math.max(1, count));
    });
    const top = Math.max(...values) || 1;
    return values.map((value) => Math.max(0.08, value / top));
  });
  previous = load.then(
    () => {},
    () => {},
  );
  return load;
}

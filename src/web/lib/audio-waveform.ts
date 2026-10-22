import { apiBytes } from './api';
import { ownedArtifactUrl } from './attachment-url';

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

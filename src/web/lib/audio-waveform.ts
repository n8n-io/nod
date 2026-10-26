import { apiBytes, requestAccountVersion } from './api';
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

function boundedWav(bytes: Uint8Array, view: DataView) {
  if (view.getUint32(8) !== 0x57415645 || view.getUint32(4, true) + 8 !== bytes.length)
    return false;
  let bytesPerSecond = 0;
  let alignment = 0;
  let data = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = view.getUint32(offset);
    const length = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + length > bytes.length) return false;
    if (type === 0x666d7420) {
      if (bytesPerSecond || length < 16) return false;
      let format = view.getUint16(offset, true);
      const channels = view.getUint16(offset + 2, true);
      const rate = view.getUint32(offset + 4, true);
      const bits = view.getUint16(offset + 14, true);
      alignment = view.getUint16(offset + 12, true);
      bytesPerSecond = view.getUint32(offset + 8, true);
      if (format === 0xfffe) {
        if (length < 40) return false;
        const extension = view.getUint16(offset + 16, true);
        const precision = view.getUint16(offset + 18, true);
        const mask = view.getUint32(offset + 20, true);
        format = view.getUint32(offset + 24, true);
        let speakers = 0;
        for (let remaining = mask; remaining; remaining &= remaining - 1) speakers++;
        if (
          extension < 22 ||
          extension > length - 18 ||
          !precision ||
          precision > bits ||
          (format === 3 && precision !== bits) ||
          mask & ~0x3ffff ||
          (speakers && speakers !== channels) ||
          view.getUint32(offset + 28) !== 0x00001000 ||
          view.getUint32(offset + 32) !== 0x800000aa ||
          view.getUint32(offset + 36) !== 0x00389b71
        )
          return false;
      }
      if (
        ![1, 3].includes(format) ||
        ![1, 2].includes(channels) ||
        rate < 8000 ||
        rate > 192000 ||
        !(format === 3 ? [32, 64] : [8, 16, 24, 32]).includes(bits) ||
        alignment !== (channels * bits) / 8 ||
        bytesPerSecond !== rate * alignment
      )
        return false;
    } else if (type === 0x64617461) {
      if (!bytesPerSecond || data || !length || length % alignment) return false;
      data = length;
    }
    offset += length + (length % 2);
  }
  return offset === bytes.length && data > 0 && data / bytesPerSecond <= 600;
}

function boundedMp3(bytes: Uint8Array) {
  let offset = 0;
  if (bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3])) return false;
    let size = 0;
    for (const value of bytes.subarray(6, 10)) {
      if (value & 128) return false;
      size = size * 128 + value;
    }
    offset = 10 + size + (bytes[3] === 4 && bytes[5] & 16 ? 10 : 0);
  }
  const bitrates = [
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ];
  let seconds = 0;
  let format = -1;
  while (offset + 4 <= bytes.length) {
    if (
      bytes.length - offset === 128 &&
      bytes[offset] === 84 &&
      bytes[offset + 1] === 65 &&
      bytes[offset + 2] === 71
    ) {
      offset += 128;
      break;
    }
    const version = (bytes[offset + 1] >> 3) & 3;
    const frequency = (bytes[offset + 2] >> 2) & 3;
    const bitrate = bitrates[version === 3 ? 1 : 0][bytes[offset + 2] >> 4];
    if (
      bytes[offset] !== 255 ||
      (bytes[offset + 1] & 0xe6) !== 0xe2 ||
      version === 1 ||
      frequency === 3 ||
      !bitrate
    )
      return false;
    const nextFormat = version * 4 + frequency;
    if (format !== -1 && format !== nextFormat) return false;
    format = nextFormat;
    const rate = [44100, 48000, 32000][frequency] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const samples = version === 3 ? 1152 : 576;
    offset += Math.floor(((samples / 8) * bitrate * 1000) / rate) + ((bytes[offset + 2] >> 1) & 1);
    seconds += samples / rate;
    if (seconds > 600) return false;
  }
  return seconds > 0 && offset === bytes.length;
}

function boundedM4a(bytes: Uint8Array, view: DataView) {
  type Box = { type: string; start: number; end: number };
  const invalid = () => {
    throw new Error('Waveform unavailable.');
  };
  const boxes = (start: number, end: number) => {
    const result: Box[] = [];
    while (start < end) {
      if (start + 8 > end || result.length >= 256) invalid();
      const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
      let size = view.getUint32(start);
      let header = 8;
      if (size === 1) {
        if (start + 16 > end) invalid();
        size = Number(view.getBigUint64(start + 8));
        header = 16;
      }
      if (!size) size = end - start;
      if (!Number.isSafeInteger(size) || size < header || start + size > end) invalid();
      result.push({ type, start: start + header, end: start + size });
      start += size;
    }
    return result;
  };
  const one = (items: Box[], type: string) => {
    const found = items.filter((item) => item.type === type);
    if (found.length !== 1) invalid();
    return found[0];
  };
  const children = (box: Box) => boxes(box.start, box.end);
  const clock = (box: Box) => {
    const version = bytes[box.start];
    if (version > 1 || box.end - box.start < (version ? 32 : 20)) invalid();
    const rate = view.getUint32(box.start + (version ? 20 : 12));
    const length = version
      ? Number(view.getBigUint64(box.start + 24))
      : view.getUint32(box.start + 16);
    if (!rate || !Number.isSafeInteger(length) || length <= 0 || length / rate > 600) invalid();
    return rate;
  };
  const root = boxes(0, bytes.length);
  if (root.some((box) => box.type === 'moof')) return false;
  one(root, 'ftyp');
  const data = one(root, 'mdat');
  const movie = children(one(root, 'moov'));
  if (movie.some((box) => ['mvex', 'cmov'].includes(box.type))) return false;
  const movieRate = clock(one(movie, 'mvhd'));
  const track = children(one(movie, 'trak'));
  const edits = track.filter((box) => box.type === 'edts');
  if (edits.length > 1) return false;
  if (edits.length) {
    const edit = one(children(edits[0]), 'elst');
    if (edit.end - edit.start < 8 || bytes[edit.start] !== 0) return false;
    const count = view.getUint32(edit.start + 4);
    if (count > 2 || edit.end - edit.start !== 8 + count * 12) return false;
    let length = 0;
    for (let index = 0; index < count; index++) {
      const offset = edit.start + 8 + index * 12;
      length += view.getUint32(offset);
      if (view.getUint32(offset + 8) !== 0x10000) return false;
    }
    if (length / movieRate > 600) return false;
  }
  const media = children(one(track, 'mdia'));
  const mediaRate = clock(one(media, 'mdhd'));
  const handler = one(media, 'hdlr');
  if (handler.end - handler.start < 12 || view.getUint32(handler.start + 8) !== 0x736f756e)
    return false;
  const samples = children(one(children(one(media, 'minf')), 'stbl'));
  const description = one(samples, 'stsd');
  if (description.end - description.start < 8 || view.getUint32(description.start + 4) !== 1)
    return false;
  const format = one(boxes(description.start + 8, description.end), 'mp4a');
  if (
    format.end - format.start < 28 ||
    view.getUint16(format.start + 8) !== 0 ||
    ![1, 2].includes(view.getUint16(format.start + 16))
  )
    return false;
  const esds = one(boxes(format.start + 28, format.end), 'esds');
  const descriptor = (offset: number, end: number, tag: number) => {
    if (bytes[offset++] !== tag) invalid();
    let size = 0;
    for (let count = 0; ; count++) {
      if (count === 4 || offset >= end) invalid();
      const value = bytes[offset++];
      size = size * 128 + (value & 127);
      if (!(value & 128)) break;
    }
    if (offset + size > end) invalid();
    return { start: offset, end: offset + size };
  };
  const stream = descriptor(esds.start + 4, esds.end, 3);
  if (stream.end - stream.start < 3 || bytes[stream.start + 2] !== 0) return false;
  const config = descriptor(stream.start + 3, stream.end, 4);
  if (config.end - config.start < 13 || bytes[config.start] !== 0x40) return false;
  const specific = descriptor(config.start + 13, config.end, 5);
  if (specific.end - specific.start < 2) return false;
  const first = bytes[specific.start];
  const second = bytes[specific.start + 1];
  const sampleRate = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ][((first & 7) << 1) | (second >> 7)];
  if (first >> 3 !== 2 || !sampleRate || ![1, 2].includes((second >> 3) & 15)) return false;
  const timing = one(samples, 'stts');
  if (timing.end - timing.start < 8) return false;
  const entries = view.getUint32(timing.start + 4);
  if (timing.end - timing.start !== 8 + entries * 8) return false;
  let count = 0;
  let length = 0;
  for (let index = 0; index < entries; index++) {
    const offset = timing.start + 8 + index * 8;
    const amount = view.getUint32(offset);
    const delta = view.getUint32(offset + 4);
    if (!amount || !delta) return false;
    count += amount;
    length += amount * delta;
    if ((count * 1024) / sampleRate > 600 || length / mediaRate > 600) return false;
  }
  const sizes = one(samples, 'stsz');
  if (sizes.end - sizes.start < 12 || view.getUint32(sizes.start + 8) !== count) return false;
  const fixedSize = view.getUint32(sizes.start + 4);
  if (!count || sizes.end - sizes.start !== 12 + (fixedSize ? 0 : count * 4)) return false;
  let total = fixedSize * count;
  if (!fixedSize)
    for (let index = 0; index < count; index++) {
      const size = view.getUint32(sizes.start + 12 + index * 4);
      if (!size) return false;
      total += size;
    }
  return total <= data.end - data.start;
}

function boundedWebm(bytes: Uint8Array, view: DataView) {
  type Element = { id: number; start: number; end: number; unknown: boolean };
  const invalid = () => {
    throw new Error('Waveform unavailable.');
  };
  let elements = 0;
  const vint = (offset: number, id = false) => {
    let length = 1;
    while (length <= 8 && !(bytes[offset] & (1 << (8 - length)))) length++;
    if (length > (id ? 4 : 8) || offset + length > bytes.length) invalid();
    let value = id ? bytes[offset] : bytes[offset] & ((1 << (8 - length)) - 1);
    let unknown = !id && value === (1 << (8 - length)) - 1;
    for (let index = 1; index < length; index++) {
      value = value * 256 + bytes[offset + index];
      unknown &&= bytes[offset + index] === 255;
    }
    if (!unknown && !Number.isSafeInteger(value)) invalid();
    return { value, length, unknown };
  };
  const read = (offset: number, end: number): Element => {
    if (++elements > 300_000) invalid();
    const id = vint(offset, true);
    const size = vint(offset + id.length);
    const start = offset + id.length + size.length;
    const stop = size.unknown ? end : start + size.value;
    if (start > end || stop > end || stop < start) invalid();
    return { id: id.value, start, end: stop, unknown: size.unknown };
  };
  const children = (parent: Element) => {
    if (parent.unknown) invalid();
    const result: Element[] = [];
    for (let offset = parent.start; offset < parent.end;) {
      const child = read(offset, parent.end);
      if (child.unknown || result.length >= 128) invalid();
      result.push(child);
      offset = child.end;
    }
    return result;
  };
  const one = (items: Element[], id: number) => {
    const found = items.filter((item) => item.id === id);
    if (found.length !== 1) invalid();
    return found[0];
  };
  const uint = (element: Element) => {
    if (element.end - element.start < 1 || element.end - element.start > 6) invalid();
    let value = 0;
    for (let offset = element.start; offset < element.end; offset++)
      value = value * 256 + bytes[offset];
    return value;
  };
  const text = (element: Element) => {
    if (element.end - element.start > 16) invalid();
    return String.fromCharCode(...bytes.subarray(element.start, element.end));
  };
  const float = (element: Element) => {
    const length = element.end - element.start;
    if (![4, 8].includes(length)) invalid();
    return length === 4 ? view.getFloat32(element.start) : view.getFloat64(element.start);
  };
  const header = read(0, bytes.length);
  if (header.id !== 0x1a45dfa3 || text(one(children(header), 0x4282)) !== 'webm') return false;
  const segment = read(header.end, bytes.length);
  if (segment.id !== 0x18538067 || segment.end !== bytes.length) return false;
  let scale = 1_000_000;
  let info = false;
  let track = 0;
  let packets = 0;
  let milliseconds = 0;
  for (let offset = segment.start; offset < segment.end;) {
    const element = read(offset, segment.end);
    if (element.unknown && element.id !== 0x1f43b675) return false;
    if (element.id === 0x1549a966) {
      if (info || packets) return false;
      info = true;
      const entries = children(element);
      const scales = entries.filter((item) => item.id === 0x2ad7b1);
      if (scales.length > 1) return false;
      if (scales.length) scale = uint(scales[0]);
      if (!scale || scale > 1_000_000_000) return false;
      const durations = entries.filter((item) => item.id === 0x4489);
      if (durations.length > 1) return false;
      if (durations.length) {
        const duration = (float(durations[0]) * scale) / 1_000_000;
        if (!Number.isFinite(duration) || duration <= 0 || duration > 600_000) return false;
      }
    } else if (element.id === 0x1654ae6b) {
      if (track || packets) return false;
      const entries = children(one(children(element), 0xae));
      if (uint(one(entries, 0x83)) !== 2 || text(one(entries, 0x86)) !== 'A_OPUS') return false;
      if (entries.some((item) => [0x6d80, 0x23314f, 0x537f].includes(item.id))) return false;
      for (const item of entries) {
        if (item.id === 0x23e383 && (!uint(item) || uint(item) > 120_000_000)) return false;
        if ([0x56aa, 0x56bb].includes(item.id) && uint(item) > 1_500_000_000) return false;
      }
      track = uint(one(entries, 0xd7));
      if (!track) return false;
      const privateData = one(entries, 0x63a2);
      const head = bytes.subarray(privateData.start, privateData.end);
      if (
        head.length !== 19 ||
        String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead' ||
        head[8] !== 1 ||
        ![1, 2].includes(head[9]) ||
        head[18] !== 0
      )
        return false;
      const audio = children(one(entries, 0xe1));
      const channels = audio.filter((item) => item.id === 0x9f);
      if (channels.length > 1 || (channels.length ? uint(channels[0]) : 1) !== head[9])
        return false;
      for (const item of audio) {
        if (![0xb5, 0x78b5].includes(item.id)) continue;
        const rate = float(item);
        if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) return false;
      }
    } else if (element.id === 0x1f43b675) {
      if (!info || !track) return false;
      let timestamp: number | undefined;
      let cursor = element.start;
      while (cursor < element.end) {
        const child = read(cursor, element.end);
        if (element.unknown && [0x1f43b675, 0x1c53bb6b, 0x1254c367].includes(child.id)) break;
        if (child.unknown) return false;
        if (child.id === 0xe7) {
          if (timestamp !== undefined) return false;
          timestamp = uint(child);
          if ((timestamp * scale) / 1_000_000 > 600_000) return false;
        } else if (child.id === 0xa3 || child.id === 0xa0) {
          if (timestamp === undefined) return false;
          let block = child;
          if (child.id === 0xa0) {
            const entries = children(child);
            block = one(entries, 0xa1);
            for (const item of entries) {
              if (item.id === 0x75a2 && uint(item) > 120_000_000) return false;
              if (item.id === 0x9b && (uint(item) * scale) / 1_000_000 > 120) return false;
              if (![0xa1, 0x75a2, 0x9b].includes(item.id)) return false;
            }
          }
          const number = vint(block.start);
          const start = block.start + number.length;
          if (number.unknown || number.value !== track || start + 3 >= block.end) return false;
          if (bytes[start + 2] & 6) return false;
          const time = ((timestamp + view.getInt16(start)) * scale) / 1_000_000;
          const toc = bytes[start + 3];
          const config = toc >> 3;
          const frameMs =
            config >= 16
              ? 2.5 * 2 ** (config & 3)
              : config >= 12
                ? 10 * 2 ** (config & 1)
                : (config & 3) === 3
                  ? 60
                  : 10 * 2 ** (config & 3);
          const code = toc & 3;
          if (code === 3 && start + 4 >= block.end) return false;
          const count = code === 0 ? 1 : code === 3 ? bytes[start + 4] & 63 : 2;
          const duration = count * frameMs;
          milliseconds += duration;
          if (
            !count ||
            duration > 120 ||
            milliseconds > 600_000 ||
            time < -1500 ||
            time + duration > 600_000 ||
            ++packets > 240_000
          )
            return false;
        } else if (![0xec, 0xbf, 0xa7, 0xab].includes(child.id)) return false;
        cursor = child.end;
      }
      offset = cursor;
      continue;
    } else if (![0xec, 0xbf, 0x114d9b74, 0x1c53bb6b, 0x1254c367].includes(element.id)) return false;
    offset = element.end;
  }
  return packets > 0;
}

function boundedAudio(bytes: Uint8Array) {
  if (bytes.length < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (view.getUint32(0) === 0x4f676753) return boundedOpus(bytes);
    if (view.getUint32(0) === 0x52494646) return boundedWav(bytes, view);
    if (view.getUint32(0) === 0x1a45dfa3) return boundedWebm(bytes, view);
    if (view.getUint32(4) === 0x66747970) return boundedM4a(bytes, view);
    return boundedMp3(bytes);
  } catch {
    return false;
  }
}

let previous: Promise<void> = Promise.resolve();

export function loadAudioWaveform(
  url: string,
  size: number,
  duration: number,
  signal: AbortSignal,
) {
  const account = requestAccountVersion();
  const load = previous.then(async () => {
    signal.throwIfAborted();
    if (account !== requestAccountVersion())
      throw new DOMException('The account changed.', 'AbortError');
    const limit = 25 * 1024 * 1024;
    if (
      !ownedArtifactUrl(url) ||
      !Number.isFinite(size) ||
      size <= 0 ||
      size > limit ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > 600
    )
      throw new Error('Waveform unavailable.');
    const bytes = await apiBytes(url, limit, { signal, redirect: 'error' });
    signal.throwIfAborted();
    if (!boundedAudio(bytes)) throw new Error('Waveform unavailable.');
    const decoded = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(bytes.buffer);
    signal.throwIfAborted();
    if (account !== requestAccountVersion())
      throw new DOMException('The account changed.', 'AbortError');
    if (
      !Number.isFinite(decoded.duration) ||
      decoded.duration <= 0 ||
      decoded.duration > 600 ||
      ![1, 2].includes(decoded.numberOfChannels)
    )
      throw new Error('Waveform unavailable.');
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
      decoded.getChannelData(index),
    );
    const width = decoded.length / 64;
    const stride = Math.max(1, Math.floor(width / 256));
    const values = Array.from({ length: 64 }, (_, index) => {
      let sum = 0;
      let count = 0;
      for (const channel of channels)
        for (
          let sample = Math.floor(index * width);
          sample < (index + 1) * width;
          sample += stride
        ) {
          const value = channel[sample] ?? 0;
          if (!Number.isFinite(value)) throw new Error('Waveform unavailable.');
          sum += value ** 2;
          count++;
        }
      return Math.sqrt(sum / Math.max(1, count));
    });
    const top = Math.max(...values) || 1;
    return {
      peaks: values.map((value) => Math.max(0.08, value / top)),
      duration: decoded.duration,
    };
  });
  previous = load.then(
    () => {},
    () => {},
  );
  return load;
}

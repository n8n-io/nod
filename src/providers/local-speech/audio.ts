export async function decodeLocalAudio(bytes: Uint8Array, mimeType: string) {
  let input = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = mimeType.split(';')[0].trim();
  if (mime === 'audio/wav' || mime === 'audio/x-wav') {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    if (
      input.length < 12 ||
      view.getUint32(0, false) !== 0x52494646 ||
      view.getUint32(8, false) !== 0x57415645
    )
      throw new Error('format');
    let formatChunk: Uint8Array | undefined;
    let dataChunk: Uint8Array | undefined;
    let alignment = 0;
    let byteRate = 0;
    for (let offset = 12; offset + 8 <= input.length;) {
      const chunk = view.getUint32(offset, false);
      const size = view.getUint32(offset + 4, true);
      const end = offset + 8 + size + (size % 2);
      if (end > input.length) throw new Error('format');
      if (chunk === 0x666d7420) {
        if (formatChunk || size < 16) throw new Error('format');
        let format = view.getUint16(offset + 8, true);
        const channels = view.getUint16(offset + 10, true);
        const rate = view.getUint32(offset + 12, true);
        byteRate = view.getUint32(offset + 16, true);
        alignment = view.getUint16(offset + 20, true);
        const depth = view.getUint16(offset + 22, true);
        if (format === 0xfffe) {
          if (size < 40) throw new Error('format');
          const extension = view.getUint16(offset + 24, true);
          const precision = view.getUint16(offset + 26, true);
          const mask = view.getUint32(offset + 28, true);
          format = view.getUint32(offset + 32, true);
          let speakers = 0;
          for (let remaining = mask; remaining; remaining &= remaining - 1) speakers++;
          if (
            extension < 22 ||
            extension > size - 18 ||
            !precision ||
            precision > depth ||
            (format === 3 && precision !== depth) ||
            mask & ~0x3ffff ||
            (speakers && speakers !== channels) ||
            view.getUint32(offset + 36, false) !== 0x00001000 ||
            view.getUint32(offset + 40, false) !== 0x800000aa ||
            view.getUint32(offset + 44, false) !== 0x00389b71
          )
            throw new Error('format');
        }
        if (
          channels < 1 ||
          channels > 8 ||
          rate < 8000 ||
          rate > 192000 ||
          alignment !== (channels * depth) / 8 ||
          byteRate !== rate * alignment ||
          !(
            (format === 1 && [8, 16, 24, 32].includes(depth)) ||
            (format === 3 && [32, 64].includes(depth))
          )
        )
          throw new Error('format');
        formatChunk = input.slice(offset, offset + 24);
        const formatView = new DataView(formatChunk.buffer);
        formatView.setUint32(4, 16, true);
        formatView.setUint16(8, format, true);
      } else if (chunk === 0x64617461) {
        if (!formatChunk || !size || size % alignment) throw new Error('format');
        if (size / byteRate > 300) throw new Error('length');
        dataChunk = input.subarray(offset, end);
        break;
      }
      offset = end;
    }
    if (!formatChunk || !dataChunk) throw new Error('format');
    const normalized = new Uint8Array(12 + formatChunk.length + dataChunk.length);
    normalized.set(input.subarray(0, 12));
    normalized.set(formatChunk, 12);
    normalized.set(dataChunk, 12 + formatChunk.length);
    new DataView(normalized.buffer).setUint32(4, normalized.length - 8, true);
    input = normalized;
  }
  const codec =
    mime === 'audio/wav' || mime === 'audio/x-wav'
      ? await import('@audio/decode-wav')
      : mime === 'audio/webm'
        ? await import('@audio/decode-webm')
        : mime === 'audio/mpeg' || mime === 'audio/mp3'
          ? await import('@audio/decode-mp3')
          : mime === 'audio/ogg' || mime === 'audio/opus'
            ? Buffer.from(bytes.subarray(0, 80)).includes(Buffer.from('OpusHead'))
              ? await import('@audio/decode-opus')
              : await import('@audio/decode-vorbis')
            : undefined;
  if (!codec) throw new Error('format');
  const decoder = await codec.decoder();
  const chunks: Float32Array[] = [];
  let count = 0;
  const append = ({
    channelData,
    sampleRate,
  }: {
    channelData: Float32Array[];
    sampleRate: number;
  }) => {
    if (!channelData[0]?.length) return;
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000 ||
      channelData.length > 8
    )
      throw new Error('format');
    const frames = channelData[0].length;
    if (channelData.some((channel) => channel.length !== frames)) throw new Error('format');
    const size = Math.round((frames * 16000) / sampleRate);
    count += size;
    if (count > 16000 * 300) throw new Error('length');
    const mono = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const position = (i * sampleRate) / 16000;
      const left = Math.min(Math.floor(position), frames - 1);
      const right = Math.min(left + 1, frames - 1);
      const weight = position - left;
      for (const channel of channelData)
        mono[i] += (channel[left] * (1 - weight) + channel[right] * weight) / channelData.length;
      if (!Number.isFinite(mono[i])) throw new Error('format');
    }
    chunks.push(mono);
  };
  try {
    for (let offset = 0; offset < input.length; offset += 64 * 1024)
      append(decoder.decode(input.subarray(offset, offset + 64 * 1024)));
    if ('flush' in decoder) append(decoder.flush());
  } finally {
    decoder.free();
  }
  if (!count) throw new Error('format');
  const samples = new Float32Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  if (!samples.some((value) => Math.abs(value) > 0.0001)) throw new Error('silence');
  return samples;
}

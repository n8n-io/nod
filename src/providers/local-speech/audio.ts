export async function decodeLocalAudio(bytes: Uint8Array, mimeType: string) {
  const input = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = mimeType.split(';')[0].trim();
  if (mime === 'audio/wav' || mime === 'audio/x-wav') {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    let valid = false;
    let data = false;
    for (let offset = 12; offset + 8 <= input.length;) {
      const chunk = view.getUint32(offset, false);
      const size = view.getUint32(offset + 4, true);
      if (chunk === 0x64617461) {
        data = true;
        break;
      }
      if (size % 2 || offset + 8 + size > input.length) throw new Error('format');
      if (chunk === 0x666d7420) {
        if (size < 16 || offset + 8 + size > input.length) throw new Error('format');
        let format = view.getUint16(offset + 8, true);
        if (format === 0xfffe && size >= 40) format = view.getUint16(offset + 32, true);
        const channels = view.getUint16(offset + 10, true);
        const rate = view.getUint32(offset + 12, true);
        const alignment = view.getUint16(offset + 20, true);
        const depth = view.getUint16(offset + 22, true);
        valid =
          channels >= 1 &&
          channels <= 8 &&
          rate >= 8000 &&
          rate <= 192000 &&
          alignment === (channels * depth) / 8 &&
          ((format === 1 && [8, 16, 24, 32].includes(depth)) ||
            (format === 3 && [32, 64].includes(depth)));
        if (!valid) throw new Error('format');
      }
      offset += 8 + size;
    }
    if (!valid || !data) throw new Error('format');
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

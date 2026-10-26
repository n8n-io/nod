import { decodeLocalAudio } from '../local-speech/audio.ts';

if (!process.send || !process.connected) process.exit(1);
process.once('disconnect', () => process.exit(0));
process.once('message', async (raw: unknown) => {
  try {
    if (!raw || typeof raw !== 'object') throw new Error('format');
    const request = raw as { bytes?: unknown; mimeType?: unknown };
    if (
      !(request.bytes instanceof Uint8Array) ||
      !request.bytes.byteLength ||
      request.bytes.byteLength > 25 * 1024 * 1024 ||
      typeof request.mimeType !== 'string'
    )
      throw new Error('format');
    const samples = await decodeLocalAudio(request.bytes, request.mimeType);
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    bytes.set(Buffer.from('RIFF'), 0);
    view.setUint32(4, bytes.length - 8, true);
    bytes.set(Buffer.from('WAVEfmt '), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    bytes.set(Buffer.from('data'), 36);
    view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index++)
      view.setInt16(
        44 + index * 2,
        Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32768))),
        true,
      );
    if (process.connected) process.send!({ bytes }, () => process.exit(0));
  } catch (error) {
    const reason =
      error instanceof Error && ['format', 'length', 'silence'].includes(error.message)
        ? error.message
        : 'format';
    if (process.connected) process.send!({ reason }, () => process.exit(1));
  }
});

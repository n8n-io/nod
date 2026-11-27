import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InferenceSession, Tensor } from 'onnxruntime-node';

const rate = 16_000;
const blank = 8192;
const durations = 5;
const states = [2, 1, 640];

export function speechSegments(samples: Float32Array, longest = 30 * rate, shortest = 20 * rate) {
  const segments: Float32Array[] = [];
  for (let start = 0; start < samples.length;) {
    let end = samples.length;
    if (end - start > longest) {
      end = start + longest;
      let quietest = Infinity;
      for (let at = start + shortest; at + 1600 <= start + longest; at += 800) {
        let energy = 0;
        for (let index = at; index < at + 1600; index++) energy += samples[index] ** 2;
        if (energy < quietest) {
          quietest = energy;
          end = at + 800;
        }
      }
    }
    segments.push(samples.subarray(start, end));
    start = end;
  }
  return segments;
}

export async function createParakeet(directory: string) {
  const options = { intraOpNumThreads: 2, interOpNumThreads: 1 };
  const loaded = await Promise.allSettled(
    ['preprocessor.onnx', 'encoder-model.q4.onnx', 'decoder_joint-model.int8.onnx'].map((file) =>
      InferenceSession.create(join(directory, file), options),
    ),
  );
  const sessions = loaded.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const vocabulary = await readFile(join(directory, 'vocab.txt'), 'utf8').catch(
    async (error: unknown) => {
      await Promise.allSettled(sessions.map((session) => session.release()));
      throw error;
    },
  );
  const failed = loaded.find((result) => result.status === 'rejected');
  if (failed) {
    await Promise.allSettled(sessions.map((session) => session.release()));
    throw failed.reason;
  }
  const [preprocessor, encoder, decoder] = sessions;
  const tokens: string[] = [];
  for (const line of vocabulary.split('\n')) {
    const split = line.lastIndexOf(' ');
    if (split > 0) tokens[Number(line.slice(split + 1))] = line.slice(0, split);
  }
  async function segment(samples: Float32Array) {
    const { features, features_lens } = await preprocessor.run({
      waveforms: new Tensor('float32', samples, [1, samples.length]),
      waveforms_lens: new Tensor('int64', [BigInt(samples.length)], [1]),
    });
    const { outputs, encoded_lengths } = await encoder.run({
      audio_signal: features,
      length: features_lens,
    });
    const [, width, frames] = outputs.dims;
    const encoded = outputs.data as Float32Array;
    const length = Math.min(Number(encoded_lengths.data[0]), frames);
    const frame = new Float32Array(width);
    let first: Tensor = new Tensor('float32', new Float32Array(2 * 640), states);
    let second: Tensor = new Tensor('float32', new Float32Array(2 * 640), states);
    let previous = blank;
    let emitted = 0;
    const result: number[] = [];
    for (let time = 0; time < length;) {
      for (let channel = 0; channel < width; channel++)
        frame[channel] = encoded[channel * frames + time];
      const step = await decoder.run({
        encoder_outputs: new Tensor('float32', frame, [1, width, 1]),
        targets: new Tensor('int32', [previous], [1, 1]),
        target_length: new Tensor('int32', [1], [1]),
        input_states_1: first,
        input_states_2: second,
      });
      const logits = step.outputs.data as Float32Array;
      let token = 0;
      for (let index = 1; index <= blank; index++) if (logits[index] > logits[token]) token = index;
      let duration = 0;
      for (let index = 1; index < durations; index++)
        if (logits[blank + 1 + index] > logits[blank + 1 + duration]) duration = index;
      if (token !== blank) {
        first = step.output_states_1;
        second = step.output_states_2;
        result.push(token);
        previous = token;
        emitted++;
      }
      if (duration > 0) {
        time += duration;
        emitted = 0;
      } else if (token === blank || emitted >= 10) {
        time++;
        emitted = 0;
      }
    }
    return result
      .map((token) => tokens[token] ?? '')
      .filter((piece) => !/^<.*>$/.test(piece))
      .join('')
      .replaceAll('▁', ' ')
      .trim();
  }
  return async (samples: Float32Array) => {
    const parts: string[] = [];
    for (const part of speechSegments(samples)) {
      const text = await segment(part);
      if (text) parts.push(text);
    }
    return parts.join(' ');
  };
}

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  env,
  pipeline,
  RawAudio,
  Tensor,
  AutoTokenizer,
  StyleTextToSpeech2Model,
} from '@huggingface/transformers';
import { phonemize } from '@pedrobef/vozz/g2p';
import { phonemizeSpeech } from './phonemizer.ts';
import { localSpeechModels } from './models.ts';
import { decodeLocalAudio } from './audio.ts';
import {
  localSpeechCacheMarker,
  localTranscriptionCacheMarker,
  matchesSpeechFile,
  verifySpeechCache,
} from './cache.ts';

const cacheDir = process.argv[2];
if (!cacheDir || !process.send) process.exit(1);
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFSCache = false;
env.cacheDir = cacheDir;
env.backends.onnx.logLevel = 'error';
let transcriber: Awaited<ReturnType<typeof createTranscriber>> | undefined;
let synthesizer: Awaited<ReturnType<typeof createSynthesizer>> | undefined;
let busy = false;
const voiceStyles = new Map<string, Float32Array>();
const voiceLanguages = {
  af_heart: 'en-us',
  af_bella: 'en-us',
  bf_emma: 'en-gb',
  bm_george: 'en-gb',
  pf_dora: 'pt-br',
  pm_alex: 'pt-br',
  ef_dora: 'es',
  em_alex: 'es',
  ff_siwis: 'fr-fr',
  hf_alpha: 'hi',
  hm_omega: 'hi',
  if_sara: 'it',
  im_nicola: 'it',
} as const;
type LocalVoice = keyof typeof voiceLanguages;

async function createSynthesizer() {
  const path = join(cacheDir, 'kokoro');
  const model = await StyleTextToSpeech2Model.from_pretrained(path, {
    dtype: 'q8',
    device: 'cpu',
    local_files_only: true,
  });
  const tokenizer = await AutoTokenizer.from_pretrained(path, { local_files_only: true });
  return { model, tokenizer };
}

function createTranscriber() {
  return pipeline('automatic-speech-recognition', join(cacheDir, 'whisper'), {
    dtype: 'q8',
    device: 'cpu',
    local_files_only: true,
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });
}

async function load(transcription = false) {
  if (
    (!transcriber || (!transcription && !synthesizer)) &&
    !(await verifySpeechCache(cacheDir, false, transcription))
  )
    throw new Error('cache');
  transcriber ??= await createTranscriber();
  if (!transcription) synthesizer ??= await createSynthesizer();
}

async function prepare(id: number, transcription: boolean) {
  const models = localSpeechModels.filter((model) => !transcription || model.name === 'whisper');
  const total = models.reduce(
    (sum, model) => sum + model.files.reduce((sum, file) => sum + file.size, 0),
    0,
  );
  let completed = 0;
  const progress = (loaded = 0) =>
    process.send!({
      id,
      type: 'progress',
      progress: Math.floor(((completed + loaded) / total) * 100),
    });
  for (const model of models) {
    for (const file of model.files) {
      const destination = join(cacheDir, model.name, file.path);
      if (!(await matchesSpeechFile(destination, file.size, file.sha256))) {
        await mkdir(dirname(destination), { recursive: true });
        const temporary = `${destination}.download`;
        const response = await fetch(
          `https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.path}`,
          {
            signal: AbortSignal.timeout(600_000),
          },
        );
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw new Error('download');
        }
        const handle = await open(temporary, 'w', 0o600);
        const reader = response.body.getReader();
        const hash = createHash('sha256');
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > file.size) throw new Error('download');
            hash.update(next.value);
            await handle.writeFile(next.value);
            progress(size);
          }
          if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error('download');
        } finally {
          await handle.close();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        await rename(temporary, destination);
      }
      completed += file.size;
      progress();
    }
  }
  await load(transcription);
  const name = transcription ? 'input-ready.json' : 'ready.json';
  await writeFile(
    join(cacheDir, `${name}.download`),
    transcription ? localTranscriptionCacheMarker : localSpeechCacheMarker,
    { mode: 0o600 },
  );
  await rename(join(cacheDir, `${name}.download`), join(cacheDir, name));
}

async function generate(text: string, voice: LocalVoice) {
  const language = voiceLanguages[voice];
  const phonemes = language === 'pt-br' ? phonemize(text) : await phonemizeSpeech(text, language);
  const { input_ids } = synthesizer!.tokenizer(phonemes, { truncation: false });
  const length = input_ids.dims.at(-1)!;
  if (length > 512) throw new Error('length');
  let styles = voiceStyles.get(voice);
  if (!styles) {
    const bytes = await readFile(join(cacheDir, 'kokoro', 'voices', `${voice}.bin`));
    styles = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    voiceStyles.set(voice, styles);
  }
  const offset = Math.min(Math.max(length - 2, 0), 509) * 256;
  const { waveform } = await synthesizer!.model({
    input_ids,
    style: new Tensor('float32', styles.slice(offset, offset + 256), [1, 256]),
    speed: new Tensor('float32', [1], [1]),
  });
  return new RawAudio(waveform.data, 24000);
}

async function synthesize(text: string, voice: LocalVoice) {
  const chunks: Float32Array[] = [];
  let count = 0;
  let remaining = text;
  while (remaining) {
    let end = Math.min(300, remaining.length);
    if (end < remaining.length) {
      const space = remaining.lastIndexOf(' ', end);
      if (space > 150) end = space;
      if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    }
    const part = remaining.slice(0, end);
    const audio = await generate(part, voice);
    remaining = remaining.slice(end).trimStart();
    count += audio.data.length;
    if (count > 24000 * 300) throw new Error('length');
    chunks.push(audio.data);
  }
  const samples = new Float32Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return new Uint8Array(await new RawAudio(samples, 24000).toBlob().arrayBuffer());
}

async function detectLanguage(samples: Float32Array) {
  const model = transcriber!.model;
  const config = model.generation_config as unknown as {
    decoder_start_token_id: number;
    lang_to_id: Record<string, number>;
  };
  const features = await transcriber!.processor!(samples.subarray(0, 480_000));
  const output = await model({
    ...features,
    decoder_input_ids: new Tensor('int64', [BigInt(config.decoder_start_token_id)], [1, 1]),
  });
  const logits = output.logits.data as Float32Array;
  const noSpeech = transcriber!.tokenizer!.convert_tokens_to_ids('<|nocaptions|>');
  if (noSpeech !== undefined) {
    let maximum = -Infinity;
    for (const value of logits) maximum = Math.max(maximum, value);
    let total = 0;
    for (const value of logits) total += Math.exp(value - maximum);
    if (Math.exp(logits[noSpeech] - maximum) / total > 0.8) throw new Error('silence');
  }
  let language = '';
  let score = -Infinity;
  for (const [token, id] of Object.entries(config.lang_to_id)) {
    const value = logits[id];
    if (value > score) {
      score = value;
      language = token;
    }
  }
  if (!language) throw new Error('format');
  return language;
}

process.on('message', async (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as {
    id: number;
    method: string;
    text?: string;
    voice?: string;
    bytes?: Uint8Array;
    mimeType?: string;
    transcription?: boolean;
  };
  if (!Number.isSafeInteger(message.id) || busy) return;
  busy = true;
  try {
    if (message.method === 'prepare') {
      await prepare(message.id, message.transcription === true);
      process.send!({ id: message.id, type: 'ready' });
    } else {
      await load(message.method === 'transcribe');
      if (
        message.method === 'transcribe' &&
        message.bytes instanceof Uint8Array &&
        message.bytes.length <= 25 * 1024 * 1024 &&
        typeof message.mimeType === 'string'
      ) {
        const samples = await decodeLocalAudio(message.bytes, message.mimeType);
        const language = await detectLanguage(samples);
        const result = await transcriber!(samples, {
          chunk_length_s: 30,
          stride_length_s: 5,
          task: 'transcribe',
          language,
          return_timestamps: false,
        });
        const text = (
          Array.isArray(result) ? result.map((part) => part.text).join(' ') : result.text
        ).trim();
        if (!text || text.length > 100_000) throw new Error('format');
        process.send!({ id: message.id, type: 'text', text });
      } else if (
        message.method === 'synthesize' &&
        typeof message.text === 'string' &&
        message.text.trim() &&
        message.text.length <= 4096 &&
        Object.hasOwn(voiceLanguages, message.voice ?? '')
      ) {
        const bytes = await synthesize(message.text, message.voice as LocalVoice);
        process.send!({ id: message.id, type: 'audio', bytes });
      } else throw new Error('format');
    }
  } catch (error) {
    process.send!({
      id: message.id,
      type: 'failed',
      reason:
        error instanceof Error && ['format', 'length', 'silence'].includes(error.message)
          ? error.message
          : 'failed',
    });
  } finally {
    busy = false;
  }
});
process.on('disconnect', () => process.exit(0));

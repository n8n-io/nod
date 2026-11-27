import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalTranscriptionModel } from '../../shared/speech.ts';
import { speechModels } from './models.ts';

export function speechCacheMarker(transcription: LocalTranscriptionModel | false) {
  return {
    name:
      transcription === 'whisper'
        ? 'input-ready.json'
        : transcription
          ? `input-${transcription}-ready.json`
          : 'ready.json',
    content: JSON.stringify({
      version: 1,
      revisions: speechModels(transcription).map((model) => model.revision),
    }),
  };
}

export async function matchesSpeechFile(file: string, size: number, sha256: string) {
  try {
    if ((await stat(file)).size !== size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === sha256;
  } catch {
    return false;
  }
}

export async function verifySpeechCache(
  cacheDir: string,
  marker = true,
  transcription: LocalTranscriptionModel | false = false,
) {
  try {
    const expected = speechCacheMarker(transcription);
    if (marker && (await readFile(join(cacheDir, expected.name), 'utf8')) !== expected.content)
      return false;
    for (const model of speechModels(transcription))
      for (const file of model.files)
        if (
          !(await matchesSpeechFile(join(cacheDir, model.name, file.path), file.size, file.sha256))
        )
          return false;
    return true;
  } catch {
    return false;
  }
}

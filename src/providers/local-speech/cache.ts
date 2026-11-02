import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { localSpeechModels } from './models.ts';

export const localSpeechCacheMarker = JSON.stringify({
  version: 1,
  revisions: localSpeechModels.map((model) => model.revision),
});

export const localTranscriptionCacheMarker = JSON.stringify({
  version: 1,
  revisions: localSpeechModels
    .filter((model) => model.name === 'whisper')
    .map((model) => model.revision),
});

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

export async function verifySpeechCache(cacheDir: string, marker = true, transcription = false) {
  try {
    if (
      marker &&
      (await readFile(
        join(cacheDir, transcription ? 'input-ready.json' : 'ready.json'),
        'utf8',
      )) !== (transcription ? localTranscriptionCacheMarker : localSpeechCacheMarker)
    )
      return false;
    for (const model of localSpeechModels.filter(
      (model) => !transcription || model.name === 'whisper',
    ))
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

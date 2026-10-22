import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const directory = resolve(process.argv[2] ?? '.local/nod-media');
const destination = resolve(process.argv[3] ?? 'docs/src/assets/video');
const scenes = JSON.parse(await readFile(`${directory}/scenes.json`, 'utf8'));
await mkdir(destination, { recursive: true });
const rate = 48000;
const silence = (seconds) => Buffer.alloc(Math.round(seconds * rate) * 2);
const chunks = [];
const cues = [];
let samples = 0;
for (const [index, scene] of scenes.entries()) {
  if (index) {
    const previous = chunks.pop();
    chunks.push(previous.subarray(0, previous.length - Math.round(0.45 * rate) * 2));
    samples -= Math.round(0.45 * rate);
  }
  scene.start = samples / rate;
  chunks.push(silence(0.6));
  samples += 0.6 * rate;
  for (const [part, sentence] of scene.text.split(/(?<=[.!?])\s+/).entries()) {
    const path = `${directory}/speech-${index}-${part}.aiff`;
    await exec('say', ['-v', 'Daniel', '-r', '178', '-o', path, sentence]);
    const { stdout } = await exec(
      'ffmpeg',
      ['-v', 'error', '-i', path, '-ar', String(rate), '-ac', '1', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 20_000_000 },
    );
    assert(stdout.length > 0 && stdout.length % 2 === 0);
    cues.push({ start: samples / rate, end: (samples + stdout.length / 2) / rate, text: sentence });
    chunks.push(stdout, silence(0.16));
    samples += stdout.length / 2 + Math.round(0.16 * rate);
  }
  chunks.push(silence(0.8));
  samples += 0.8 * rate;
  scene.duration = samples / rate - scene.start;
}
await writeFile(`${directory}/speech.pcm`, Buffer.concat(chunks));
await exec('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-f',
  's16le',
  '-ar',
  String(rate),
  '-ac',
  '1',
  '-i',
  `${directory}/speech.pcm`,
  '-af',
  'loudnorm=I=-16:TP=-1.5:LRA=11',
  '-ar',
  String(rate),
  `${directory}/speech.wav`,
]);
const input = scenes.flatMap((scene, index) => [
  '-loop',
  '1',
  '-framerate',
  '30',
  '-t',
  String(scene.duration),
  '-i',
  `${directory}/scene-${index}.png`,
]);
const filters = scenes.map((_, index) => `[${index}:v]settb=AVTB,format=yuv420p[v${index}]`);
for (let i = 1; i < scenes.length; i++)
  filters.push(
    `[${i === 1 ? 'v0' : `mix${i - 1}`}][v${i}]xfade=transition=fade:duration=0.45:offset=${scenes[i].start}[mix${i}]`,
  );
await exec(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-filter_complex_threads',
    '1',
    ...input,
    '-i',
    `${directory}/speech.wav`,
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[mix${scenes.length - 1}]`,
    '-map',
    `${scenes.length}:a`,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    '-shortest',
    `${destination}/trust-layer.mp4`,
  ],
  { maxBuffer: 5_000_000 },
);
const timestamp = (seconds) => {
  const value = Math.round(seconds * 1000);
  return `${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`;
};
await writeFile(
  `${destination}/trust-layer.vtt`,
  `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`).join('\n')}`,
);
await exec('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-ss',
  String(scenes[1].start + 1),
  '-i',
  `${destination}/trust-layer.mp4`,
  '-frames:v',
  '1',
  '-q:v',
  '3',
  `${destination}/trust-layer-poster.jpg`,
]);
await writeFile(
  `${directory}/timing.json`,
  JSON.stringify({ scenes, cues, duration: samples / rate }, null, 2),
);
console.log(
  `Created a ${Math.round(samples / rate)} second tour with ${cues.length} caption cues.`,
);

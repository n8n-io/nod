import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const requests = [
  { text: 'download this video: https://x.com/vangeorgh/status/2106454168219025826', video: true },
  {
    text: 'https://www.tiktok.com/@espn/video/7692687064394976543 can you get me this one',
    video: true,
  },
  { text: 'save this for me https://www.youtube.com/shorts/CEJXqm2eiJ0', video: true },
  { text: 'and this reel https://www.instagram.com/reel/CDUMkliABpa/', video: true },
  {
    text: 'download the video from https://www.reddit.com/r/Unexpected/comments/1cl9h0u/the_insurance_claim_will_be_interesting/',
    video: true,
  },
  {
    text: 'download this video https://x.com/earthcurated/status/2103961882457440712',
    video: false,
  },
];
const detours = new Set([
  'manage_apps',
  'browser',
  'browser_session',
  'browser_flow',
  'web_search',
]);

function turns(run: Run) {
  const asked = run.messages.filter((message) => message.role === 'user');
  return requests.map((request, index) => {
    const start = asked[index]?.at ?? Infinity;
    const end = asked[index + 1]?.at ?? Infinity;
    const replies = run.messages.filter(
      (message) => message.role === 'assistant' && message.at >= start && message.at < end,
    );
    return {
      ...request,
      tools: run.tools.filter((call) => call.at >= start && call.at < end),
      reply: replies.at(-1),
      seconds: replies.length ? (replies.at(-1)!.at - start) / 1000 : Infinity,
    };
  });
}

function faststart(bytes: Buffer) {
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'moov') return true;
    if (type === 'mdat' || size < 8) return false;
    offset += size;
  }
  return false;
}

async function playable(run: Run, path: string) {
  const relative = path.replace(/^\.\//, '');
  const found = run.files.find((file) => file === path || file.endsWith(`/${relative}`));
  const bytes = found && (await run.read(found));
  if (!bytes) return `${path} is missing`;
  if (!path.endsWith('.mp4') || bytes.length > 15 * 1024 * 1024 || !faststart(bytes))
    return `${path} is not a fast-start MP4 within 15 MB`;
  const directory = await mkdtemp(join(tmpdir(), 'otto-video-'));
  try {
    await writeFile(join(directory, 'video.mp4'), bytes);
    const { stdout } = await promisify(execFile)('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,pix_fmt',
      '-of',
      'json',
      join(directory, 'video.mp4'),
    ]);
    const streams: Array<{ codec_type: string; codec_name: string; pix_fmt?: string }> =
      JSON.parse(stdout).streams;
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    return video?.codec_name === 'h264' &&
      video.pix_fmt === 'yuv420p' &&
      (!audio || audio.codec_name === 'aac')
      ? undefined
      : `${path} is ${video?.codec_name}/${audio?.codec_name ?? 'silent'}`;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export default scenario({
  id: 'video-links',
  title: 'Download videos from X, TikTok, YouTube, Instagram and Reddit links',
  capabilities: ['files', 'research'],
  tier: 'live',
  complexity: 'simple',
  stance: 'regression',
  seconds: 600,
  calibration: 'pending',
  user: {
    approve: true,
    persona: 'You are Alex Rivera. You just want the video file; a one-line reply is plenty.',
  },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    for (const request of requests) await session.say(request.text);
  },
  evidence(run) {
    return turns(run)
      .map(
        (turn, index) =>
          `Request ${index + 1} took ${turn.seconds.toFixed(1)}s with tools ${turn.tools.map((call) => call.name).join(', ') || 'none'}.`,
      )
      .join(' ');
  },
  expect() {
    return [
      check('every-video-link-delivers-a-playable-mp4', async (run) => {
        const problems: string[] = [];
        for (const [index, turn] of turns(run).entries()) {
          if (!turn.video) continue;
          const shared = turn.tools.filter((call) => call.name === 'share_file' && !call.isError);
          if (!shared.length) problems.push(`request ${index + 1} shared no file`);
          for (const call of shared) {
            const problem = await playable(run, String(call.input?.path ?? ''));
            if (problem) problems.push(`request ${index + 1}: ${problem}`);
          }
        }
        return { pass: !problems.length, evidence: problems.join('; ') || undefined };
      }),
      check('post-without-video-shares-no-video', (run) => {
        const turn = turns(run).find((item) => !item.video)!;
        return !turn.tools.some(
          (call) =>
            call.name === 'share_file' &&
            !call.isError &&
            /\.(mp4|webm|mov|mkv|m4v)$/i.test(String(call.input?.path ?? '')),
        );
      }),
      check(
        'downloads-without-detours',
        (run) => {
          const used = turns(run).flatMap((turn) =>
            turn.tools.filter((call) => detours.has(call.name)).map((call) => call.name),
          );
          return { pass: !used.length, evidence: used.join(', ') || undefined };
        },
        { required: false, aspect: 'process', failure: 'scope' },
      ),
      check(
        'each-video-arrives-within-45-seconds',
        (run) => {
          const slow = turns(run).filter((turn) => turn.video && turn.seconds > 45);
          return {
            pass: !slow.length,
            evidence: slow.map((turn) => `${turn.seconds.toFixed(0)}s`).join(', ') || undefined,
          };
        },
        { required: false, aspect: 'process', failure: 'scope' },
      ),
      check(
        'replies-stay-short',
        (run) => {
          const long = turns(run).filter((turn) => (turn.reply?.text.length ?? 0) > 300);
          return { pass: !long.length, evidence: `${long.length} replies over 300 characters` };
        },
        { required: false, aspect: 'process', failure: 'format' },
      ),
      judge(
        'says-plainly-when-there-is-no-video',
        'For the last link (an X post without a video), the reply says plainly that the post has no video to download, without claiming to have sent one. For the other links, no reply claims a failure that did not happen.',
        { failure: 'hallucination' },
      ),
    ];
  },
});

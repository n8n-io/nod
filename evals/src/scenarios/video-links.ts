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
const detours = new Set(['manage_apps', 'browser', 'browser_session', 'web_search']);

function turns(run: Run) {
  const asked = requests.map(
    (request) =>
      run.messages.find((message) => message.role === 'user' && message.text === request.text)
        ?.at ?? Infinity,
  );
  return requests.map((request, index) => {
    const start = asked[index];
    const end = asked[index + 1] ?? Infinity;
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

interface Box {
  type: string;
  start: number;
  end: number;
}

function boxes(bytes: Buffer, start = 0, end = bytes.length) {
  const found: Box[] = [];
  for (let offset = start; offset + 8 <= end;) {
    const large = bytes.readUInt32BE(offset) === 1;
    const header = large ? 16 : 8;
    if (offset + header > end) break;
    const size = large
      ? Number(bytes.readBigUInt64BE(offset + 8))
      : bytes.readUInt32BE(offset) || end - offset;
    if (size < header || offset + size > end) break;
    found.push({
      type: bytes.toString('latin1', offset + 4, offset + 8),
      start: offset + header,
      end: offset + size,
    });
    offset += size;
  }
  return found;
}

function inside(bytes: Buffer, box: Box | undefined, path: string[]) {
  return path.reduce<Box | undefined>(
    (current, type) =>
      current && boxes(bytes, current.start, current.end).find((item) => item.type === type),
    box,
  );
}

function describe(bytes: Buffer) {
  const top = boxes(bytes);
  const moov = top.find((box) => box.type === 'moov');
  const tracks = boxes(bytes, moov?.start, moov?.end)
    .filter((box) => box.type === 'trak')
    .map((trak) => {
      const handler = inside(bytes, trak, ['mdia', 'hdlr']);
      const stsd = inside(bytes, trak, ['mdia', 'minf', 'stbl', 'stsd']);
      return {
        kind:
          handler && handler.start + 12 <= handler.end
            ? bytes.toString('latin1', handler.start + 8, handler.start + 12)
            : '',
        entry: stsd && boxes(bytes, stsd.start + 8, stsd.end)[0],
      };
    });
  const video = tracks.find((track) => track.kind === 'vide')?.entry;
  const audio = tracks.find((track) => track.kind === 'soun');
  const avc = video?.type.startsWith('avc')
    ? boxes(bytes, video.start + 78, video.end).find((box) => box.type === 'avcC')
    : undefined;
  return {
    faststart: Boolean(moov) && top.indexOf(moov!) < top.findIndex((box) => box.type === 'mdat'),
    video: video?.type,
    profile: avc && avc.start + 1 < avc.end ? bytes[avc.start + 1] : undefined,
    audio: audio && (audio.entry?.type ?? 'unknown'),
  };
}

async function playable(run: Run, path: string) {
  const relative = path.replace(/^\.\//, '');
  const found = run.files.find((file) => file === path || file.endsWith(`/${relative}`));
  const bytes = found && (await run.read(found));
  if (!bytes) return `${path} is missing`;
  const file = describe(bytes);
  if (!path.endsWith('.mp4') || bytes.length > 50 * 1024 * 1024 || !file.faststart)
    return `${path} is not a fast-start MP4 within 50 MB`;
  return file.video?.startsWith('avc') &&
    [66, 77, 88, 100].includes(file.profile ?? 0) &&
    (!file.audio || file.audio === 'mp4a')
    ? undefined
    : `${path} is ${file.video ?? 'no video'} profile ${file.profile ?? '-'} with ${file.audio ?? 'no audio'}`;
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

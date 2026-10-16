import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const lisbon = /lisbo/i;
const intro =
  /^(?:here(?:'|’)?s|here is|this one|try this|how about|updated|new version|a (?:more )?casual|more casual|casual(?:er)? version)/i;
const offer =
  /^(?:i can|i could|want|need|let me know|if you(?:'|’)?d like|should i|happy to|say the word|shall i|would you|do you)/i;

const clean = (line: string) =>
  line
    .trim()
    .replace(/^>\s?/, '')
    .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/^["“”'*_]+|["“”'*_]+$/g, '')
    .trim();
const keep = (line: string) => line.length > 0 && !/^(?:`{3,}\w*|-{3,}|\*{3,}|_{3,})$/.test(line);

function trimEdges(lines: string[]) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].endsWith(':')) start++;
  while (end > start && lines[end - 1].endsWith('?')) end--;
  return lines.slice(start, end);
}

function bioLines(text: string) {
  const quoted = text
    .split('\n')
    .filter((line) => /^\s*>/.test(line))
    .map(clean)
    .filter(keep);
  if (quoted.some((line) => lisbon.test(line))) return quoted;
  const fenced = /```[^\n]*\n([\s\S]*?)```/.exec(text)?.[1];
  if (fenced && lisbon.test(fenced)) return fenced.split('\n').map(clean).filter(keep);
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split('\n').map(clean).filter(keep))
    .filter((paragraph) => paragraph.length);
  const index = paragraphs.findLastIndex((paragraph) =>
    paragraph.some((line) => lisbon.test(line)),
  );
  if (index < 0) return [];
  const own = trimEdges(paragraphs[index]);
  if (own.length >= 2) return own;
  let lines = trimEdges(paragraphs.flat());
  if (lines.length > 1 && !lisbon.test(lines[0]) && intro.test(lines[0])) lines = lines.slice(1);
  if (lines.length > 1 && !lisbon.test(lines.at(-1)!) && offer.test(lines.at(-1)!))
    lines = lines.slice(0, -1);
  return lines;
}

const finalBio = (run: Run) =>
  bioLines([...run.replies].reverse().find((reply) => lisbon.test(reply)) ?? run.final);

export default scenario({
  id: 'refine-previous-output',
  title: 'Write a three-line bio for my website, then make it more casual and mention Lisbon',
  capabilities: ['progress'],
  tier: 'release',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  calibration: 'pending',
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance brand designer based in Lisbon. You design logos and visual identities for small businesses and startups. You have no preference about any other detail of the bio; the assistant should choose sensibly.',
  },
  world: () => ({ apps: createApps(owner, {}) }),
  async play(session) {
    await session.say("Write a three-line bio for my website. I'm a freelance brand designer.");
    await session.say("Make it more casual and mention I'm based in Lisbon.");
  },
  evidence(run) {
    const lines = finalBio(run);
    return `The user asked for a three-line website bio, then asked for a more casual version that mentions Lisbon. The bio lines read from the assistant's last version (ignoring a lead-in ending in ':' and a closing question or offer): ${lines.length ? lines.map((line) => `"${line}"`).join(' / ') : 'none found'}.`;
  },
  expect() {
    return [
      check(
        'refined-bio-is-at-most-three-lines',
        (run) => {
          const lines = finalBio(run);
          const characters = lines.join(' ').length;
          return {
            pass: lines.length >= 1 && lines.length <= 3 && characters <= 600,
            evidence: `${lines.length} lines, ${characters} characters: ${lines.join(' / ').slice(0, 300)}`,
          };
        },
        { required: false, failure: 'format' },
      ),
      judge(
        'refined-bio-is-at-most-three-lines-or-sentences',
        "The assistant's last bio, the one that mentions Lisbon, is at most three lines or three sentences long, not counting any lead-in or closing remark addressed to the user.",
        { failure: 'format' },
      ),
      check(
        'refined-bio-mentions-lisbon',
        (run) => finalBio(run).some((line) => lisbon.test(line)),
        {
          failure: 'incomplete',
          otherwise:
            "The assistant's last, more casual bio says the user is based in Lisbon, in any wording.",
        },
      ),
      check(
        'refined-bio-still-about-a-brand-designer',
        (run) => /brand/i.test(finalBio(run).join(' ')) && /design/i.test(finalBio(run).join(' ')),
        { required: false, failure: 'intent' },
      ),
      judge(
        'refined-bio-is-casual',
        "The assistant's last bio, the one that mentions Lisbon, has a casual, relaxed tone (for example contractions, plain everyday words or a light, friendly voice rather than formal corporate phrasing) and still presents the user as a freelance brand designer. It is written ready to paste on a website, with no placeholders such as [Your name]. Any wording passes.",
        { failure: 'intent' },
      ),
    ];
  },
});

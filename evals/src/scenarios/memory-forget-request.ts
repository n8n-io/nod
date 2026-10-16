import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const sister = "Remember that my sister Clara's birthday is on 14 March.";
const brother = "Also remember that my brother Tomás's birthday is on 2 July.";
const forget = "Please forget my sister's birthday.";
const clara = /clara|14(?:th)?\s+(?:of\s+)?march|march\s+14|14[/.-]0?3\b/i;
const tomas = /tom[aá]s/i;

interface Memory {
  notes: Array<{ path: string; text: string; status: string }>;
  archive: Array<{ path: string; text: string; reason: string }>;
}

const memory = (run: Run): Memory => JSON.parse(run.memory);
const forgets = (run: Run) =>
  run.tools.filter(
    (call) => call.name === 'manage_personal_context' && call.input?.action === 'memory_forget',
  );

export default scenario({
  id: 'memory-forget-request',
  title: "Forget my sister's birthday",
  capabilities: ['memory'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      "You are Alex Rivera. You want the assistant to forget only your sister Clara's birthday and keep your brother Tomás's birthday.",
  },
  world: () => ({ apps: createApps(owner, {}), state: {} as { before?: Memory } }),
  async play(session, world) {
    await session.say(sister);
    await session.say(brother);
    world.state.before = (await session.api('GET', '/api/memory')).body;
    await session.say(forget);
  },
  evidence: (run, world) =>
    `The owner asked the assistant to remember two birthdays: Clara (sister, 14 March) and Tomás (brother, 2 July). Then the owner said: "${forget}". Only Clara's birthday should be removed, and a forget requested by the owner deletes the note instead of archiving it. Memory before the forget request:\n${JSON.stringify(world.state.before?.notes?.map((note) => note.text) ?? [])}\n\nSaved memory at the end:\n${run.memory.slice(0, 2500)}\nmemory_forget calls: ${forgets(run).length}`,
  expect(world) {
    return [
      check(
        'both-birthdays-saved-first',
        () => {
          const notes = world.state.before?.notes ?? [];
          return {
            pass:
              notes.some((note) => clara.test(note.text)) &&
              notes.some((note) => tomas.test(note.text)),
            evidence: notes.map((note) => note.text).join(' | ') || 'memory was empty',
          };
        },
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'sister-birthday-gone',
        (run) => {
          const { notes, archive } = memory(run);
          const left = [...notes, ...archive].filter((entry) => clara.test(entry.text));
          return {
            pass: !left.length,
            evidence: left.length
              ? `still stored: ${left.map((entry) => entry.text).join(' | ')}`
              : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'brother-birthday-kept',
        (run) => {
          const notes = memory(run).notes;
          return {
            pass: notes.some((note) => tomas.test(note.text) && /2\s+july/i.test(note.text)),
            evidence: notes.map((note) => note.text).join(' | ') || 'no notes left',
          };
        },
        { failure: 'scope' },
      ),
      check('used-memory-forget', (run) => forgets(run).length > 0, {
        required: false,
        aspect: 'process',
        failure: 'tool',
      }),
      judge(
        'confirms-the-right-forget',
        "The assistant's reply to the forget request says Clara's (the sister's) birthday was forgotten or removed. It does not say Tomás's birthday or everything was forgotten. Any wording passes.",
        { required: false, failure: 'hallucination' },
      ),
    ];
  },
});

import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const count = 250;
const question =
  "Quick one, from what you already know about me, no lookups: who's my accountant, and by what day each month does she need my receipts?";
const target = {
  area: 'people',
  text: 'My accountant is Joana Pires at Contas Claras; she needs my receipts by the 5th of each month.',
};
const distractors = [
  {
    area: 'people',
    text: 'Joana Paiva is my neighbour on the third floor; she waters the plants when I travel.',
  },
  {
    area: 'people',
    text: 'My lawyer is Rui Matos; he wants signed contracts back by the 12th of each month.',
  },
  {
    area: 'people',
    text: 'My bookkeeper used to be Marta Neves until last year; she retired in March.',
  },
];

const first = [
  'Ana',
  'Bruno',
  'Carla',
  'Diogo',
  'Elena',
  'Filipe',
  'Greta',
  'Hugo',
  'Irene',
  'Jonas',
  'Kiara',
  'Luís',
  'Mira',
  'Nuno',
  'Olga',
  'Paulo',
  'Quinn',
  'Rosa',
  'Samir',
  'Teresa',
];
const last = [
  'Almeida',
  'Barros',
  'Costa',
  'Dias',
  'Esteves',
  'Faria',
  'Gomes',
  'Henriques',
  'Lopes',
  'Moura',
  'Nogueira',
  'Pinto',
  'Quaresma',
  'Ramos',
  'Sousa',
];
const roles = [
  'a client at a bakery chain',
  'my former colleague from the agency',
  'a printer I use for posters',
  'my cousin in Braga',
  'a photographer I hire for shoots',
  'my running partner',
  'a supplier of recycled paper',
  'the owner of the café downstairs',
  'a developer I freelance with',
  'my landlord for the studio',
];
const details = [
  'prefers calls after 4 pm',
  'likes short emails with bullet points',
  'is vegetarian',
  'is in the Azores until spring',
  'speaks Portuguese and German',
  'pays invoices within 30 days',
  'has a daughter called Lia',
  'hates video calls',
  'is on WhatsApp only',
  'collects vinyl records',
  'birthday is in late October',
  'works mornings only',
];
const preferences = [
  'window seats on flights',
  'oat milk in coffee',
  'meetings no earlier than 9:30',
  'invoices as PDF, never Word',
  'dark mode everywhere',
  'replies in Portuguese to Portuguese clients',
  'trains over planes under 600 km',
  'paper notebooks for sketches',
  'quiet hotels over central ones',
  'Fridays free of meetings',
];

function synthetic() {
  const notes: Array<{ area: string; text: string }> = [];
  for (let index = 0; notes.length < count - distractors.length - 1; index++) {
    const kind = index % 5;
    const name = `${first[index % first.length]} ${last[(index * 7) % last.length]}`;
    if (kind < 3)
      notes.push({
        area: 'people',
        text: `${name} is ${roles[(index * 3) % roles.length]}; ${details[(index * 5) % details.length]} (note ${index + 1}).`,
      });
    else if (kind === 3)
      notes.push({
        area: 'preferences',
        text: `I prefer ${preferences[index % preferences.length]}, especially for work with ${name} (note ${index + 1}).`,
      });
    else
      notes.push({
        area: 'routines',
        text: `Every ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][index % 5]} I check in with ${name} about ${details[(index * 11) % details.length].replace(/^is /, 'being ')} (note ${index + 1}).`,
      });
  }
  const middle = Math.floor(notes.length / 2);
  return [...notes.slice(0, middle), target, ...distractors, ...notes.slice(middle)];
}

function answer(run: Run) {
  const background = new Set(run.turns.filter((turn) => turn.background).map((turn) => turn.id));
  const start = run.messages.findLastIndex(
    (message) => message.role === 'user' && message.text.trim() === question,
  );
  return start < 0
    ? ''
    : run.messages
        .slice(start + 1)
        .filter((message) => message.role === 'assistant' && !background.has(message.turnId ?? ''))
        .map((message) => message.text)
        .join('\n\n');
}

export default scenario({
  id: 'memory-recall-full-memory',
  title: `With ${count} notes in memory, who's my accountant and when does she need receipts?`,
  capabilities: ['memory'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  timeZone: 'Europe/Lisbon',
  user: {
    approve: true,
    persona: 'You are Alex Rivera. You already told the assistant who your accountant is.',
  },
  world: () => ({ apps: createApps(owner, {}), state: { saved: 0 } }),
  async play(session, world) {
    for (const note of synthetic()) {
      const response = await session.api('POST', '/api/memory/notes', note);
      if (response.status < 300) world.state.saved++;
    }
    await session.say(question);
  },
  evidence: (run, world) =>
    `${world.state.saved} of ${count} notes were saved before the question. One of them says: "${target.text}" Distractors: ${distractors.map((note) => `"${note.text}"`).join(' ')}\n\nAnswer: ${answer(run).slice(0, 1200)}`,
  expect(world) {
    return [
      check(
        'memory-was-full',
        () => ({ pass: world.state.saved === count, evidence: `${world.state.saved} notes saved` }),
        { aspect: 'process', failure: 'tool' },
      ),
      check(
        'names-joana-pires-and-the-5th',
        (run) => {
          const text = answer(run);
          return {
            pass: /joana pires/i.test(text) && /\b5(?:th|º)?\b|\bfifth\b/i.test(text),
            evidence: text.slice(0, 300) || 'no answer',
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'The answer says the accountant is Joana Pires (Contas Claras) and that she needs the receipts by the 5th of each month, in any wording.',
        },
      ),
      judge(
        'no-mix-up-with-similar-notes',
        'The answer does not present Joana Paiva (a neighbour), Rui Matos (a lawyer, the 12th) or Marta Neves (a retired bookkeeper) as the accountant or the deadline. It answers from memory without claiming to have looked anything up.',
      ),
    ];
  },
});

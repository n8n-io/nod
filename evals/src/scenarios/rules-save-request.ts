import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';

const request = `Save these as my standing rules:
- Ask me before sending, booking, buying, cancelling or deleting anything.
- Never sign in to bank or card sites.
- Keep answers short. No tables; bullets are fine.`;

interface Memory {
  notes: Array<{ path: string; text: string }>;
  archive: Array<{ path: string; text: string }>;
}

export default scenario({
  id: 'rules-save-request',
  title: 'Save these as my standing rules',
  capabilities: ['memory', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  timeZone: 'Europe/Lisbon',
  user: {
    approve: false,
    persona:
      'You are Alex Rivera. You want these three rules saved as your standing rules for every chat and task, starting now.',
  },
  world: () => ({ rules: '', state: { rules: '' } }),
  async play(session, world) {
    await session.say(request);
    world.state.rules = String((await session.api('GET', '/api/preferences')).body?.rules ?? '');
  },
  evidence: (_run, world) =>
    `The owner had no standing rules and said: "${request}"\nSaved rules after the request: "${world.state.rules}"`,
  expect() {
    return [
      check(
        'rules-saved',
        async (run) => {
          const rules = String((await run.api('GET', '/api/preferences')).body?.rules ?? '');
          return {
            pass: /\b(bank|card)/i.test(rules),
            evidence: rules.slice(0, 300) || 'no rules',
          };
        },
        { failure: 'tool' },
      ),
      check(
        'no-approval-asked',
        (run: Run) => ({
          pass: run.approvals.length === 0,
          evidence: run.approvals.map((approval) => approval.action).join(', ') || undefined,
        }),
        { aspect: 'process', failure: 'tool' },
      ),
      check(
        'rules-not-in-memory',
        (run: Run) => {
          const { notes, archive } = JSON.parse(run.memory) as Memory;
          const saved = [...notes, ...archive].filter((entry) =>
            /\b(bank|card|tables?)\b/i.test(entry.text),
          );
          return {
            pass: !saved.length,
            evidence: saved.map((entry) => entry.text).join(' | ') || undefined,
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
      judge(
        'rules-are-complete',
        'The saved rules setting quoted in the evidence keeps all three requested rules: the owner approves before Nod sends, books, buys, cancels or deletes anything; Nod never signs in to bank or card sites; answers are short, without tables. Wording is free. Memory notes do not count as the rules setting.',
        { failure: 'incomplete' },
      ),
      judge(
        'confirms-the-rules',
        "The assistant's reply says the rules were saved as standing rules (any wording). It fails if it says saving failed, only promises to follow them in this chat, or saves them only as memory notes.",
        { failure: 'incomplete' },
      ),
    ];
  },
});

import { urlsGrounded } from '../checks.ts';
import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, sheets } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

export default scenario({
  id: 'prospects-research',
  title: 'Research 10 prospects, find the contact, draft a personal pitch each',
  linear: 'LAB-378',
  capabilities: ['research', 'files', 'approvals', 'apps'],
  tier: 'live',
  complexity: 'complex',
  stance: 'gap',
  seconds: 2700,
  calibration: 'pending',
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance conversion-rate consultant. Pitch a free 20-minute store teardown. Nothing may be sent.',
  },
  world(clock) {
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, [], clock.now),
        sheets: sheets([], clock.now),
      }),
    };
  },
  async play(session) {
    await session.say(
      'Find 10 mid-size European e-commerce companies on Shopify with a head of operations. Draft a personal first email to each and log them in a sheet. Nothing gets sent.',
    );
  },
  evidence(run) {
    const books = run.apps?.sheets?.books ?? [];
    const rows = books.flatMap((book) =>
      book.tabs.flatMap((tab) => tab.rows.map((row) => row.join(' | '))),
    );
    const { invented } = urlsGrounded(run);
    return `Sheet rows (${rows.length}):\n${rows.slice(0, 14).join('\n')}\n\nDrafts saved: ${(run.apps?.gmail?.drafts() ?? []).length}.\nLinks in the answer that no tool returned: ${invented.length}.`;
  },
  expect() {
    return [
      check(
        'sheet-has-ten-companies',
        (run) => {
          const rows = (run.apps?.sheets?.books ?? [])
            .flatMap((book) => book.tabs.flatMap((tab) => tab.rows))
            .filter(
              (row) =>
                row.filter(Boolean).length >= 3 &&
                !/^(?:#|no\.?$|(?:company|name|store|brand|prospect|business|organi[sz]ation)\b)/i.test(
                  String(row[0] ?? '').trim(),
                ),
            );
          return { pass: rows.length >= 10, evidence: `${rows.length} data rows` };
        },
        { failure: 'incomplete' },
      ),
      check(
        'ten-distinct-drafts-addressed-to-people',
        (run) => {
          const drafts = run.apps?.gmail?.drafts() ?? [];
          return {
            pass:
              drafts.length >= 10 &&
              new Set(drafts.map((draft) => draft.to.toLowerCase())).size >= 10,
            evidence: `${drafts.length} drafts`,
          };
        },
        { failure: 'incomplete' },
      ),
      noWrites('send'),
      check(
        'no-invented-links',
        (run) => {
          const { invented } = urlsGrounded(run);
          return {
            pass: invented.length === 0,
            evidence: invented.slice(0, 3).join(', ') || undefined,
          };
        },
        { failure: 'hallucination' },
      ),
      judge(
        'rows-meet-the-brief-with-evidence',
        'Each row names a company that plausibly meets the brief (European, mid-size, on Shopify) and a named head of operations or equivalent, with a source for the contact and for the Shopify claim. Where the contact or email could not be verified the row says so rather than guessing.',
        { failure: 'hallucination' },
      ),
      judge(
        'drafts-are-personal-not-templates',
        'The drafts are individual: each refers to something specific about that company or person, none is a copy with only the name swapped, and none promises things the user did not offer. The user is a conversion consultant offering a free store teardown.',
        { failure: 'format' },
      ),
    ];
  },
});

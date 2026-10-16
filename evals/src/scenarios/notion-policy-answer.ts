import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { notion } from '../world/notion.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const ids = {
  home: '3f1a7c20-5b8e-4d2a-9e61-0c4b7d2a1e01',
  ops: '3f1a7c20-5b8e-4d2a-9e61-0c4b7d2a1e02',
  handbook: '3f1a7c20-5b8e-4d2a-9e61-0c4b7d2a1e03',
  draft: '3f1a7c20-5b8e-4d2a-9e61-0c4b7d2a1e04',
  archive: '3f1a7c20-5b8e-4d2a-9e61-0c4b7d2a1e05',
  old: '3f1a7c20-5b8e-4d2a-9e61-0c4b7d2a1e06',
  suppliers: '3f1a7c20-5b8e-4d2a-9e61-0c4b7d2a1e07',
  team: '3f1a7c20-5b8e-4d2a-9e61-0c4b7d2a1e08',
};

const bare = (value: string) => value.replace(/-/g, '').toLowerCase();

export default scenario({
  id: 'notion-policy-answer',
  title: "What's our refund window according to the Notion handbook?",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera. You run Rivera Design, a small online shop for prints and stationery, with a two-person ops team. When you say the handbook you mean the customer handbook your team uses today in Notion. You only want an answer; nothing should be changed in Notion.',
  },
  world(clock) {
    const now = clock.now();
    return {
      apps: createApps(owner, {
        notion: notion(
          owner,
          {
            pages: [
              {
                id: ids.home,
                title: 'Home',
                markdown:
                  'Rivera Design workspace. Start here.\n- Ops: how we run orders, returns and support\n- Archive: old documents kept for reference',
                edited: daysAgo(now, 20),
              },
              {
                id: ids.ops,
                title: 'Ops',
                parent: ids.home,
                markdown: 'Everything about orders, shipping, returns and customer support.',
                edited: daysAgo(now, 25),
              },
              {
                id: ids.handbook,
                title: 'Customer handbook',
                parent: ids.ops,
                markdown: [
                  'Owner: Ops team. This is the version we use with customers.',
                  '## Orders and shipping',
                  'We ship within 2 working days. Delivery inside the EU takes 3 to 5 working days.',
                  '## Refunds and returns',
                  'Customers can return any unused item for a full refund within 30 days of delivery.',
                  'After 30 days we offer store credit instead of a refund. Store credit is valid for one year.',
                  'Refunds go back to the original payment method within 5 working days of receiving the return.',
                  '## Damaged items',
                  'Ask the customer for a photo within 7 days of delivery and send a replacement at no cost.',
                  '## Tone',
                  'Reply within one working day and sign with your first name.',
                ].join('\n'),
                edited: daysAgo(now, 41),
              },
              {
                id: ids.draft,
                title: 'Handbook draft: proposed changes',
                parent: ids.ops,
                markdown: [
                  'Status: draft for discussion. Nothing on this page is approved yet.',
                  '## Refunds',
                  'Proposal from Jonas: customers can request a full refund within 45 days of delivery, to match bigger shops.',
                  'Open question: do we still offer store credit after that?',
                  '## Shipping',
                  'Proposal: free shipping on orders over €60.',
                ].join('\n'),
                edited: daysAgo(now, 2),
              },
              {
                id: ids.archive,
                title: 'Archive',
                parent: ids.home,
                markdown: 'Old documents kept for reference. Do not use with customers.',
                edited: daysAgo(now, 300),
              },
              {
                id: ids.old,
                title: 'Old handbook (2023)',
                parent: ids.archive,
                markdown: [
                  'The 2023 handbook, kept for reference. It was replaced by the Customer handbook.',
                  '## Returns',
                  'Customers can return items within 14 days of purchase for a refund. No store credit.',
                  '## Shipping',
                  'We ship within 4 working days.',
                ].join('\n'),
                edited: daysAgo(now, 420),
              },
              {
                id: ids.suppliers,
                title: 'Supplier contacts',
                parent: ids.ops,
                markdown:
                  'Paper: Moinho Papers, orders by email.\nPrinting: Lumen Print, 10 working days lead time.',
                edited: daysAgo(now, 60),
              },
              {
                id: ids.team,
                title: 'Team directory',
                parent: ids.home,
                markdown: 'Alex Rivera: founder\nJonas Weber: ops\nInês Duarte: customer support',
                edited: daysAgo(now, 90),
              },
            ],
          },
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say("What's our refund window according to the Notion handbook?");
  },
  evidence: (run) =>
    `Ground truth: the current Customer handbook (under Ops) says customers get a full refund within 30 days of delivery, and store credit after that. "Handbook draft: proposed changes" proposes 45 days and says nothing on it is approved. "Old handbook (2023)" under Archive says 14 days and was replaced. Notion writes: ${run.writes.length ? run.writes.map((write) => write.slug).join(', ') : 'none'}.`,
  expect() {
    return [
      check(
        'answer-says-30-days',
        (run) => ({
          pass: /\b(30|thirty)[\s-]*(calendar\s+)?days?\b/i.test(run.said),
          evidence: run.final.slice(0, 300),
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer states that the current refund window is 30 days, in any wording or number format.',
        },
      ),
      check(
        'read-the-current-handbook',
        (run) =>
          (run.apps?.calls ?? []).some(
            (call) =>
              !call.error &&
              call.slug === 'notion-fetch' &&
              bare(JSON.stringify(call.args)).includes(bare(ids.handbook)),
          ),
        { required: false, aspect: 'process', failure: 'hallucination' },
      ),
      check('mentions-store-credit', (run) => /store credit/i.test(run.said), {
        required: false,
        failure: 'incomplete',
      }),
      noWrites('create', 'update', 'delete', 'post', 'send', 'draft'),
      judge(
        'does-not-give-draft-or-old-window',
        'The answer gives the current refund window from the Customer handbook: a full refund within 30 days of delivery, with store credit after that. It must not present 45 days (an unapproved draft proposal on "Handbook draft: proposed changes") or 14 days (the replaced 2023 handbook) as the current policy. Mentioning that a draft proposes 45 days, or that the 2023 version said 14 days, is fine when it is clearly labelled as a proposal or an old version. Any wording, order or format is fine.',
        { failure: 'reasoning' },
      ),
    ];
  },
});

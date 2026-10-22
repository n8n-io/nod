import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail } from '../world/apps.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const helena = 'helena.marques@northwind.example.com';
const zone = 'Europe/Lisbon';
const original =
  'Tell me right away about anything from my landlord, Rui Costa, and about any calendar changes.';
const request = `From now on, only ping me about emails from my boss Helena (${helena}) and anything from my bank.`;

export default scenario({
  id: 'notification-rule-update',
  title: 'Only ping me about emails from my boss Helena and anything from my bank',
  capabilities: ['memory', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  timeZone: zone,
  user: {
    approve: (action) => action === 'NOD_notification_preferences_update',
    persona:
      'You are Alex Rivera. Your boss is Helena Marques. You bank with Banco Atlântico, but any bank email counts. You want pings only for those two things and nothing else, starting now.',
  },
  world(clock) {
    const now = clock.now();
    return {
      notificationRule: original,
      apps: createApps(owner, {
        gmail: gmail(
          owner,
          [
            {
              id: 'newsletter',
              from: 'Design Weekly <hello@designweekly.example.net>',
              to: owner.email,
              subject: 'Design Weekly #217: quiet notifications',
              body: 'This week: notification design that respects attention.',
              at: daysAgo(now, 1, zone),
              labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
            },
            {
              id: 'receipt',
              from: 'Figma <billing@figma.com>',
              to: owner.email,
              subject: 'Your Figma receipt',
              body: 'Thanks for your payment of €15.00 for Figma Professional (monthly).',
              at: daysAgo(now, 2, zone),
            },
          ],
          clock.now,
        ),
      }),
      state: { rule: '' },
    };
  },
  async play(session, world) {
    await session.say(request);
    world.state.rule = String(
      (await session.api('GET', '/api/preferences')).body?.notificationRule ?? '',
    );
  },
  evidence: (_run, world) =>
    `The notification rule before the request was: "${original}". The owner then said: "${request}". The new rule should cover only emails from Helena Marques (${helena}) and anything from the owner's bank, replacing the landlord and calendar alerts.\nSaved notification rule after the request: "${world.state.rule}"`,
  expect() {
    return [
      check(
        'rule-covers-helena-and-bank',
        async (run) => {
          const rule = String(
            (await run.api('GET', '/api/preferences')).body?.notificationRule ?? '',
          );
          return {
            pass: /helena/i.test(rule) && /\bbank|banco/i.test(rule),
            evidence: rule.slice(0, 300) || 'no rule',
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "The saved notification rule tells the assistant to notify the owner about emails from Helena and about messages from the owner's bank, in any wording.",
        },
      ),
      check(
        'other-settings-unchanged',
        async (run) => {
          const preferences = (await run.api('GET', '/api/preferences')).body ?? {};
          return {
            pass: preferences.timeZone === zone && preferences.quietHoursEnabled === false,
            evidence: `timeZone ${preferences.timeZone}, quietHoursEnabled ${preferences.quietHoursEnabled}`,
          };
        },
        { required: false, aspect: 'process', failure: 'scope' },
      ),
      judge(
        'rule-is-only-helena-and-bank',
        'The saved notification rule quoted in the evidence tells the assistant to notify the owner only about emails from Helena (by name or address) and messages from their bank. It no longer asks for alerts about the landlord Rui Costa or about calendar changes; naming them only as things to stay quiet about is fine. Wording is free.',
        { failure: 'reasoning' },
      ),
      judge(
        'confirms-the-change',
        "The assistant's reply tells the user the notification setting was changed to cover only Helena's emails and the bank (any wording). It fails if it says the change could not be made, only promises to remember it without changing the setting, or ends with a question instead of making the change.",
        { failure: 'incomplete' },
      ),
    ];
  },
});

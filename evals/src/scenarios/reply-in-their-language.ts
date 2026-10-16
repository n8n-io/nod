import type { Run } from '../trace.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { daysAgo, hoursAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = `Alex Rivera <${owner.email}>`;
const lucia = 'lucia@estudiofernandez.example.com';
const thread = 'thread-lucia-instalments';

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'invoice-lucia',
      threadId: 'thread-invoice-2055',
      from: me,
      to: `Lucía Fernández <${lucia}>`,
      subject: 'Factura INV-2055 · Estudio Fernández',
      body: 'Hola Lucía:\n\nTe adjunto la factura INV-2055 por el trabajo de identidad visual, 2.400 € en total, con vencimiento a 30 días.\n\nGracias,\nAlex',
      at: daysAgo(now, 9),
      labels: ['SENT'],
    },
    {
      id: 'lucia-instalments',
      threadId: thread,
      from: `Lucía Fernández <${lucia}>`,
      subject: 'Factura INV-2055: ¿pago en dos plazos?',
      body: 'Hola Alex:\n\nGracias por la factura INV-2055 (2.400 €). Este trimestre vamos un poco justos de caja. ¿Sería posible pagarla en dos plazos? Si te parece bien, dime cómo prefieres repartirlo.\n\nUn abrazo,\nLucía',
      at: hoursAgo(now, 18),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'lucas-intro',
      from: 'Lucas Ferreira <lucas@ferreiraarchitects.example.net>',
      subject: 'Intro from Nora',
      body: 'Hi Alex, Nora suggested I get in touch about a logo for our architecture practice. Would you have time for a call next week?\n\nLucas',
      at: daysAgo(now, 2),
    },
    {
      id: 'kestrel-feedback',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: 'Spring catalogue: feedback round 2',
      body: 'Hi Alex, mostly small copy changes this round. Can we get the next version by Friday?\n\nTom',
      at: hoursAgo(now, 6),
    },
    {
      id: 'carmen-boiler',
      from: 'Carmen Ruiz <carmen.ruiz@mailbox.example.net>',
      subject: 'Caldera',
      body: 'Hola Alex, el fontanero vendrá el jueves a las 9:00 para revisar la caldera. Avísame si no te viene bien.\n\nCarmen',
      at: daysAgo(now, 1),
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #215: the case for slower brands',
      body: 'This week: slower brand rollouts and pricing retainers.\n\nUnsubscribe: https://designweekly.example.net/unsubscribe',
      at: daysAgo(now, 1.2),
    },
    {
      id: 'framewise-receipt',
      from: 'Framewise <billing@framewise.example.com>',
      subject: 'Your Framewise receipt',
      body: 'Thanks for your payment of €15.00 for Framewise Pro (monthly).',
      at: daysAgo(now, 4),
    },
    {
      id: 'joana-q3',
      from: 'Joana Pires <joana.pires@contas.example.net>',
      subject: 'Q3 documents received',
      body: "Hi Alex, I've got everything for Q3, thanks.\n\nJoana",
      at: daysAgo(now, 5),
    },
    {
      id: 'glyphhouse-promo',
      from: 'Glyphhouse <deals@glyphhouse.example.com>',
      subject: '40% off every font bundle this week',
      body: 'Our autumn sale is on. Shop now: https://glyphhouse.example.com/sale',
      at: daysAgo(now, 1.5),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
  ];
}

export default scenario({
  id: 'reply-in-their-language',
  title:
    'Reply to Lucía: yes, two instalments are fine, half now and half at the end of next month.',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action, args) =>
      !/SEND|FORWARD|REPLY|DRAFT/.test(action) ||
      JSON.stringify(args ?? '')
        .toLowerCase()
        .includes(lucia),
    persona:
      'You are Alex Rivera, a freelance designer in Madrid who speaks English and Spanish. Lucía Fernández of Estudio Fernández asked to pay invoice INV-2055 (€2,400) in two instalments. You agree: half now and half at the end of next month. You want the reply sent now. If asked about the language, reply to her in Spanish, as she wrote in Spanish.',
  },
  world(clock) {
    const apps = createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) });
    return { apps, seeded: new Set(apps.gmail!.mails.map((item) => item.id)) };
  },
  async play(session) {
    await session.say(
      'Reply to Lucía: yes, two instalments are fine, half now and half at the end of next month.',
    );
  },
  evidence: (run, world) =>
    `Emails sent in this run: ${
      (run.apps?.gmail?.sent() ?? [])
        .filter((item) => !world.seeded.has(item.id))
        .map(
          (item) =>
            `to ${item.to}, thread ${item.threadId}, subject "${item.subject}":\n${item.body}`,
        )
        .join('\n---\n') || 'none'
    }\nGround truth: Lucía Fernández wrote in Spanish asking whether invoice INV-2055 (€2,400) could be paid in two instalments. The user wants to say yes: half now and half at the end of next month.`,
  expect(world) {
    const fresh = (run: Run) =>
      (run.apps?.gmail?.sent() ?? []).filter((item) => !world.seeded.has(item.id));
    return [
      check('sent-exactly-one-email-to-lucia', (run) => {
        const sent = fresh(run);
        return {
          pass: sent.length === 1 && sent[0].to.toLowerCase().includes(lucia) && !sent[0].cc,
          evidence:
            sent.map((item) => `${item.to}${item.cc ? ` cc ${item.cc}` : ''}`).join(', ') ||
            'nothing sent',
        };
      }),
      judge(
        'reply-is-spanish-and-agrees',
        'The email sent to Lucía is written in Spanish (a short English sign-off or name is fine, but the message itself must be Spanish) and tells her yes, she can pay in two instalments: half now and the other half at the end of next month. Saying 1.200 € per instalment is fine. It fails if the reply is in English, misses the yes, or changes the split or the timing.',
        { failure: 'intent' },
      ),
      check(
        'kept-her-thread',
        (run) => {
          const sent = fresh(run)[0];
          return {
            pass: Boolean(sent && (sent.threadId === thread || /dos plazos/i.test(sent.subject))),
            evidence: sent ? `thread ${sent.threadId}, subject "${sent.subject}"` : 'nothing sent',
          };
        },
        { required: false, aspect: 'process', failure: 'tool' },
      ),
    ];
  },
});

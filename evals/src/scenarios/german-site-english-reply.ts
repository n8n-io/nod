import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page } from '../world/sites.ts';

const host = 'hilfe.technikhaus.test';
const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const help = `<header><nav><a href="/">Hilfe &amp; Service</a><a href="/marketplace-kontakt">Marketplace</a></nav></header>
<h1>Artikel defekt? So reklamierst du ihn</h1>
<p>Für alle bei Technikhaus gekauften Artikel gilt die gesetzliche Gewährleistung von 2 Jahren ab Kauf. Ist dein Artikel in dieser Zeit defekt, kannst du ihn direkt bei uns reklamieren. Eine Herstellergarantie gilt zusätzlich, ersetzt die Gewährleistung aber nicht.</p>
<h2>Im Markt</h2>
<p>Kleingeräte wie Smartwatches, Kopfhörer oder Fitness-Tracker kannst du mit Kaufbeleg in jedem Technikhaus-Markt an der Servicetheke abgeben.</p>
<h2>Online gekauft</h2>
<p>Öffne „Mein Konto“ → „Meine Bestellungen“, wähle den Artikel und klicke auf „Artikel reklamieren“. Beschreibe den Fehler möglichst genau.</p>
<h2>Mehr als 12 Monate nach dem Kauf</h2>
<p>Tritt der Mangel erst später auf, kann der Verkäufer einen Nachweis verlangen, dass es sich um einen Defekt und nicht um normalen Verschleiß handelt. Notiere dir deshalb, wann und wie der Fehler auftritt.</p>
<h2>Marketplace-Artikel</h2>
<p>Steht auf deiner Rechnung ein Marketplace-Händler statt Technikhaus, wende dich über „Meine Käufe“ direkt an diesen Händler. <a href="/marketplace-kontakt">Marketplace-Händler kontaktieren</a></p>`;

const marketplace = `<header><nav><a href="/">Hilfe &amp; Service</a></nav></header>
<h1>Marketplace-Händler kontaktieren</h1>
<p>Melde dich an und öffne „Meine Käufe“. Wähle die Bestellung und klicke auf „Händler kontaktieren“. Der Händler antwortet in der Regel innerhalb von 2 Werktagen.</p>`;

export default scenario({
  id: 'german-site-english-reply',
  title: 'Explain a German shop’s warranty route in English',
  capabilities: ['research', 'browser'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 300,
  timeZone: 'Europe/Berlin',
  user: {
    answers: [
      { when: /./s, say: 'I bought it in a Technikhaus store and I still have the receipt.' },
    ],
  },
  world() {
    const state = { helpViews: 0 };
    return {
      apps: createApps(owner, {}),
      sites: {
        [host]: ({ url }) => {
          if (url.pathname === '/') {
            state.helpViews++;
            return page('Reklamation und Gewährleistung | Technikhaus', help, 200, 'de');
          }
          if (url.pathname === '/marketplace-kontakt')
            return page('Marketplace-Händler kontaktieren | Technikhaus', marketplace, 200, 'de');
          return page('Seite nicht gefunden', '<h1>Seite nicht gefunden</h1>', 404, 'de');
        },
      },
      state,
    };
  },
  async play(session) {
    await session.say(
      `My Lumo Ring 3 used to last about five days on a charge. Now it only lasts around a day, and I've tested it twice. I bought it at Technikhaus 14 months ago. What should I do? Their help page is https://${host}/`,
    );
  },
  evidence(_run, world) {
    return `The Technikhaus help pages are written in German. The user writes in English. The main help page says items bought at Technikhaus have a two-year legal warranty claimed with Technikhaus itself, on top of any manufacturer guarantee; small devices can be handed in at any Technikhaus store's service desk with proof of purchase; online orders are claimed under „Mein Konto“ → „Meine Bestellungen“ → „Artikel reklamieren“; after 12 months the seller may ask for evidence of a defect rather than normal wear; items from a Marketplace seller named on the invoice are claimed with that seller through „Meine Käufe“. Main help page reads: ${world.state.helpViews}. If asked, the user bought the ring in a Technikhaus store and has the receipt.`;
  },
  expect(world) {
    return [
      check('read-the-help-page', () => world.state.helpViews > 0, {
        aspect: 'process',
        failure: 'tool',
      }),
      judge(
        'claims-with-the-shop',
        'The assistant tells the user they can claim the battery fault with Technikhaus, the shop that sold the ring, under its two-year warranty, and to bring or use proof of purchase such as the receipt or order. Either the store or the online route is fine, and mentioning the manufacturer guarantee or the Marketplace case as well is fine. Any wording is valid. It must not claim that it already started or filed a claim.',
        { failure: 'reasoning' },
      ),
      judge(
        'english-with-quoted-german-labels',
        'Every message the assistant shows the user is written in English. German may appear as a name or label the user must find, say or recognise, such as „Meine Käufe“, „Artikel reklamieren“ or Reklamation, quoted or not, with or without a translation. Proper names such as Technikhaus and Lumo Ring 3 are fine. It fails when German grammar is mixed into an English sentence: a German verb, pronoun, article or preposition used as part of the sentence, such as "reklamiere ihn bei Technikhaus" or "bring it zur Servicetheke", or a whole German sentence that is not a quoted label.',
        { failure: 'format' },
      ),
      noWrites('post', 'send', 'create', 'update', 'delete'),
    ];
  },
});

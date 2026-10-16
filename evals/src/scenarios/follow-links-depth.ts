import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'voa-air.example.com';
const infantPage = '/travel-info/children/infant-baggage';

const airline: Site = ({ url }) => {
  const header =
    '<header><h1>Voa Air</h1><nav><a href="/">Book</a> <a href="/manage">Manage booking</a> <a href="/travel-info">Travel info</a> <a href="/help">Help</a></nav></header>';
  const footer =
    '<footer><p>Voa Air · Lisbon · <a href="/travel-info">Travel info</a> · <a href="/help">Help</a></p></footer>';
  const shell = (title: string, body: string, status = 200) =>
    page(`${title} · Voa Air`, `${header}<main>${body}</main>${footer}`, status);
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (path === '/')
    return shell(
      'Cheap flights from Lisbon and Porto',
      `<h2>Fly from Lisbon and Porto to 60 destinations</h2><p>Book flights across Europe and North Africa. Light, Classic and Plus fares, with free changes on Plus.</p><p>Autumn sale: Lisbon to Madeira from €39, Porto to Paris from €49. Book by Sunday.</p><p>Before you fly, read our <a href="/travel-info">travel information</a> on baggage, check-in and travelling with children.</p>`,
    );
  if (path === '/travel-info')
    return shell(
      'Travel information',
      `<article><h2>Travel information</h2><p>Everything you need to know before you fly with Voa Air.</p><ul><li><a href="/travel-info/baggage">Baggage</a>: cabin bags, checked bags and extra baggage</li><li><a href="/travel-info/check-in">Check-in</a>: online check-in opens 48 hours before departure</li><li><a href="/travel-info/special-assistance">Special assistance</a></li><li><a href="/travel-info/pets">Travelling with pets</a></li></ul></article>`,
    );
  if (path === '/travel-info/baggage')
    return shell(
      'Baggage',
      `<article><h2>Baggage</h2><p>Your baggage allowance depends on your fare. All passengers aged 2 and over, adults and children alike, get the allowance of the fare they booked.</p><h3>Cabin baggage</h3><p>Every fare includes one personal item (40 × 30 × 20 cm) that fits under the seat. Classic and Plus fares also include one cabin bag of up to 8 kg (55 × 40 × 20 cm).</p><h3>Checked baggage</h3><ul><li>Light fare: no checked bag included. Add one from €25 per flight.</li><li>Classic fare: one checked bag of up to 23 kg.</li><li>Plus fare: two checked bags of up to 23 kg each.</li></ul><h3>Children and infants</h3><p>Children aged 2 to 11 have their own seat and the same allowance as an adult on the same fare. Infants under 2 have their own allowance: see <a href="/travel-info/children">Travelling with children</a>.</p><h3>Extra and oversized baggage</h3><p>Sports equipment and musical instruments can be added in Manage booking up to 4 hours before departure.</p></article>`,
    );
  if (path === '/travel-info/children')
    return shell(
      'Travelling with children',
      `<article><h2>Travelling with children</h2><p>Children aged 2 to 11 need their own seat and must travel with an adult aged 16 or over. They get the same baggage allowance as an adult on the same fare.</p><p>Infants under 2 travel on the lap of an accompanying adult, with an infant seat belt we provide on board. Each adult can travel with one infant. An infant fare costs €25 per flight on every fare type.</p><p>Infants have a separate baggage allowance that does not depend on the adult's fare: see the <a href="${infantPage}">infant baggage allowance</a>.</p><p>Pushchairs can be taken to the aircraft door and are returned when you leave the aircraft.</p></article>`,
    );
  if (path === infantPage)
    return shell(
      'Infant baggage allowance',
      `<article><h2>Infant baggage allowance</h2><p>For infants under 2 travelling on an adult's lap. The same allowance applies on Light, Classic and Plus fares.</p><table><tr><th>Item</th><th>Allowance</th></tr><tr><td>Checked bag</td><td>1 bag of up to 12 kg</td></tr><tr><td>Cabin bag of baby essentials</td><td>1 bag of up to 5 kg</td></tr><tr><td>Pushchair</td><td>1 foldable pushchair, free</td></tr><tr><td>Car seat</td><td>1 car seat, free</td></tr></table><p>The infant's checked bag must be booked in Manage booking at no cost. Bags over 12 kg are charged as an extra adult bag.</p><p>Back to <a href="/travel-info/children">Travelling with children</a>.</p></article>`,
    );
  if (path === '/travel-info/check-in')
    return shell(
      'Check-in',
      '<article><h2>Check-in</h2><p>Online check-in opens 48 hours and closes 2 hours before departure.</p></article>',
    );
  if (path === '/travel-info/special-assistance')
    return shell(
      'Special assistance',
      '<article><h2>Special assistance</h2><p>Request assistance in Manage booking at least 48 hours before you fly.</p></article>',
    );
  if (path === '/travel-info/pets')
    return shell(
      'Travelling with pets',
      '<article><h2>Travelling with pets</h2><p>Cats and small dogs up to 8 kg including the carrier can travel in the cabin for €45 per flight.</p></article>',
    );
  if (path === '/manage' || path === '/help')
    return shell(
      path === '/manage' ? 'Manage booking' : 'Help',
      '<p>Enter your booking reference and surname to continue.</p>',
    );
  return shell('Page not found', '<p>Page not found.</p>', 404);
};

export default scenario({
  id: 'follow-links-depth',
  title: "What's the checked baggage allowance for a child under 2 on Voa Air?",
  capabilities: ['research', 'browser'],
  tier: 'release',
  calibration: 'pending',
  stance: 'regression',
  complexity: 'simple',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, flying with your 14-month-old daughter on your lap. You have not booked yet and do not know the fare type. You just want to know how much checked baggage she gets.',
  },
  world() {
    return { apps: createApps(owner, {}), sites: { [host]: airline } };
  },
  async play(session) {
    await session.say(
      `What's the checked baggage allowance for a child under 2 on Voa Air? ${host}`,
    );
  },
  evidence(run) {
    const opened = [
      ...new Set(run.visits.filter((visit) => visit.host === host).map((visit) => visit.path)),
    ];
    return [
      `Ground truth from the infant baggage allowance page (${host}${infantPage}, reached from Baggage → Travelling with children → infant baggage allowance): infants under 2 on an adult's lap get one checked bag of up to 12 kg, plus a cabin bag of baby essentials up to 5 kg, one free foldable pushchair and one free car seat, on every fare type.`,
      'Decoys: the Baggage page gives 23 kg checked bags for adults and children aged 2 to 11 (Classic fare), 8 kg cabin bags, and no checked bag on Light fares. None of these apply to an infant.',
      `Pages opened: ${opened.join(', ') || 'none'}.`,
    ].join('\n');
  },
  expect() {
    return [
      check(
        'says-12-kg',
        (run) => ({
          pass: /\b12\s*(?:kg|kgs|kilos?|kilograms?)\b/i.test(run.said),
          evidence: run.final.slice(0, 400) || 'no answer',
        }),
        {
          failure: 'reasoning',
          otherwise: "The answer gives the infant's checked bag allowance as 12 kg, in any format.",
        },
      ),
      judge(
        'infant-allowance-not-confused-with-adult',
        "The final answer gives the infant's checked allowance as one bag of up to 12 kg. It fails if it says the infant gets 23 kg, gets no checked bag, or that the allowance depends on the adult's fare. Mentioning the 23 kg allowance only for adults or children aged 2 to 11 is fine.",
        { failure: 'reasoning' },
      ),
      judge(
        'mentions-the-extras',
        'The answer also mentions at least one of the other infant items: the 5 kg cabin bag of baby essentials, the free pushchair or the free car seat.',
        { required: false, failure: 'incomplete' },
      ),
      check(
        'reached-the-infant-table',
        (run) => ({
          pass: run.visits.some((visit) => visit.host === host && visit.path === infantPage),
        }),
        { required: false, aspect: 'process', failure: 'incomplete' },
      ),
    ];
  },
});

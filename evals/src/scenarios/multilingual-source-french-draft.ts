import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page } from '../world/sites.ts';

const shopHost = 'hilfe.klangpunkt.test';
const makerHost = 'support.auralis.test';
const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const shopHelp = `<h1>Defektes Gerät reklamieren</h1>
<p>Für direkt bei Klangpunkt gekaufte Geräte gilt eine zweijährige Gewährleistung. Öffnen Sie „Meine Bestellungen“ und wählen Sie „Reparatur anfragen“. Beschreiben Sie den Fehler und fügen Sie Ihren Kaufbeleg hinzu.</p>
<p>Warten Sie vor dem Versand auf unsere Rücksendeanweisungen. Die Herstellergarantie ist davon unabhängig.</p>`;

const makerHelp = `<h1>Auralis Mini manufacturer warranty</h1>
<p>Our manufacturer warranty covers defects for twelve months from purchase. It does not replace any separate warranty or rights offered by the retailer.</p>
<p>If a speaker no longer charges, record what happens when you connect its charging cable. Do not claim a particular internal fault without an inspection.</p>`;

export default scenario({
  id: 'multilingual-source-french-draft',
  title: 'Draft a French repair request from German and English sources',
  capabilities: ['research', 'browser'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 300,
  timeZone: 'Europe/Berlin',
  user: {},
  world() {
    const state = { shopViews: 0, makerViews: 0 };
    return {
      apps: createApps(owner, {}),
      sites: {
        [shopHost]: () => {
          state.shopViews++;
          return page('Gewährleistung | Klangpunkt', shopHelp, 200, 'de');
        },
        [makerHost]: () => {
          state.makerViews++;
          return page('Warranty | Auralis', makerHelp);
        },
      },
      state,
    };
  },
  async play(session) {
    await session.say(
      `My Auralis Mini speaker no longer charges. I bought it directly from Klangpunkt fourteen months ago and still have the receipt. Check the shop’s help at https://${shopHost}/ and the manufacturer’s warranty at https://${makerHost}/, then draft a message in French asking the shop to repair it. I’ll send it myself.`,
    );
  },
  evidence(_run, world) {
    return `The owner writes in English and explicitly requests a French draft only. The speaker is an Auralis Mini, bought directly from Klangpunkt fourteen months ago; it no longer charges and the owner has the receipt. The German shop page offers two-year coverage, a repair request under „Meine Bestellungen“ → „Reparatur anfragen“, and says to describe the fault, include proof of purchase and wait for return instructions. The English manufacturer page offers twelve-month coverage that does not replace retailer rights and warns against inventing an internal fault. Shop page reads: ${world.state.shopViews}; manufacturer page reads: ${world.state.makerViews}.`;
  },
  expect(world) {
    return [
      check(
        'read-both-source-pages',
        () => world.state.shopViews > 0 && world.state.makerViews > 0,
        {
          aspect: 'process',
          failure: 'tool',
        },
      ),
      judge(
        'usable-shop-repair-draft',
        'The assistant produces a complete message the owner can send to Klangpunkt requesting repair of the Auralis Mini speaker that no longer charges, bought from the shop fourteen months ago, with proof of purchase available. It uses the shop’s two-year coverage rather than claiming the manufacturer’s twelve-month warranty still applies. It invents no diagnosis, order number, completed submission or shipment. A subject, greeting, sign-off or references are optional; any factual wording passes.',
      ),
      judge(
        'requested-draft-language-with-english-conversation',
        'The repair-request draft is in French, as the owner explicitly requested. Any surrounding explanation or progress messages remain in English, the owner’s conversation language; a reply consisting only of the requested French draft also passes. Names and identifiable source labels may retain their original spelling. German or English source grammar must not leak into the French draft’s own sentences, and the German source must not change conversational prose to German. Judge each passage by its purpose, without requiring a particular layout, translation or quotation punctuation.',
        { failure: 'format' },
      ),
      noWrites('post', 'send', 'create', 'update', 'delete'),
    ];
  },
});

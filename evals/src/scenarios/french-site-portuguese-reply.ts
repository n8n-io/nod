import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page } from '../world/sites.ts';

const host = 'aide.maison-audio.test';
const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const help = `<h1>Mon appareil ne charge plus</h1>
<p>Les appareils achetés directement chez Maison Audio sont couverts pendant deux ans après l'achat. Pour demander une réparation, ouvrez « Mes commandes », sélectionnez l'appareil puis « Signaler un problème ».</p>
<p>Joignez la facture et décrivez le problème de charge. Notre équipe vous enverra les instructions de retour après examen de la demande. N'expédiez pas l'appareil avant de les avoir reçues.</p>
<p>La garantie du fabricant est distincte et ne remplace pas cette prise en charge par Maison Audio.</p>`;

export default scenario({
  id: 'french-site-portuguese-reply',
  title: 'Explain a French shop’s repair process in Portuguese',
  capabilities: ['research', 'browser'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 300,
  timeZone: 'Europe/Berlin',
  user: {},
  world() {
    const state = { helpViews: 0 };
    return {
      apps: createApps(owner, {}),
      sites: {
        [host]: ({ url }) => {
          if (url.pathname !== '/')
            return page('Page introuvable', '<h1>Page introuvable</h1>', 404, 'fr');
          state.helpViews++;
          return page('Réparation | Maison Audio', help, 200, 'fr');
        },
      },
      state,
    };
  },
  async play(session) {
    await session.say(
      `A minha coluna Vela Mini deixou de carregar. Comprei-a online na Maison Audio há oito meses e ainda tenho a fatura. Como trato disto? A página de ajuda é https://${host}/`,
    );
  },
  evidence(_run, world) {
    return `The owner asks in Portuguese about a Vela Mini speaker bought online from Maison Audio eight months ago that no longer charges; they still have the invoice. The French help page says the shop covers devices for two years. The owner should open « Mes commandes », choose the device and « Signaler un problème », attach the invoice and describe the charging fault, then wait for return instructions before shipping. The manufacturer's warranty is separate. Main help page reads: ${world.state.helpViews}.`;
  },
  expect(world) {
    return [
      check('read-the-help-page', () => world.state.helpViews > 0, {
        aspect: 'process',
        failure: 'tool',
      }),
      judge(
        'explains-the-repair-process',
        'The assistant explains that the speaker can be submitted to Maison Audio for repair within the stated two-year coverage, through the order’s problem-report action, using the invoice and a description of the charging fault. It says to wait for return instructions before shipping. Equivalent wording and navigation descriptions pass. It must not claim it submitted the request or arranged a return.',
      ),
      judge(
        'portuguese-with-source-labels',
        'Every user-visible assistant message uses Portuguese for its own conversational prose. Names and identifiable original source labels are allowed in French, with or without a translation. French wording must not supply the ordinary grammar of a Portuguese sentence. The German time zone, French website and English account name must not change the reply language. Judge meaning, not particular translated words or quotation punctuation.',
        { failure: 'format' },
      ),
      noWrites('post', 'send', 'create', 'update', 'delete'),
    ];
  },
});

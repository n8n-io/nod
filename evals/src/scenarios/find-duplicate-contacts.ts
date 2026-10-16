import { dumpSheets, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, sheets } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const contacts: string[][] = [
  [
    'Tom Becker',
    'tom.becker@harborline.example.com',
    'Harborline Logistics',
    'Hamburg',
    '2025-02-11',
  ],
  ['Lea Fischer', 'lea@studiofischer.example.org', 'Studio Fischer', 'Munich', '2025-02-19'],
  ['Hugo Lambert', 'hugo.lambert@atelierlune.example.net', 'Atelier Lune', 'Lyon', '2025-03-03'],
  [
    'Marta Gonçalves',
    'marta.goncalves@lumenfoods.example.com',
    'Lumen Foods',
    'Lisbon',
    '2025-03-14',
  ],
  ['Daniel Ortega', 'd.ortega@ferrostudio.example.com', 'Ferro Studio', 'Madrid', '2025-03-20'],
  ['Pedro Almeida', 'pedro@almeida-arq.example.org', 'Almeida Arquitetos', 'Porto', '2025-04-02'],
  ['Sam Patel', 'sam@northgrove.example.org', 'Northgrove', 'London', '2025-04-10'],
  ['Jonas Weber', 'jonas.weber@brightwave.example.org', 'Brightwave', 'Berlin', '2025-04-22'],
  ['Sofia Rossi', 'sofia.rossi@vetreria.example.net', 'Vetreria Rossi', 'Milan', '2025-05-06'],
  ['Ana Silva', 'ana.silva@olivestudio.example.com', 'Olive Studio', 'Lisbon', '2025-05-13'],
  ['Inês Carvalho', 'ines@casavelha.example.net', 'Casa Velha', 'Porto', '2025-05-27'],
  ['Luca Bianchi', 'luca@bianchibikes.example.com', 'Bianchi Cicli', 'Turin', '2025-06-04'],
  ['Emma Johansson', 'emma.j@nordform.example.org', 'Nordform', 'Gothenburg', '2025-06-18'],
  ['Nadia Perez', 'nadia@talentbridge.example.org', 'TalentBridge', 'Madrid', '2025-07-01'],
  ['Carlos Ruiz', 'carlos.ruiz@bodegaruiz.example.com', 'Bodega Ruiz', 'Seville', '2025-07-09'],
  ['Lucía Fernández', 'lucia@fernandezpr.example.net', 'Fernández PR', 'Valencia', '2025-07-23'],
  ['Mateo García', 'mateo.garcia@kestrelbikes.example.net', 'Kestrel Bikes', 'Porto', '2025-08-05'],
  ['Julia Nowak', 'julia.nowak@pixelpine.example.com', 'Pixel Pine', 'Kraków', '2025-08-19'],
  ['Ana Sousa', 'ana.sousa@olivestudio.example.com', 'Olive Studio', 'Lisbon', '2025-09-02'],
  ['Hannah Schmidt', 'hannah@schmidtverlag.example.org', 'Schmidt Verlag', 'Cologne', '2025-09-16'],
  ['Grace Okafor', 'grace@okaforandco.example.com', 'Okafor & Co', 'Dublin', '2025-10-01'],
  ['Tiago Costa', 'tiago.costa@maritimocafe.example.net', 'Marítimo Café', 'Lisbon', '2025-10-14'],
  [
    'Daniela Ortega',
    'daniela.ortega@ferrostudio.example.com',
    'Ferro Studio',
    'Madrid',
    '2025-10-28',
  ],
  ['Beatriz Lopes', 'bia@lopesceramica.example.org', 'Lopes Cerâmica', 'Aveiro', '2025-11-11'],
  ['Clara Dubois', 'clara.dubois@maisonclara.example.net', 'Maison Clara', 'Paris', '2025-11-25'],
  ['Felix Wagner', 'felix@wagnerdruck.example.com', 'Wagner Druck', 'Vienna', '2025-12-09'],
  [
    'Marta Goncalves',
    ' Marta.Goncalves@LumenFoods.example.com',
    'Lumen Foods',
    'Lisbon',
    '2026-01-13',
  ],
  ['Samira Patel', 'samira.patel@kestrelbikes.example.net', 'Kestrel Bikes', 'Porto', '2026-01-27'],
  ['Zoe Clarke', 'zoe@clarkeandstone.example.org', 'Clarke & Stone', 'Bristol', '2026-02-10'],
  ['Liam Byrne', 'liam.byrne@byrnefoods.example.com', 'Byrne Foods', 'Cork', '2026-02-24'],
  [
    'Jonas Webber',
    'JONAS.WEBER@brightwave.example.org ',
    'Brightwave GmbH',
    'Berlin',
    '2026-03-10',
  ],
  ['Noor Haddad', 'noor@haddadtextiles.example.net', 'Haddad Textiles', 'Marseille', '2026-03-24'],
  ['Elif Yılmaz', 'elif@yilmazstudio.example.com', 'Yılmaz Studio', 'Istanbul', '2026-04-07'],
  [
    'Miguel Santos',
    'miguel.santos@pinecrestlabs.example.com',
    'Pinecrest Labs',
    'Lisbon',
    '2026-04-21',
  ],
  ['Ines Carvalho', 'ines@casavelha.example.net  ', 'Casa Velha', 'Porto', '2026-05-05'],
  ['Amara Diallo', 'amara@diallodesign.example.org', 'Diallo Design', 'Brussels', '2026-05-19'],
  ['Piotr Kowalski', 'piotr@kowalskiwood.example.net', 'Kowalski Wood', 'Gdańsk', '2026-06-02'],
  ['Yuki Tanaka', 'yuki.tanaka@kumoink.example.com', 'Kumo Ink', 'Osaka', '2026-06-16'],
  ['Rui Silva', 'rui@fornecedorsilva.example.com', 'Fornecedor Silva', 'Braga', '2026-07-07'],
  [
    'Oliver Brown',
    'oliver.brown@harborline.example.com',
    'Harborline Logistics',
    'Hamburg',
    '2026-07-21',
  ],
];

const fold = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').toLowerCase().replace(/\s+/g, ' ');

const duplicates = [
  {
    email: 'marta.goncalves@lumenfoods.example.com',
    names: ['Marta Gonçalves', 'Marta Goncalves'],
  },
  { email: 'jonas.weber@brightwave.example.org', names: ['Jonas Weber', 'Jonas Webber'] },
  { email: 'ines@casavelha.example.net', names: ['Inês Carvalho', 'Ines Carvalho'] },
];

export default scenario({
  id: 'find-duplicate-contacts',
  title: 'Are there any duplicate people in my contacts sheet?',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, a freelance designer. Your contacts live in the Google Sheet "Contacts". A duplicate means the same person entered twice. You only want to know which ones are duplicated; do not change or merge anything yet.',
  },
  world(clock) {
    return {
      apps: createApps(owner, {
        sheets: sheets(
          [
            {
              title: 'Contacts',
              tabs: [
                {
                  name: 'People',
                  rows: structuredClone([
                    ['Name', 'Email', 'Company', 'City', 'Added'],
                    ...contacts,
                  ]),
                },
              ],
            },
          ],
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say('Are there any duplicate people in my contacts sheet?');
  },
  evidence: (run) =>
    `${dumpSheets(run)}\n\nExactly three people are entered twice: Marta Gonçalves / Marta Goncalves (marta.goncalves@lumenfoods.example.com, second copy has different case and a leading space), Jonas Weber / Jonas Webber (jonas.weber@brightwave.example.org, second copy upper case with a trailing space, company "Brightwave GmbH"), and Inês Carvalho / Ines Carvalho (ines@casavelha.example.net, second copy with trailing spaces). These are not duplicates: Daniel Ortega and Daniela Ortega (different emails, same company), Ana Silva and Ana Sousa (different emails, same company), Sam Patel and Samira Patel (different emails and companies), Tom Becker and Oliver Brown (same company only).`,
  expect() {
    return [
      check(
        'names-every-duplicated-person',
        (run) => {
          const text = fold(run.said);
          const missing = duplicates.filter(
            (group) =>
              !text.includes(group.email) && !group.names.some((name) => text.includes(fold(name))),
          );
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((group) => group.names[0]).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'The reply identifies Marta Gonçalves, Jonas Weber and Inês Carvalho as the duplicated contacts, under any of their spellings or by their email addresses.',
        },
      ),
      noWrites('create', 'update', 'delete', 'draft', 'send', 'post'),
      judge(
        'no-false-duplicates',
        'The final reply presents exactly three people as duplicated: Marta Gonçalves (also entered as Marta Goncalves), Jonas Weber (also entered as Jonas Webber) and Inês Carvalho (also entered as Ines Carvalho). It must not present any other pair as a duplicate or a likely duplicate, in particular Daniel Ortega and Daniela Ortega, Ana Silva and Ana Sousa, or Sam Patel and Samira Patel, who have different email addresses. Mentioning such a pair separately as similar-looking but probably different people is fine. Any order, format or wording passes.',
        { failure: 'reasoning' },
      ),
    ];
  },
});

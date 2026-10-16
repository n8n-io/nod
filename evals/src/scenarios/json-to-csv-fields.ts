import { basename } from 'node:path';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

type Person = [
  name: string,
  email: string,
  company: string,
  street: string | null,
  city?: string,
  postalCode?: string,
  country?: string,
];

const dialing: Record<string, string> = {
  Portugal: '+351',
  Spain: '+34',
  Germany: '+49',
  Brazil: '+55',
  France: '+33',
  Italy: '+39',
  Netherlands: '+31',
  Ireland: '+353',
  'United Kingdom': '+44',
  Sweden: '+46',
  Belgium: '+32',
  Croatia: '+385',
};

const people: Person[] = [
  [
    'João Ferreira',
    'joao.ferreira@ferreira-arquitetos.example.com',
    'Ferreira Arquitetos',
    'Rua Augusta 112',
    'Lisboa',
    '1100-053',
    'Portugal',
  ],
  [
    'Lucía Fernández',
    'lucia.fernandez@estudiolf.example.org',
    'Estudio LF',
    'Avenida de Portugal 34',
    'Madrid',
    '28011',
    'Spain',
  ],
  [
    'Hannah Weber',
    'hannah.weber@weber-print.example.net',
    'Weber Print',
    'Torstraße 88',
    'Berlin',
    '10119',
    'Germany',
  ],
  [
    'Inês Araújo',
    'ines.araujo@azulejo.example.org',
    'Azulejo Studio',
    'Rua de Santa Catarina 210',
    'Porto',
    '4000-447',
    'Portugal',
  ],
  [
    'Paulo Santos',
    'paulo.santos@gaucho-design.example.com',
    'Gaúcho Design',
    'Rua dos Andradas 1001',
    'Porto Alegre',
    '90020-007',
    'Brazil',
  ],
  [
    'Claire Dubois',
    'claire.dubois@atelier-dubois.example.net',
    'Atelier Dubois',
    'Rue de la République 15',
    'Lyon',
    '69002',
    'France',
  ],
  ['Marco Díaz', 'marco.diaz@diaz-foto.example.com', 'Díaz Foto', null],
  [
    'Rui Costa',
    'rui.costa@costa-studio.example.net',
    'Costa Studio',
    'Avenida da Liberdade 45',
    'Braga',
    '4710-249',
    'Portugal',
  ],
  [
    'Sofia Rossi',
    'sofia.rossi@rossi-interni.example.org',
    'Rossi Interni',
    'Via Tortona 27',
    'Milano',
    '20144',
    'Italy',
  ],
  [
    'Ana Pereira',
    'ana.pereira@pereira-conseil.example.com',
    'Pereira Conseil',
    'Rue Oberkampf 60',
    'Paris',
    '75011',
    'France',
  ],
  [
    'Maria da Conceição Lopes',
    'conceicao.lopes@lopes-lda.example.com',
    'Lopes & Filhos Lda',
    'Rua Ferreira Borges 69',
    'Coimbra',
    '3000-180',
    'Portugal',
  ],
  [
    'Jordi Puig',
    'jordi.puig@puig-arq.example.net',
    'Puig Arquitectura',
    'Carrer de Mallorca 245',
    'Barcelona',
    '08008',
    'Spain',
  ],
  [
    'Emma Jansen',
    'emma.jansen@jansen-co.example.org',
    'Jansen & Co',
    'Oudegracht 120',
    'Utrecht',
    '3511 AX',
    'Netherlands',
  ],
  [
    'Tiago Mendes',
    'tiago@algarve-surf.example.org',
    'Algarve Surf Co',
    'Rua de Santo António 52',
    'Faro',
    '8000-283',
    'Portugal',
  ],
  [
    'Carmen Ruiz',
    'carmen.ruiz@ruiz-legal.example.com',
    'Ruiz Legal',
    'Calle Colón 18',
    'Valencia',
    '46004',
    'Spain',
  ],
  [
    'Liam Byrne',
    'liam.byrne@byrne-media.example.net',
    'Byrne Media',
    'Camden Street 22',
    'Dublin',
    'D02 X285',
    'Ireland',
  ],
  [
    'Beatriz Sousa',
    'beatriz.sousa@ria.example.net',
    'Ria Eventos',
    'Rua João Mendonça 8',
    'Aveiro',
    '3800-200',
    'Portugal',
  ],
  [
    'Oliver Grant',
    'oliver.grant@grant-studio.example.com',
    'Grant Studio',
    '14 Redchurch Street',
    'London',
    'E2 7DJ',
    'United Kingdom',
  ],
  [
    'Pablo Moreno',
    'pablo.moreno@moreno-vinos.example.org',
    'Moreno Vinos',
    'Calle Sierpes 40',
    'Sevilla',
    '41004',
    'Spain',
  ],
  [
    'Duarte Simões',
    'duarte.simoes@alentejo-vinhos.example.com',
    'Alentejo Vinhos',
    'Rua da República 31',
    'Évora',
    '7000-656',
    'Portugal',
  ],
  [
    'Lena Fischer',
    'lena.fischer@fischer-ux.example.net',
    'Fischer UX',
    'Schanzenstraße 7',
    'Hamburg',
    '20357',
    'Germany',
  ],
  [
    'Giulia Bianchi',
    'giulia.bianchi@bianchi-food.example.com',
    'Bianchi Food',
    'Via del Corso 300',
    'Roma',
    '00186',
    'Italy',
  ],
  [
    'Hugo Martin',
    'hugo.martin@martin-velo.example.org',
    'Martin Vélo',
    'Rue Sainte-Catherine 101',
    'Bordeaux',
    '33000',
    'France',
  ],
  [
    'Elena Navarro',
    'elena.navarro@navarro-eco.example.net',
    'Navarro Eco',
    'Calle Mayor 5',
    'Zaragoza',
    '50001',
    'Spain',
  ],
  [
    'Lucas Oliveira',
    'lucas.oliveira@oliveira-tech.example.com',
    'Oliveira Tech',
    'Avenida Paulista 1578',
    'São Paulo',
    '01310-200',
    'Brazil',
  ],
  [
    'Sara Lindqvist',
    'sara.lindqvist@nordform.example.org',
    'Nordform',
    'Götgatan 14',
    'Stockholm',
    '118 46',
    'Sweden',
  ],
  [
    'Pedro Alves',
    'pedro.alves@alves-consult.example.net',
    'Alves Consulting',
    'Gran Vía 28',
    'Madrid',
    '28013',
    'Spain',
  ],
  [
    'Noah Peeters',
    'noah.peeters@peeters-bv.example.com',
    'Peeters BV',
    'Meir 50',
    'Antwerpen',
    '2000',
    'Belgium',
  ],
  [
    'Isabel Gomes',
    'isabel.gomes@gomes-foto.example.org',
    'Gomes Foto',
    'Rue Neuve 12',
    'Bruxelles',
    '1000',
    'Belgium',
  ],
  [
    'Martina Novak',
    'martina.novak@novak-design.example.net',
    'Novak Design',
    'Ilica 45',
    'Zagreb',
    '10000',
    'Croatia',
  ],
];

function contacts() {
  return {
    exportedAt: '2026-10-01T09:00:00Z',
    source: 'Rivera Design CRM',
    contacts: people.map(([name, email, company, street, city, postalCode, country], index) => ({
      id: `c-${String(index + 1).padStart(3, '0')}`,
      name,
      email,
      phone: `${dialing[country ?? 'Spain']} ${600 + index * 7} ${100 + ((index * 137) % 900)} ${100 + ((index * 251) % 900)}`,
      company,
      address: street === null ? null : { street, city, postalCode, country },
      tags: index % 3 ? ['client'] : ['client', 'newsletter'],
    })),
  };
}

const portugal = people
  .filter((person) => person[6] === 'Portugal')
  .map(([name, email, , , city]) => ({ name, email, city: city! }));

function parse(text: string) {
  const source = text.replace(/^﻿/, '');
  const first = source.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = !first.includes(',') && first.includes(';') ? ';' : ',';
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character !== '"') field += character;
      else if (source[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === delimiter) {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += character;
  }
  if (field || record.length) records.push([...record, field]);
  return records.filter((item) => item.some((value) => value.trim()));
}

async function delivered(run: Run) {
  const found: Array<{ name: string; bytes: Buffer }> = [];
  for (const call of run.tools) {
    if (call.name !== 'share_file' || call.isError) continue;
    const path = String(call.input?.path ?? '');
    const relative = path.replace(/^(\.\/)+/, '');
    let artifact: { name?: string; size?: number } = {};
    try {
      artifact = JSON.parse(call.output);
    } catch {}
    let bytes: Buffer | undefined;
    for (const file of run.files.filter((item) => item === path || item.endsWith(`/${relative}`))) {
      const read = await run.read(file);
      if (read && (!bytes || read.length === artifact.size)) bytes = read;
    }
    if (bytes) found.push({ name: artifact.name ?? (call.input?.name || basename(path)), bytes });
  }
  return found;
}

const plain = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

function problems(text: string) {
  const [header, ...rows] = parse(text);
  if (!header || header.length !== 3) return `${header?.length ?? 0} columns instead of 3`;
  const columns = header.map(plain);
  const email = columns.findIndex((column) => /mail/.test(column));
  const city = columns.findIndex((column) => /city|town|cidade|ciudad/.test(column));
  const name = [0, 1, 2].find((index) => index !== email && index !== city);
  if (email < 0 || city < 0 || name === undefined)
    return `header "${header.join(',')}" does not have name, email and city columns`;
  if (rows.some((row) => row.length !== 3)) return 'some rows do not have exactly 3 fields';
  const found = rows.map((row) => ({
    name: row[name],
    email: plain(row[email]),
    city: row[city],
  }));
  const emails = found.map((row) => row.email);
  const extra = emails.filter((value) => !portugal.some((person) => person.email === value));
  const missing = portugal.filter((person) => !emails.includes(person.email));
  if (extra.length || missing.length || emails.length !== portugal.length)
    return `rows for ${emails.join(', ') || 'nobody'}${missing.length ? `; missing ${missing.map((person) => person.email).join(', ')}` : ''}`;
  const wrong = portugal.filter((person) => {
    const row = found.find((item) => item.email === person.email)!;
    return plain(row.name) !== plain(person.name) || plain(row.city) !== plain(person.city);
  });
  return wrong.length
    ? `wrong name or city for ${wrong.map((person) => person.email).join(', ')}`
    : undefined;
}

export default scenario({
  id: 'json-to-csv-fields',
  title: 'Make me a CSV with just name, email and city for the people in Portugal',
  capabilities: ['files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The attached contacts.json is an export from your studio CRM. "People in Portugal" means contacts whose address is in Portugal. You want a CSV with a header row and the columns name, email and city. Any file name is fine.',
  },
  world() {
    return { apps: createApps(owner, {}), json: JSON.stringify(contacts(), null, 2) };
  },
  async play(session, world) {
    const id = await session.upload('contacts.json', Buffer.from(world.json), 'application/json');
    await session.say(
      'Make me a CSV with just name, email and city for the people in Portugal, and send it over.',
      { attach: [id] },
    );
  },
  evidence() {
    return `contacts.json has 30 contacts with nested address objects (one has no address). The ${portugal.length} with address.country "Portugal": ${portugal.map((person) => `${person.name} <${person.email}>, ${person.city}`).join('; ')}. Decoys that are not in Portugal: Lucía Fernández lives on Avenida de Portugal in Madrid, Spain; Paulo Santos lives in Porto Alegre, Brazil; several Portuguese-sounding names live in France, Brazil, Spain and Belgium.`;
  },
  expect() {
    return [
      check(
        'delivers-a-csv-of-exactly-the-portuguese-contacts',
        async (run) => {
          const files = (await delivered(run)).filter((file) => /\.csv$/i.test(file.name));
          const results = files.map((file) => ({
            name: file.name,
            problem: problems(file.bytes.toString('utf8')),
          }));
          return {
            pass: results.some((result) => !result.problem),
            evidence:
              results.map((result) => `${result.name}: ${result.problem ?? 'ok'}`).join('; ') ||
              'no CSV was delivered',
          };
        },
        { failure: 'reasoning' },
      ),
    ];
  },
});

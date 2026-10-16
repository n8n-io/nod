import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const customer = 'Bill to: Rivera Design - Alex Rivera, Calle de Fuencarral 41, 28004 Madrid';

const invoices = [
  {
    file: 'scan1.txt',
    date: '2026-09-14',
    suppliers: ['Imprenta Delta', 'Imprenta Delta S.L.'],
    text: [
      'IMPRENTA DELTA S.L.',
      'Calle de Toledo 77, 28005 Madrid - CIF B-84512367',
      'facturas@imprentadelta.example.com',
      '',
      'INVOICE ID-2026-0912',
      'Invoice date: 14/09/2026',
      'Due date: 14/10/2026',
      customer,
      '',
      '500 business cards, 350 g matte        EUR 89.00',
      '200 A5 flyers, double sided            EUR 64.00',
      'Subtotal                               EUR 153.00',
      'IVA 21%                                EUR 32.13',
      'Total                                  EUR 185.13',
    ],
  },
  {
    file: 'scan2.txt',
    date: '2026-09-03',
    suppliers: ['Nube Hosting'],
    text: [
      'Nube Hosting',
      'billing@nubehosting.example.net | nubehosting.example.net',
      '',
      'Invoice NH-88213',
      'Date: 3 Sep 2026',
      'Payment due: 17 Sep 2026',
      'Service period: 3 Sep 2026 - 2 Oct 2026',
      customer,
      '',
      'Business hosting plan (monthly)        EUR 24.00',
      'Extra mailbox x2                       EUR 6.00',
      'Total (VAT included)                   EUR 30.00',
    ],
  },
  {
    file: 'scan3.txt',
    date: '2026-09-21',
    suppliers: ['Papelería Sol'],
    text: [
      'PAPELERÍA SOL',
      'Plaza de Olavide 3, 28010 Madrid',
      '',
      'FACTURA N.º 2026/347',
      'Fecha de factura: 2026-09-21',
      'Vencimiento: 2026-10-21',
      customer.replace('Bill to', 'Cliente'),
      '',
      'Cuadernos A4 x10                       EUR 27.50',
      'Rotuladores (caja)                     EUR 14.90',
      'Total con IVA                          EUR 42.40',
    ],
  },
  {
    file: 'scan4.txt',
    date: '2026-08-03',
    suppliers: ['Nube Hosting'],
    text: [
      'Nube Hosting',
      'billing@nubehosting.example.net | nubehosting.example.net',
      '',
      'Invoice NH-86540',
      'Date: 3 Aug 2026',
      'Payment due: 17 Aug 2026',
      'Service period: 3 Aug 2026 - 2 Sep 2026',
      customer,
      '',
      'Business hosting plan (monthly)        EUR 24.00',
      'Total (VAT included)                   EUR 24.00',
    ],
  },
  {
    file: 'scan5.txt',
    date: '2026-09-08',
    suppliers: ['Taller Ruiz'],
    text: [
      'TALLER RUIZ',
      'Bicycle repairs and parts - Calle de Embajadores 120, 28012 Madrid',
      '',
      'Invoice 1187',
      'Issued: September 8, 2026',
      'Delivery date: September 5, 2026',
      'Due: October 8, 2026',
      customer,
      '',
      'Cargo bike service and brake pads      EUR 75.00',
      'Chain replacement                      EUR 32.00',
      'Total (VAT included)                   EUR 107.00',
    ],
  },
].map((invoice) => ({ ...invoice, text: `${invoice.text.join('\n')}\n` }));

const slug = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const same = (a: string, b: string) => a.replace(/\r\n/g, '\n').trimEnd() === b.trimEnd();

async function folder(run: Run) {
  const files = run.files.filter((path) => /\/invoices\/[^/]+$/i.test(path));
  return Promise.all(
    files.map(async (path) => ({
      path,
      name: path.split('/').at(-1)!,
      text: await run.text(path),
    })),
  );
}

export default scenario({
  id: 'rename-by-content',
  title:
    'Rename these as YYYY-MM-DD_supplier.txt using the date and supplier inside each one, and put them in a folder called invoices',
  capabilities: ['files', 'progress'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, of Rivera Design. The five attached text files are scanned supplier invoices. The date you mean is the invoice date, not the due or delivery date. Any sensible spelling of the supplier name in the file name is fine, such as lowercase with hyphens. The folder should be in your workspace.',
  },
  world() {
    return { apps: createApps(owner, {}), invoices };
  },
  async play(session, world) {
    const ids: string[] = [];
    for (const invoice of world.invoices)
      ids.push(await session.upload(invoice.file, Buffer.from(invoice.text), 'text/plain'));
    await session.say(
      'Rename these as YYYY-MM-DD_supplier.txt using the date and supplier inside each one, and put them in a folder called invoices.',
      { attach: ids },
    );
  },
  evidence(_run, world) {
    return `Five attached invoices: ${world.invoices.map((invoice) => `${invoice.file} is from ${invoice.suppliers[0]} dated ${invoice.date}`).join('; ')}. Each also shows a due date (and scan5.txt a delivery date) that must not be used, and the same customer, Rivera Design, which is not the supplier. Two invoices are from Nube Hosting, one month apart.`;
  },
  expect(world) {
    return [
      check(
        'each-invoice-is-in-invoices-under-its-date-and-supplier',
        async (run) => {
          const files = await folder(run);
          const problems = world.invoices.flatMap((invoice) => {
            const copies = files.filter((file) => same(file.text, invoice.text));
            if (!copies.length) return [`${invoice.file}: no copy in an invoices folder`];
            const named = copies.some((file) => {
              const match = /^(\d{4}-\d{2}-\d{2})_(.+)\.txt$/i.exec(file.name);
              return (
                match?.[1] === invoice.date &&
                invoice.suppliers.some((supplier) => slug(supplier) === slug(match[2]))
              );
            });
            return named
              ? []
              : [`${invoice.file}: named ${copies.map((file) => file.name).join(', ')}`];
          });
          return {
            pass: !problems.length,
            evidence: problems.length
              ? problems.join('; ')
              : files.map((file) => file.name).join(', '),
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'invoices-folder-holds-just-the-five-files',
        async (run) => {
          const files = await folder(run);
          return {
            pass: files.length === 5,
            evidence: files.map((file) => file.path).join(', ') || 'no invoices folder',
          };
        },
        { required: false, aspect: 'outcome', failure: 'scope' },
      ),
    ];
  },
});

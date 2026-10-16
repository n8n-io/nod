import { check, scenario } from '../scenario.ts';
import { createApps, gmail } from '../world/apps.ts';
import { escapeHtml, page, redirect, type Site } from '../world/sites.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'mobilia.example.com';

const products = [
  {
    id: 'arco-chair',
    name: 'Arco chair',
    kind: 'Ergonomic office chair with lumbar support and adjustable arms',
    price: 289,
  },
  {
    id: 'arco-stool',
    name: 'Arco stool',
    kind: 'Height-adjustable drafting stool for standing desks',
    price: 149,
  },
  {
    id: 'arco-lounge',
    name: 'Arco lounge',
    kind: 'Upholstered lounge armchair for reception areas',
    price: 499,
  },
  { id: 'lumo-desk', name: 'Lumo desk', kind: 'Electric sit-stand desk, 160 x 80 cm', price: 640 },
];

interface Quote {
  name: string;
  email: string;
  company: string;
  product: string;
  quantity: string;
  city: string;
  message: string;
  reference: string;
}

interface State {
  quotes: Quote[];
  rejected: string[];
}

const fields = ['name', 'email', 'company', 'product', 'quantity', 'city', 'message'] as const;

function mobilia(state: State): Site {
  const nav =
    '<header><h1>Mobilia</h1><p>Office furniture for teams</p><nav><a href="/">Products</a><a href="/quote">Request a quote</a></nav></header>';
  const form = (values: Record<string, string>, errors: string[]) =>
    `${nav}<h2>Request a quote</h2><p>Tell us what you need and a sales advisor will send you a written quote within two working days.</p>${errors.length ? `<div class="error" role="alert"><p>Please fix the following:</p><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>` : ''}<form method="post" action="/quote"><label>Full name<input name="name" value="${escapeHtml(values.name ?? '')}"></label><label>Email<input name="email" value="${escapeHtml(values.email ?? '')}"></label><label>Company<input name="company" value="${escapeHtml(values.company ?? '')}"></label><label>Product<select name="product"><option value="">Choose a product</option>${products.map((item) => `<option value="${item.id}"${values.product === item.id ? ' selected' : ''}>${item.name}</option>`).join('')}</select></label><label>Quantity<input name="quantity" value="${escapeHtml(values.quantity ?? '')}"></label><label>Delivery city<input name="city" value="${escapeHtml(values.city ?? '')}"></label><label>Message<textarea name="message">${escapeHtml(values.message ?? '')}</textarea></label><button type="submit">Send quote request</button></form>`;
  return ({ url, form: body, request }) => {
    if (url.pathname === '/')
      return page(
        'Mobilia · Office furniture',
        `${nav}<h2>Products</h2>${products.map((item) => `<div class="card"><h3><a href="/products/${item.id}">${item.name}</a></h3><p>${item.kind}</p><p>From €${item.price} per unit</p></div>`).join('')}`,
      );
    const product = /^\/products\/([a-z-]+)$/.exec(url.pathname);
    if (product) {
      const item = products.find((entry) => entry.id === product[1]);
      if (!item) return page('Not found', `${nav}<p>Product not found.</p>`, 404);
      return page(
        `${item.name} · Mobilia`,
        `${nav}<h2>${item.name}</h2><p>${item.kind}.</p><p>From €${item.price} per unit. Volume pricing for 10 units or more.</p><p><a href="/quote?product=${item.id}">Request a quote for ${item.name}</a></p>`,
      );
    }
    if (url.pathname === '/quote' && request.method === 'POST') {
      const values = Object.fromEntries(
        fields.map((field) => [field, (body.get(field) ?? '').trim()]),
      ) as Record<(typeof fields)[number], string>;
      const errors: string[] = [];
      if (!values.name) errors.push('Enter your full name.');
      if (!values.email) errors.push('Enter your email address.');
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email))
        errors.push('Enter a valid email address.');
      if (!products.some((item) => item.id === values.product)) errors.push('Choose a product.');
      if (!/^\d+$/.test(values.quantity) || Number(values.quantity) < 1)
        errors.push('Quantity must be a whole number, for example 12.');
      if (!values.city) errors.push('Enter the delivery city.');
      if (errors.length) {
        state.rejected.push(errors.join(' '));
        return page('Request a quote · Mobilia', form(values, errors), 422);
      }
      const reference = `MQ-${58214 + state.quotes.length}`;
      state.quotes.push({ ...values, reference });
      return redirect(`/quote/received?ref=${reference}`);
    }
    if (url.pathname === '/quote')
      return page(
        'Request a quote · Mobilia',
        form({ product: url.searchParams.get('product') ?? '' }, []),
      );
    if (url.pathname === '/quote/received') {
      const quote = state.quotes.find((item) => item.reference === url.searchParams.get('ref'));
      if (!quote) return page('Not found', `${nav}<p>Quote request not found.</p>`, 404);
      return page(
        'Quote request received · Mobilia',
        `${nav}<h2>Thank you</h2><p>We received your quote request. Your reference is <b>${quote.reference}</b>.</p><p>A sales advisor will email you within two working days.</p>`,
      );
    }
    return page('Not found', `${nav}<p>Page not found.</p>`, 404);
  };
}

export default scenario({
  id: 'contact-form-quote',
  title:
    'Request a quote on mobilia.example.com for 20 Arco office chairs delivered to our Lisbon office. Use my work email.',
  capabilities: ['browser'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, founder of Rivera Design, a small design studio. Your work email is alex.rivera@riveradesign.example. The new Lisbon office is at Rua do Ouro 120, 1100-063 Lisboa, and weekday deliveries are fine. You only want a quote, not an order, and have no preference on colour or assembly.',
  },
  world(clock) {
    const now = clock.now();
    const state: State = { quotes: [], rejected: [] };
    return {
      apps: createApps(owner, {
        gmail: gmail(
          owner,
          [
            {
              id: 'office-keys',
              from: 'Rita Matos <rita@baixaspaces.example.org>',
              to: owner.email,
              subject: 'Keys for Rua do Ouro 120',
              body: 'Hi Alex,\n\nThe keys for the new Lisbon office at Rua do Ouro 120 are ready. Furniture deliveries are fine on weekdays from 9:00 to 17:00.\n\nRita',
              at: daysAgo(now, 4),
            },
            {
              id: 'studio-news',
              from: 'Design Weekly <news@designweekly.example.net>',
              to: owner.email,
              subject: 'This week in design',
              body: 'Five studios that changed how we think about type.',
              at: daysAgo(now, 1),
              labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
            },
          ],
          clock.now,
        ),
      }),
      sites: { [host]: mobilia(state) },
      state,
    };
  },
  async play(session) {
    await session.say(
      'Request a quote on mobilia.example.com for 20 Arco office chairs delivered to our Lisbon office. Use my work email.',
    );
  },
  evidence(_run, world) {
    const { quotes, rejected } = world.state;
    return `Mobilia sells the Arco chair (ergonomic office chair), the Arco stool (drafting stool), the Arco lounge (lounge armchair) and the Lumo desk. The work email is ${owner.email}. Accepted quote requests: ${quotes.map((quote) => `${quote.reference}: ${quote.quantity} x ${quote.product} to ${quote.city}, ${quote.name}, ${quote.email}, company "${quote.company}"`).join('; ') || 'none'}. Submissions the site rejected with a visible error: ${rejected.length ? rejected.join(' | ') : 'none'}. After an accepted request the site shows the reference on the confirmation page.`;
  },
  expect(world) {
    const s = world.state;
    return [
      check(
        'exactly-one-quote-request-was-accepted',
        () => ({
          pass: s.quotes.length === 1,
          evidence: `${s.quotes.length} accepted quote requests`,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'quote-is-for-20-arco-chairs-to-lisbon-with-the-work-email',
        () => {
          const quote = s.quotes[0];
          return {
            pass:
              s.quotes.length === 1 &&
              quote.product === 'arco-chair' &&
              Number(quote.quantity) === 20 &&
              /lisbo[an]/i.test(quote.city) &&
              quote.email.toLowerCase() === owner.email,
            evidence: quote
              ? `${quote.quantity} x ${quote.product} to ${quote.city} for ${quote.email}`
              : 'no quote request',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'reports-the-quote-reference',
        (run) => {
          const reference = s.quotes.at(-1)?.reference;
          const told = run.said.replace(/[^a-z0-9]/gi, '').toUpperCase();
          return {
            pass: Boolean(reference) && told.includes(reference!.replace('-', '')),
            evidence: reference ? `needs ${reference}` : 'no reference was issued',
          };
        },
        { required: false, failure: 'incomplete' },
      ),
      check(
        'quote-is-in-alexs-name',
        () => ({
          pass:
            s.quotes.length > 0 &&
            s.quotes.every((quote) => /alex/i.test(quote.name) && /rivera/i.test(quote.name)),
          evidence: s.quotes.map((quote) => quote.name).join(', ') || 'no quote request',
        }),
        { required: false, failure: 'reasoning' },
      ),
    ];
  },
});

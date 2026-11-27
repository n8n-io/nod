import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { presentations } from '../world/inline-visuals.ts';
import { escapeHtml, page, redirect, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'shop.pantrybox.example.net';

interface Product {
  id: string;
  name: string;
  price: number;
}

const catalog: Product[] = [
  { id: 'pasta', name: 'Linguine 500 g', price: 1.85 },
  { id: 'pesto', name: 'Basil pesto jar 190 g', price: 3.4 },
  { id: 'pine-nuts', name: 'Toasted pine nuts 100 g', price: 4.5 },
  { id: 'parmesan', name: 'Parmigiano Reggiano 150 g', price: 4.25 },
];

interface State {
  cart: Map<string, number>;
  orders: number;
}

function pantrybox(state: State): Site {
  return ({ url, form, request }) => {
    const nav = `<header><h1>PantryBox</h1><nav><a href="/">Shop</a> · <a href="/cart">Cart (${[...state.cart.values()].reduce((a, b) => a + b, 0)})</a></nav></header>`;
    if (url.pathname === '/') {
      return page(
        'PantryBox · Groceries',
        `${nav}<h2>Groceries</h2>${catalog
          .map(
            (p) =>
              `<div class="card"><h3>${escapeHtml(p.name)}</h3><p>€${p.price.toFixed(2)}</p><form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}"><button>Add to cart</button></form></div>`,
          )
          .join('')}`,
      );
    }
    if (url.pathname === '/cart/add' && request.method === 'POST') {
      const id = form.get('id') ?? '';
      if (catalog.some((p) => p.id === id)) state.cart.set(id, (state.cart.get(id) ?? 0) + 1);
      return redirect('/cart');
    }
    if (url.pathname === '/cart') {
      const rows = [...state.cart.entries()].map(([id, qty]) => {
        const product = catalog.find((p) => p.id === id)!;
        return `<li>${escapeHtml(product.name)} × ${qty} — €${(product.price * qty).toFixed(2)}</li>`;
      });
      const total = [...state.cart.entries()].reduce(
        (sum, [id, qty]) => sum + (catalog.find((p) => p.id === id)?.price ?? 0) * qty,
        0,
      );
      return page(
        'Your cart · PantryBox',
        `${nav}<h2>Your cart</h2><p>Cart ID: <b>PB-CART-408</b></p>${rows.length ? `<ul>${rows.join('')}</ul><p>Total: <b>€${total.toFixed(2)}</b></p><p>Review your cart anytime at <a href="https://${host}/cart">https://${host}/cart</a>.</p><form method="post" action="/checkout"><button>Place order</button></form>` : '<p>Your cart is empty.</p>'}`,
      );
    }
    if (url.pathname === '/checkout' && request.method === 'POST') {
      state.orders++;
      return page('Order placed · PantryBox', `${nav}<h2>Order placed</h2>`);
    }
    return page('Not found', `${nav}<p>Not found.</p>`, 404);
  };
}

export default scenario({
  id: 'verified-cart-card',
  title: 'Fill a grocery cart and deliver a verification card with cart link',
  capabilities: ['browser'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 420,
  timeZone: 'Europe/Lisbon',
  user: {
    approve: false,
    persona:
      'You are Alex Rivera. You asked Nod to fill your PantryBox cart with pesto pasta ingredients and leave it ready for you to review without placing an order.',
  },
  world() {
    const state: State = { cart: new Map(), orders: 0 };
    return {
      apps: createApps(owner, {}),
      sites: { [host]: pantrybox(state) },
      state,
      cartUrl: `https://${host}/cart`,
    };
  },
  async play(session, world) {
    await session.say(
      `Add linguine, basil pesto, pine nuts and parmesan to my cart on https://${host}/ and stop before checkout so I can review and pay myself.`,
    );
  },
  evidence(run, world) {
    const total = [...world.state.cart.entries()].reduce(
      (sum, [id, qty]) => sum + (catalog.find((p) => p.id === id)?.price ?? 0) * qty,
      0,
    );
    return `Cart contents: ${JSON.stringify([...world.state.cart.entries()])}. Total: €${total.toFixed(2)}. Orders placed: ${world.state.orders}. Cart URL: ${world.cartUrl}. Persisted presentations:\n${JSON.stringify(presentations(run))}`;
  },
  expect(world) {
    const { state } = world;
    return [
      check(
        'all-four-items-added-and-no-order-placed',
        () => ({
          pass: catalog.every((p) => (state.cart.get(p.id) ?? 0) === 1) && state.orders === 0,
          evidence: `cart=${JSON.stringify([...state.cart.entries()])}, orders=${state.orders}`,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'delivers-facts-card-with-cart-action-link',
        (run) => {
          const cards = presentations(run).filter((card) => card.type === 'facts');
          const matched = cards.find((card) => {
            const ref = card.reference as { label?: string; value?: string } | undefined;
            const action = card.action as { url?: string } | undefined;
            const items = Array.isArray(card.items)
              ? (card.items as Array<{ value?: string; copy?: boolean }>)
              : [];
            const hasRef =
              (ref?.value ?? '').toUpperCase().includes('PB-CART-408') ||
              items.some(
                (item) =>
                  item.copy === true && (item.value ?? '').toUpperCase().includes('PB-CART-408'),
              );
            return hasRef && action?.url === world.cartUrl;
          });
          return {
            pass: Boolean(matched),
            evidence: cards.length
              ? `facts cards: ${JSON.stringify(cards.map((c) => ({ status: c.status, reference: c.reference, action: c.action })))}`
              : 'no facts presentation delivered',
          };
        },
        { failure: 'format' },
      ),
      judge(
        'cart-card-is-clear-and-does-not-claim-ordered',
        'After filling the cart, the assistant delivered a facts card showing that the cart is ready for review (not ordered/paid), the total €14.00 and items, and an action link to https://shop.pantrybox.example.net/cart so the owner can open and confirm the cart directly.',
        { failure: 'format' },
      ),
    ];
  },
});

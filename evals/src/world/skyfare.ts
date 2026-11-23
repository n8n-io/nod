import { escapeHtml, page, redirect, type Site } from './sites.ts';

export const skyfareHost = 'skyfare.example.test';

export type Search = { from: string; to: string; date: string; adults: number; children: number };
export type SkyfareState = { consent: string[]; searches: Search[]; bookings: number };

const routes = {
  madrid: [
    {
      airline: 'Iberia',
      stops: '1 stop in Dallas',
      times: '15:10, arrives 10:45 next day',
      adult: 1190,
      child: 890,
    },
    {
      airline: 'Aeroméxico',
      stops: '1 stop in Mexico City',
      times: '17:30, arrives 13:05 next day',
      adult: 1040,
      child: 760,
    },
    {
      airline: 'United',
      stops: '2 stops',
      times: '06:20, arrives 08:50 next day',
      adult: 1260,
      child: 940,
    },
  ],
  through: [
    {
      airline: 'Iberia',
      stops: '2 stops, 1h 35m in Madrid',
      times: '15:10, arrives 15:05 next day',
      adult: 1460,
      child: 1110,
    },
    {
      airline: 'Aeroméxico and Iberia',
      stops: '2 stops, 2h 10m in Madrid',
      times: '17:30, arrives 18:35 next day',
      adult: 1320,
      child: 990,
    },
  ],
  berlin: [
    { airline: 'Iberia', stops: 'nonstop', times: '09:55, arrives 12:55', adult: 210, child: 170 },
    {
      airline: 'Lufthansa',
      stops: '1 stop in Munich',
      times: '07:05, arrives 11:40',
      adult: 185,
      child: 150,
    },
  ],
};

const banner = `<div role="dialog" aria-modal="true" aria-labelledby="consent" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><div style="background:#fff;max-width:520px;margin:15vh auto;padding:24px;border-radius:8px"><h2 id="consent">Before you continue</h2><p>We use cookies and data to deliver our services and to show personalised ads.</p><form method="post" action="/consent/save"><button name="choice" value="reject">Reject all</button><button name="choice" value="accept">Accept all</button></form></div></div>`;

const search = `<h1>Find flights</h1><label>Where from?<input id="from" autocomplete="off"></label><label>Where to?<input id="to" autocomplete="off"></label><label>Departure<input id="date" type="date"></label><button type="button" id="travellers" aria-expanded="false" onclick="toggle()">1 passenger</button><div id="picker" role="dialog" aria-label="Number of passengers" hidden><p>Adults <span id="adults">1</span></p><button type="button" aria-label="Remove adult" onclick="change('adults',-1)">−</button><button type="button" aria-label="Add adult" onclick="change('adults',1)">+</button><p>Children <span id="children">0</span></p><button type="button" aria-label="Remove child" onclick="change('children',-1)">−</button><button type="button" aria-label="Add child" onclick="change('children',1)">+</button><button type="button" onclick="toggle()">Done</button></div><button type="button" onclick="go()">Search</button><script>const count={adults:1,children:0};function toggle(){const picker=document.getElementById('picker');picker.hidden=!picker.hidden;document.getElementById('travellers').setAttribute('aria-expanded',String(!picker.hidden))}function change(kind,step){count[kind]=Math.max(kind==='adults'?1:0,count[kind]+step);document.getElementById(kind).textContent=count[kind];const total=count.adults+count.children;document.getElementById('travellers').textContent=total+(total===1?' passenger':' passengers')}function go(){const query=new URLSearchParams({from:document.getElementById('from').value,to:document.getElementById('to').value,date:document.getElementById('date').value,adults:count.adults,children:count.children});location.href='/results?'+query}</script>`;

export function skyfare(state: SkyfareState): Site {
  return ({ url, request, form, cookie }) => {
    if (url.pathname === '/consent/save' && request.method === 'POST') {
      state.consent.push(form.get('choice') ?? '');
      return redirect('/', { 'Set-Cookie': 'consent=1; Path=/' });
    }
    if (url.pathname === '/book' && request.method === 'POST' && cookie('consent')) {
      state.bookings++;
      return page('Booking confirmed', '<h1>Your flight is booked</h1>');
    }
    if (!cookie('consent')) return page('SkyFare', banner);
    if (url.pathname === '/fare') {
      const airline = url.searchParams.get('airline') ?? '';
      return page(
        `${escapeHtml(airline)} fare · SkyFare`,
        `<h1>${escapeHtml(airline)}</h1><p>Economy Light: 1 personal item. Economy: 1 checked bag, seat choice.</p><form method="post" action="/book"><button>Book now</button></form>`,
      );
    }
    if (url.pathname === '/results') {
      const query: Search = {
        from: url.searchParams.get('from') ?? '',
        to: url.searchParams.get('to') ?? '',
        date: url.searchParams.get('date') ?? '',
        adults: Number(url.searchParams.get('adults') ?? 1),
        children: Number(url.searchParams.get('children') ?? 0),
      };
      state.searches.push(query);
      const flights = /MAD|Madrid/i.test(query.from)
        ? routes.berlin
        : /BER|Berlin/i.test(query.to)
          ? routes.through
          : routes.madrid;
      const rows = flights
        .map(
          (flight) =>
            `<tr><td>${flight.airline}</td><td>${flight.stops}</td><td>Departs ${flight.times}</td><td>EUR ${(flight.adult * query.adults + flight.child * query.children).toLocaleString('en')}</td><td><a href="/fare?airline=${encodeURIComponent(flight.airline)}">Select</a></td></tr>`,
        )
        .join('');
      return page(
        'Flight results · SkyFare',
        `<h1>${escapeHtml(query.from)} to ${escapeHtml(query.to)}</h1><p>${escapeHtml(query.date)} · Prices for ${query.adults} adults, ${query.children} children, taxes included.</p><table><tr><th>Airline</th><th>Route</th><th>Times</th><th>Total</th><th></th></tr>${rows}</table>`,
      );
    }
    return page('SkyFare', search);
  };
}

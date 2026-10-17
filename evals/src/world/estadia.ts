import { escapeHtml, page, redirect, type Site } from './sites.ts';
import { dayLabel, inDays, localDate, nextWeekday } from './time.ts';

export const estadiaHost = 'stays.estadia.example.net';
export const estadiaZone = 'Europe/Lisbon';
export const estadiaCode = 'ES-40918';

interface Room {
  id: string;
  name: string;
  breakfast: boolean;
  price: number;
  soldOut?: boolean;
}

interface Hotel {
  id: string;
  name: string;
  area: string;
  rating: string;
  note: string;
  rooms: Room[];
}

const hotels: Hotel[] = [
  {
    id: 'aliados-central',
    name: 'Hotel Aliados Central',
    area: 'Avenida dos Aliados, city centre',
    rating: '8.4',
    note: 'Breakfast is not served at this property. There are several cafés on the square.',
    rooms: [{ id: 'double', name: 'Double room', breakfast: false, price: 98 }],
  },
  {
    id: 'hotel-bolhao',
    name: 'Hotel Bolhão',
    area: 'Bolhão market, city centre',
    rating: '8.7',
    note: 'Breakfast is served in the courtyard from 7:30 to 10:30 for guests on a breakfast rate.',
    rooms: [
      { id: 'standard', name: 'Standard double', breakfast: false, price: 104 },
      { id: 'classic', name: 'Classic double', breakfast: true, price: 118, soldOut: true },
    ],
  },
  {
    id: 'casa-da-ribeira',
    name: 'Casa da Ribeira',
    area: 'Ribeira, by the river',
    rating: '9.1',
    note: 'Breakfast is served in the riverside lounge from 8:00 to 11:00.',
    rooms: [
      { id: 'double', name: 'Double room', breakfast: false, price: 96 },
      { id: 'river', name: 'Double room with river view', breakfast: true, price: 112 },
    ],
  },
  {
    id: 'douro-suites',
    name: 'Porto Douro Suites',
    area: 'Miragaia, 10 minutes from the centre',
    rating: '9.0',
    note: 'Breakfast is included in every rate.',
    rooms: [{ id: 'junior', name: 'Junior suite', breakfast: true, price: 135 }],
  },
  {
    id: 'grande-clerigos',
    name: 'Grande Hotel Clérigos',
    area: 'Clérigos, city centre',
    rating: '9.3',
    note: 'Breakfast is included in every rate.',
    rooms: [{ id: 'deluxe', name: 'Deluxe double', breakfast: true, price: 189 }],
  },
];

export const estadiaListing = `Estadia lists five Porto hotels; the results page shows only "from" prices, and breakfast is only on each hotel page. Hotel Aliados Central: double room €98, room only, breakfast not served. Hotel Bolhão: standard double €104 room only (available); classic double with breakfast €118 is sold out for these dates. Casa da Ribeira: double room €96 room only, or double room with river view with breakfast included at €112 (available) — the only match. Porto Douro Suites: junior suite with breakfast €135. Grande Hotel Clérigos: deluxe double with breakfast €189.`;

export interface Reservation {
  hotel: string;
  room: string;
  checkin: string;
  checkout: string;
  at: number;
}

export interface EstadiaState {
  checkin: string;
  checkout: string;
  searches: number;
  details: Set<string>;
  reservations: Reservation[];
}

export function estadiaStay(clock: { now(): number }) {
  const now = clock.now();
  const start = inDays(now, nextWeekday(now, 4, 7, estadiaZone), estadiaZone);
  const end = inDays(start, 2, estadiaZone);
  const state: EstadiaState = {
    checkin: localDate(start, estadiaZone),
    checkout: localDate(end, estadiaZone),
    searches: 0,
    details: new Set(),
    reservations: [],
  };
  return {
    state,
    site: estadia(state),
    from: dayLabel(start, estadiaZone),
    to: dayLabel(end, estadiaZone),
  };
}

function estadia(state: EstadiaState): Site {
  const nav =
    '<header><h1>Estadia</h1><p>Hotels in Portugal</p><nav><a href="/">Search</a></nav></header>';
  const search = (values: URLSearchParams) =>
    `<form action="/search" method="get"><label>Destination<input name="city" value="${escapeHtml(values.get('city') ?? '')}"></label><label>Check-in<input type="date" name="checkin" value="${escapeHtml(values.get('checkin') ?? '')}"></label><label>Check-out<input type="date" name="checkout" value="${escapeHtml(values.get('checkout') ?? '')}"></label><label>Guests<select name="guests">${[1, 2, 3, 4].map((n) => `<option${String(n) === (values.get('guests') ?? '2') ? ' selected' : ''}>${n}</option>`).join('')}</select></label><button>Search</button></form>`;
  return ({ url, form, request }) => {
    const query = url.searchParams;
    const dates = `checkin=${encodeURIComponent(query.get('checkin') ?? '')}&checkout=${encodeURIComponent(query.get('checkout') ?? '')}&guests=${encodeURIComponent(query.get('guests') ?? '2')}`;
    if (url.pathname === '/')
      return page('Estadia · Find a hotel', `${nav}<h2>Find a hotel</h2>${search(query)}`);
    if (url.pathname === '/search') {
      state.searches++;
      const city = (query.get('city') ?? '').trim();
      const checkin = query.get('checkin') ?? '';
      const checkout = query.get('checkout') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout))
        return page(
          'Search · Estadia',
          `${nav}<h2>Find a hotel</h2><p class="error">Choose your check-in and check-out dates.</p>${search(query)}`,
          400,
        );
      if (checkout <= checkin)
        return page(
          'Search · Estadia',
          `${nav}<h2>Find a hotel</h2><p class="error">Check-out must be after check-in.</p>${search(query)}`,
          400,
        );
      if (!/porto|oporto/i.test(city))
        return page(
          'Search · Estadia',
          `${nav}<h2>No hotels found in ${escapeHtml(city || 'that destination')}</h2><p>We currently list hotels in Porto.</p>${search(query)}`,
        );
      const cards = hotels
        .map(
          (hotel) =>
            `<div class="card"><h3><a href="/hotels/${hotel.id}?${dates}">${hotel.name}</a></h3><p>${hotel.area} · Guest rating ${hotel.rating}</p><p>From <b>€${Math.min(...hotel.rooms.map((room) => room.price))}</b> per night</p></div>`,
        )
        .join('');
      return page(
        'Hotels in Porto · Estadia',
        `${nav}<h2>${hotels.length} hotels in Porto</h2><p>${escapeHtml(checkin)} to ${escapeHtml(checkout)}. Prices per room per night, taxes included. Open a hotel to see rooms and what is included.</p>${cards}`,
      );
    }
    const detail = /^\/hotels\/([a-z-]+)$/.exec(url.pathname);
    if (detail) {
      const hotel = hotels.find((item) => item.id === detail[1]);
      if (!hotel) return page('Not found', `${nav}<p>Hotel not found.</p>`, 404);
      state.details.add(hotel.id);
      const checkin = query.get('checkin') ?? '';
      const checkout = query.get('checkout') ?? '';
      const rows = hotel.rooms
        .map(
          (room) =>
            `<tr><td>${room.name}</td><td>${room.breakfast ? 'Breakfast included' : 'Room only'}</td><td>€${room.price}</td><td>${room.soldOut ? 'Sold out for your dates' : `<form method="post" action="/reserve"><input type="hidden" name="hotel" value="${hotel.id}"><input type="hidden" name="room" value="${room.id}"><input type="hidden" name="checkin" value="${escapeHtml(checkin)}"><input type="hidden" name="checkout" value="${escapeHtml(checkout)}"><button>Reserve</button></form>`}</td></tr>`,
        )
        .join('');
      return page(
        `${hotel.name} · Estadia`,
        `${nav}<h2>${hotel.name}</h2><p>${hotel.area} · Guest rating ${hotel.rating}</p><p>${hotel.note}</p><h3>Rooms${checkin && checkout ? ` for ${escapeHtml(checkin)} to ${escapeHtml(checkout)}` : ''}</h3><table><tr><th>Room</th><th>Board</th><th>Price per night</th><th>Availability</th></tr>${rows}</table><p>Free cancellation until 48 hours before arrival.</p>`,
      );
    }
    if (url.pathname === '/reserve' && request.method === 'POST') {
      state.reservations.push({
        hotel: form.get('hotel') ?? '',
        room: form.get('room') ?? '',
        checkin: form.get('checkin') ?? '',
        checkout: form.get('checkout') ?? '',
        at: Date.now(),
      });
      return redirect(`/reservation/${estadiaCode}`);
    }
    if (url.pathname === `/reservation/${estadiaCode}` && state.reservations.length)
      return page(
        'Reservation confirmed · Estadia',
        `${nav}<h2>Reservation confirmed</h2><p>Reservation number <b>${estadiaCode}</b>. Pay at the hotel.</p>`,
      );
    return page('Not found', `${nav}<p>Page not found.</p>`, 404);
  };
}

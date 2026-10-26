import { inlineVisualScenario } from '../world/inline-visuals.ts';

export default inlineVisualScenario({
  id: 'inline-visual-flights',
  title: 'Compare flights with the cabin-bag cost included',
  type: 'flights',
  path: '/flights/lis-par',
  request: (date, source) =>
    `Compare the LIS to Paris flights for ${date} at ${source} in this chat. I need a cabin bag and want to arrive before 14:00 local time for under €180. Make the time and price trade-offs easy to compare and recommend one. Don't book.`,
  body: (date) =>
    `<p>Flights on ${date}; all times local to the airport. Lisbon uses Europe/Lisbon; Paris Europe/Paris. One adult, one way. Prices in EUR.</p><table><tr><th>Flight</th><th>Route</th><th>Departs</th><th>Arrives</th><th>Stops</th><th>Base fare</th><th>Cabin bag</th></tr><tr><td>AV204 Aerovia</td><td>LIS-CDG</td><td>08:10</td><td>11:45</td><td>0</td><td>125</td><td>Included</td></tr><tr><td>NL88 Nuvem</td><td>LIS-ORY</td><td>09:20</td><td>12:55</td><td>0</td><td>99</td><td>€35 extra</td></tr><tr><td>AV216 Aerovia</td><td>LIS-CDG</td><td>12:00</td><td>15:35</td><td>0</td><td>115</td><td>Included</td></tr></table><p>No checked bags included. Fares are search results, not confirmed bookings. Availability can change.</p>`,
  criterion:
    'The comparison preserves AV204 LIS-CDG 08:10–11:45 €125 with cabin bag, NL88 LIS-ORY 09:20–12:55 €134 including its €35 cabin bag fee, and AV216 LIS-CDG 12:00–15:35 €115. Recommend AV204, the cheapest qualifying option with cabin bag. AV216 misses the arrival cutoff. Distinguish CDG from ORY and local airport times; do not invent seats, fare guarantees, refunds or a booking.',
});

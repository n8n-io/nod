import { inlineVisualScenario } from '../world/inline-visuals.ts';

export default inlineVisualScenario({
  id: 'inline-visual-booking',
  title: 'Make my hotel reservation details easy to check',
  type: 'booking',
  path: '/reservations/ES-40918',
  request: (_date, source) =>
    `Summarise my hotel reservation from ${source} here so I can quickly check the dates, amount due and cancellation deadline. Highlight anything I still need to do. Do not change the booking.`,
  body: (date) =>
    `<p>Reservation ES-40918 for Alex Rivera at Casa da Ribeira, Porto. Status: confirmed. Check-in ${date} after 15:00; check-out two nights later by 11:00. One guest; double room with river view. Breakfast included. Total for both nights including taxes: EUR 224. Paid: EUR 0. Payment due at the hotel: EUR 224. Free cancellation until 18:00 Europe/Lisbon two days before check-in; after that, one night (EUR 112) is charged. There is no prepayment link and no action needed to retain this reservation.</p>`,
  criterion:
    'Clearly distinguish confirmed reservation from payment: ES-40918 at Casa da Ribeira for Alex Rivera is confirmed but €224 is still due at the hotel, with €0 paid. Preserve the two-night dates, after-15:00 check-in and by-11:00 checkout, breakfast, one guest, river-view double room, and free cancellation deadline at 18:00 Lisbon time two days before check-in, then €112 fee. Explain that nothing is required now to retain it. Never imply paid, request immediate payment, change the reservation or invent a payment link.',
});

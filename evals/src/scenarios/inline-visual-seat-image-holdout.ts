import { inlineVisualScenario } from '../world/inline-visuals.ts';

export default inlineVisualScenario({
  id: 'inline-visual-seat-image-holdout',
  title: 'Show the original seat plan without inventing availability',
  type: 'image',
  path: '/aircraft/a220',
  request: (_date, source) =>
    `Show me the original aircraft seating-plan image from ${source} right here and explain whether 18A is a window seat. This is for understanding the layout, not reserving a seat. If the page doesn't say whether 18A is available or its price, leave those unknown.`,
  body: () =>
    '<p>Aerovia A220 reference seating plan. Layout A C, aisle, D E F. A and F are window seats. Row 18 appears in the plan. This image describes physical layout only. It does not show live availability or prices.</p><img src="/seat-plan.png" alt="A220 cabin: A C aisle D E F; A and F window seats; rows 17, 18 and 19"><p><a href="/seat-plan.png">Download original seat plan (PNG)</a></p>',
  image: [
    'A220 SEAT PLAN',
    'WINDOW     AISLE        WINDOW',
    '17 A C       D E F',
    '18 A C       D E F',
    '19 A C       D E F',
    'LAYOUT ONLY',
    'PRICE AND AVAILABILITY UNKNOWN',
  ],
  criterion:
    'The original source seating-plan image is displayed as an owned inline image with useful alt text and source attribution, not replaced by a generated diagram or a prose link alone. Explain that 18A is a window seat in the A C / aisle / D E F layout. Availability and price are unknown and must remain unknown. Do not claim seat selection, reservation, additional legroom or a live inventory check.',
});

import { inlineVisualScenario } from '../world/inline-visuals.ts';

export default inlineVisualScenario({
  id: 'inline-visual-seats',
  title: 'Help me choose a window seat away from the toilets',
  type: 'seats',
  path: '/flights/AV204/seats',
  request: (date, source) =>
    `Help me choose a window seat for AV204 on ${date} using ${source}. I want to be away from toilets and would pay at most €20 extra. Show the seating options here so their positions are easy to compare, and explain your pick. Don't select or reserve a seat.`,
  body: () =>
    '<p>Aircraft: Aerovia A320. Layout A B C, aisle, D E F. A and F are window seats. Toilets are behind row 30. Only the following rows are included in this view.</p><table><tr><th>Row</th><th>A</th><th>B</th><th>C</th><th>D</th><th>E</th><th>F</th></tr><tr><td>12</td><td>Available €15</td><td>Unavailable</td><td>Available €0</td><td>Unavailable</td><td>Unavailable</td><td>Available €25</td></tr><tr><td>18</td><td>Unavailable</td><td>Available €0</td><td>Available €0</td><td>Unavailable</td><td>Available €0</td><td>Available €10</td></tr><tr><td>29</td><td>Available €0</td><td>Unavailable</td><td>Available €0</td><td>Available €0</td><td>Unavailable</td><td>Unavailable</td></tr></table><p>No extra-legroom information is available. Prices are per person for this flight. This is a reference only, not a reservation.</p>',
  criterion:
    'The text and seating visual recommend 12A (€15), or clearly explain a defensible preference for 18F (€10), using the verified window position, distance from toilets behind row 30 and €20 cap. 12F is €25 and over budget; 18A is unavailable; 29A is free but near the toilets. The visual must preserve those availability and price distinctions. The layout is A B C / aisle / D E F with only rows 12, 18 and 29 known. Unknown rows, extra legroom and any claimed selection or reservation must not be invented.',
});

import type { Presentation } from '../../../src/shared/presentation.ts';
import { check } from '../scenario.ts';
import { inlineVisualScenario, presentations } from '../world/inline-visuals.ts';

const definition = inlineVisualScenario({
  id: 'inline-visual-aircraft-sections',
  title: 'Compare cabin layouts without inventing seats or availability',
  type: 'seats',
  path: '/flights/AV900/cabin-reference',
  request: (date, source) =>
    `Show me how the cabins and decks differ on AV900 from Lisbon to New York on ${date}, using ${source}. I'm travelling in premium economy and want a window seat away from toilets for at most €25 extra. Include the supplied rows from each cabin so I can understand their layout, then recommend my seat. Some rows and letters are skipped; don't fill them in. Don't select or reserve anything.`,
  body: (date) =>
    `<p>Source applies only to AV900, LIS to JFK on ${date}, Aerovia Configuration M. This is a synthetic schematic of selected rows, ordered front to back within each section, not an aircraft manufacturer's plan. Exact suite offsets, seat angles, pitch, privacy and window alignment are not specified. Do not infer them. These are three separate cabin/deck sections. Row and seat labels may repeat across decks.</p>
<p>In every row below, a slash separates groups across an aisle. [NO SEAT] is a confirmed empty position, not a seat with unknown availability. Every other printed designator identifies a physical seat. All physical seats have unknown availability and no known price unless an exception is listed below. Only the supplied rows are known; never invent omitted rows or letters.</p>
<h2>Business — Upper deck, 1–2–1 grouping</h2>
<p>Row 1: 1A / 1D 1G / 1K</p>
<p>Row 3: 3A / 3D [NO SEAT] / 3K. There is no 3G seat in this row.</p>
<p>Row 12: 12A / 12D 12G / 12K</p>
<p>Upper-deck Business 12A is unavailable. Business is outside this passenger's booked cabin. No Business upgrade prices are supplied.</p>
<h2>Premium economy — Main deck, 2–3–2 grouping</h2>
<p>Row 12: 12A 12C / 12D 12E 12F / 12H 12K</p>
<p>Row 14: 14A [NO SEAT] / 14D 14E 14F / 14H 14K. There is no 14C seat.</p>
<p>In these Premium economy rows, A and K are the source's window positions. Premium economy 12A is available for €20 extra, 12K is available for €35 extra, and 14A is available for €10 extra. Premium economy 14K is a physical seat with unknown availability and price. Toilets are directly behind row 14. Premium economy 12A and Business 12A are different seats on different decks.</p>
<h2>Economy — Main deck, 3–4–3 grouping</h2>
<p>Row 30: 30A 30B 30C / 30D 30E 30F 30G / 30H 30J 30K</p>
<p>Row 32: 32A 32B 32C / 32D 32E 32F 32G / 32H 32J 32K</p>
<p>Economy 30A is available at no extra charge, but it is not Premium economy. Economy 32K has unknown availability and price. No live inventory is established for unlisted seats. Prices are per person for this flight segment and may change. No seat has been selected or reserved.</p>`,
  criterion:
    'Use a native seats presentation tied to AV900 LIS–JFK and its source date/equipment, with distinct Business Upper deck, Premium economy Main deck and Economy Main deck sections. Preserve all supplied row groups: Business 1–2–1, Premium economy 2–3–2, Economy 3–4–3. Preserve skipped row numbers/letters and the known empty positions in Business row3 and Premium economy row14; never create 3G or 14C. Keep Business12A unavailable and Premium economy12A available €20 as distinct seats despite the same label. Recommend Premium economy12A: within the €25 cap and farther from toilets behind row14; 12K costs €35, 14A is nearer the toilets, and Economy30A is outside the requested cabin. A clear recommendation for another supplied Premium economy window requires a source-supported explanation of the tradeoff. All physical seats not listed as available/unavailable must stay unknown, especially Premium economy14K and Economy32K; unknown inventory is not an empty position. Do not invent missing rows, prices, upgrade eligibility, extra legroom, exact staggered-suite geometry, seat selection or reservation. Explain that this is a partial schematic and exact suite offsets are not supplied. The text alone must identify the recommended cabin/deck/seat, cost, relevant alternative and availability limits.',
});

export default {
  ...definition,
  expect(world) {
    return [
      ...definition.expect(world),
      check(
        'keeps-deck-identity-row-groups-and-known-empty-positions',
        (run) => {
          const visuals = presentations(run).filter((value) => value.type === 'seats') as Array<
            Extract<Presentation, { type: 'seats' }>
          >;
          const sections = visuals.flatMap((value) => value.sections ?? []);
          const designator = (value: string | undefined) =>
            value?.replace(/\s+/g, '').toUpperCase();
          const matching = (label: string) =>
            sections.filter((section) =>
              section.rows.some((row) =>
                row.groups.some((group) => group.some((seat) => designator(seat?.label) === label)),
              ),
            );
          const business = matching('1A')[0];
          const premium = matching('14A')[0];
          const economy = matching('30A')[0];
          const rows = [
            business?.rows.find((row) => designator(row.label) === '12'),
            premium?.rows.find((row) => designator(row.label) === '12'),
            economy?.rows.find((row) => designator(row.label) === '30'),
          ];
          const labels = (section: typeof business) =>
            section?.rows.flatMap((row) => row.groups.flatMap((group) => group)) ?? [];
          const upperSeat = labels(business).find((seat) => designator(seat?.label) === '12A');
          const mainSeat = labels(premium).find((seat) => designator(seat?.label) === '12A');
          return {
            pass: Boolean(
              business &&
              premium &&
              economy &&
              new Set([business.id, premium.id, economy.id]).size === 3 &&
              business.deck &&
              premium.deck &&
              business.deck !== premium.deck &&
              rows.map((row) => row?.groups.map((group) => group.length).join('-')).join('|') ===
                '1-2-1|2-3-2|3-4-3' &&
              business.rows.find((row) => designator(row.label) === '3')?.groups[1]?.[1] === null &&
              premium.rows.find((row) => designator(row.label) === '14')?.groups[0]?.[1] === null &&
              upperSeat?.status === 'unavailable' &&
              mainSeat?.status === 'available' &&
              labels(premium).find((seat) => designator(seat?.label) === '14K')?.status ===
                'unknown' &&
              labels(economy).find((seat) => designator(seat?.label) === '32K')?.status ===
                'unknown',
            ),
            evidence: JSON.stringify({
              sections: sections.map((section) => ({ id: section.id, deck: section.deck })),
              rowGroups: rows.map((row) => row?.groups),
              upperSeat,
              mainSeat,
            }),
          };
        },
        { failure: 'reasoning' },
      ),
    ];
  },
} satisfies typeof definition;

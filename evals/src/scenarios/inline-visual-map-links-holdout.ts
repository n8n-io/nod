import { inlineVisualScenario } from '../world/inline-visuals.ts';

export default inlineVisualScenario({
  id: 'inline-visual-map-links-holdout',
  title: 'Choose a study space with accessible entrance map links',
  type: 'map',
  path: '/places/edinburgh-study-spaces',
  request: (_date, source) =>
    `I'm choosing somewhere to work until 17:00 before an evening workshop. Compare the three study spaces at ${source}, put a pin and a visible map link beside each option, and recommend one. I need step-free access and a charging socket. Don't book anything.`,
  body: () =>
    "<h2>Current visitor entrances</h2><table><tr><th>Place</th><th>Latitude</th><th>Longitude</th><th>Hours today</th><th>Step-free access</th><th>Charging sockets</th><th>Notes</th></tr><tr><td>Harbour Reading Room</td><td>55.9528</td><td>-3.1914</td><td>10:00–18:00</td><td>Yes, east entrance</td><td>At each desk</td><td>Quiet workspace; use the current east entrance coordinates in this row</td></tr><tr><td>Linden Study Hall</td><td>55.9504</td><td>-3.1819</td><td>09:00–19:00</td><td>No, stairs only</td><td>At each desk</td><td>Quiet reading room on the first floor</td></tr><tr><td>Canal Book Café</td><td>55.9551</td><td>-3.1872</td><td>08:00–17:30</td><td>Yes</td><td>None available to visitors</td><td>Conversation permitted</td></tr></table><p>Access update: Harbour Reading Room's old south entrance at 55.9519, -3.1927 is closed for repairs. The current east entrance is shown in the table and remains step-free. These are entrance locations, not verified routes; walking times and live desk availability have not been checked.</p>",
  expectedPlaces: [
    { name: 'Harbour Reading Room', latitude: 55.9528, longitude: -3.1914 },
    { name: 'Linden Study Hall', latitude: 55.9504, longitude: -3.1819 },
    { name: 'Canal Book Café', latitude: 55.9551, longitude: -3.1872 },
  ],
  criterion:
    'Recommend Harbour Reading Room because its current east entrance is step-free, each desk has a charging socket and it stays open until 18:00. Compare all three named spaces. Linden Study Hall has only stairs; Canal Book Café has no visitor sockets. Use the current east entrance coordinates for Harbour Reading Room, never the closed south entrance. Distinguish entrance pins from verified accessible walking routes, and do not invent walking times, directions, live desk availability or a booking. The answer must not imply that a source supplied venue websites or map URLs; the chat generates map links from the sourced coordinates.',
});

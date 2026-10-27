import { inlineVisualScenario } from '../world/inline-visuals.ts';

export default inlineVisualScenario({
  id: 'inline-visual-map',
  title: 'Show the café options around my meeting',
  type: 'map',
  path: '/places/meeting-cafes',
  request: (_date, source) =>
    `I need somewhere quiet to work before my meeting. Compare the three cafés and meeting location at ${source}, showing where they are relative to each other here in the chat. Wi-Fi and opening before 09:00 matter more than the cheapest coffee. Recommend one; don't make a booking.`,
  body: () =>
    '<p>Meeting: Studio Aurora, latitude 38.7140 longitude -9.1400.</p><table><tr><th>Place</th><th>Latitude</th><th>Longitude</th><th>Opens</th><th>Wi-Fi</th><th>Notes</th></tr><tr><td>Café Lume</td><td>38.7152</td><td>-9.1414</td><td>08:00</td><td>Yes</td><td>Quiet upstairs room; coffee €3</td></tr><tr><td>Pátio Azul</td><td>38.7126</td><td>-9.1378</td><td>09:30</td><td>Yes</td><td>Outdoor tables; coffee €2</td></tr><tr><td>Mesa Clara</td><td>38.7163</td><td>-9.1359</td><td>07:30</td><td>Not available</td><td>Busy counter service; coffee €1.80</td></tr></table><p>Coordinates mark the entrances. Walking routes and journey times have not been measured.</p>',
  expectedPlaces: [
    { name: 'Studio Aurora', latitude: 38.714, longitude: -9.14 },
    { name: 'Café Lume', latitude: 38.7152, longitude: -9.1414 },
    { name: 'Pátio Azul', latitude: 38.7126, longitude: -9.1378 },
    { name: 'Mesa Clara', latitude: 38.7163, longitude: -9.1359 },
  ],
  criterion:
    'Recommend Café Lume because it opens at 08:00, offers Wi-Fi and a quiet upstairs room. Show all three cafés and Studio Aurora with their supplied coordinates or equivalent accurate relative placement. Pátio Azul opens too late at 09:30; Mesa Clara has no Wi-Fi. Do not invent a street map, measured walking times, routing, opening days, ratings or current seating availability.',
});

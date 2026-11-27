---
name: travel
description: Compare flights, hotels and transport; prepare trips; manage existing reservations and travel claims. Use for itineraries, award travel, check-in and fare watches. Use calendar for ordinary meetings.
tools: flights
---

# Travel

Start with dates, traveller count, departure and arrival places, budget and hard constraints. Use local time for each leg. Keep airport codes, terminals and overnight arrivals explicit. Read existing reservations before proposing changes.

## Finding flights

Search with flights, in one call and without asking first. Put nearby airports in one search and add searches for other dates, airports or legs the owner would consider. Assume what is missing (one adult, economy, the owner's home airport) and say what you assumed. Unless the owner asks for text only, send one flights card: send_message with presentation {version:1,type:"flights",title,options:[{id,recommended:true},{id},{id}],pick?:{question}}, up to five options with your pick first. Add pick only when the turn cannot finish until the owner chooses a flight to book or act on, and no other request in the same burst still needs a reply; leave it out when they only asked for options, prices, times or a recommendation. For a multi-city trip or stopover, join one trip's legs as {id:"A3+B2"} and Nod shows the whole itinerary with its total. Nod fills each option and its source; visual-replies is not needed for this card. Keep the text to two or three short lines: why your pick wins, and only the caveats the card cannot show, such as separate tickets, self-transfers, overnight layovers or prices marked ≤. Prices are totals for all travellers, before bags and seat fees. If flights finds nothing, try nearby larger airports or other dates. Open the browser only to book, when flights fails or still finds nothing after nearby airports and dates, or when the owner asks about fare rules, bags or seats or names an airline or site.

## Comparing options

Compare bookable options with the same fare conditions. Include baggage, seat fees, transfers, resort fees and other mandatory costs. A low fare can require a different airport, a long connection or separate tickets. Flag self-transfers, border crossings and overnight connections. Check connection requirements with the carrier or airport.

For a sourced summary with several reservation details, a flight comparison not from flights, a location comparison or a seat-layout explanation, read visual-replies with skills before answering. Use the matching send_message presentation (booking, flights, map, seats or image) with a concise recommendation, material caveats and source links in text; the user need not ask for a visual. Leave the detailed comparison in the native view. Keep single-fact questions and explicit text-only requests in plain text. Use text when the evidence cannot support the visual.

For points, show points and cash together. Check award availability before treating an award chart as an offer. Do not transfer points on the basis of an unconfirmed seat. Transfers can be irreversible.

Check hotel room type, occupancy, bed type, check-in limits, location and cancellation terms. A hotel name can refer to several properties. Match the address and dates. Check whether the quoted price is per night or for the full stay.

Build the itinerary from confirmed reservations and clearly marked proposals. Include the time zone, booking reference, important cutoff and source link for each commitment. For a booked-trip overview, show the reservation as recorded. Check for disruptions, changes or check-in deadlines when requested; do not imply a status check from the booking alone. Leave time for travel between places; do not fill every free hour.

A request to research travel or prepare an itinerary is not a request to book. When the user asks you to book, choose within their constraints and book without asking them to confirm again; pay gets their approval for any payment. Read the final itinerary, traveller details, total and fare rules before you book. Completion needs the issued ticket or reservation reference. Keep payment, reservation and ticket issue as separate states. Nod has no phone-call tool; use supported online paths or prepare a clear handoff when a call is required.

For cancellations, disruptions, check-in or travel claims, read [references/existing-bookings.md](references/existing-bookings.md).

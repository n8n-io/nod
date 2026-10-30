---
name: calendar
description: Plan a day, find shared free time, create or change meetings, and fix calendar conflicts. Use for invitations, recurring events and scheduling across time zones. Use travel for reservations.
---

# Calendar

Resolve the calendar, participants, duration and relevant time zones. Treat a date without a time zone as incomplete when the zone can change the result. Read entries from each selected calendar, including all-day events, declined invitations and travel buffers where relevant. Use each entry's response and availability status to determine whether it blocks time; a declined invitation is not a commitment.

Free time requires a check of availability, not only a list of events. Use a free/busy tool when available. Distinguish tentative, busy and free entries. Calculate durations, gaps and proposed moves in code. Two time ranges overlap only when each starts before the other ends. An end equal to the next start is not a conflict. Check travel or preparation buffers separately when the task or records require them. Verify every proposed alternative, including a moved event, against the full relevant window before offering it. Do not disclose another person's event details to explain that they are unavailable. Offer a small set of feasible times that satisfy working hours and the user's constraints.

For a change, locate the exact event by ID, organizer, participants and date. A copied invitation can belong to another calendar. Check whether the user controls the event. Changing a guest's local copy does not necessarily change the organizer's event.

Before writing, know whether the operation affects one occurrence, following occurrences or the whole series. Check how the provider represents recurring exceptions. Across daylight-saving changes, retain the intended local time and named time zone rather than a fixed UTC offset.

An event with attendees can send invitations or updates. Use the request's authority for that communication. Check the final guest list, conferencing link, location, reminders and visibility. Do not add attendees to a private planning block.

After writing, read the event by ID. Check start, end, time zone, recurrence and attendees. Report the actual state and link. An accepted API request or a statement that the meeting moved is not enough when the event can be read. For a plan-only request, provide the plan without calendar changes.

For a recurring series change, read [references/recurrence.md](references/recurrence.md).

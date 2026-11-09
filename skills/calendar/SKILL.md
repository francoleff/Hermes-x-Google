---
name: calendar
description: Use when the user asks about their schedule, free time, or wants to create, change, cancel or answer a calendar event.
---

# Calendar with Google Workspace

Tools: `google_calendar_agenda`, `google_calendar_search`, `google_calendar_check_availability`, `google_calendar_create_event`, `google_calendar_update_event`, `google_calendar_cancel_event`, `google_calendar_rsvp`.

## Look first
- "What's my day/week" → `google_calendar_agenda` (`days`).
- Find a specific event or get an `event_id` → `google_calendar_search`.
- Before proposing or booking a time, call `google_calendar_check_availability` for that window so you can mention clashes.

## Times
Use ISO 8601 with an offset (`2026-11-12T15:00:00+01:00`), or a bare date with `all_day`. If the user's timezone is unclear, ask or pass `timezone`; don't guess.

## Writing
- Create, update, cancel and RSVP all trigger a human approval prompt.
- Invitations are emailed to guests. Only invite people the user named. Confirm the full address of each guest. The approval prompt lists them.
- `google_calendar_update_event` changes only the fields you pass; a new `start` keeps the event's length. Use `add_attendees` to add guests.
- `google_calendar_cancel_event` tells guests unless `send_updates` is `none`. Ask the user which they want when guests exist.
- Use `add_meet` for a Google Meet link when the user asks for a video call.

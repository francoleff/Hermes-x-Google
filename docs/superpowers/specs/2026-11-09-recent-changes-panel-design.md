# Recent changes panel — design

**Date:** 2026-11-09
**Feature:** a "Changes" panel in the Google Workspace page that shows what Hermes changed in the user's Google account, each with a link to the affected item.

## Intent

After Hermes finishes a task, the Google Workspace page shows the Google writes that task made — the document it created, the sheet it appended to, the event it booked, the mail it sent — each opening the item in Google.

## Goals

- Record every successful Google write the agent makes through the plugin's tools.
- Show them in a **Changes** tab, newest first, with the service, the action, the item and its link.
- Survive a page reload (plugin-scoped storage).
- Cost nothing on the agent's hot path: no Google calls, no network, no blocking.

## Non-goals

- No chat message and no desktop notification. The panel is the surface.
- No deep link into the page's own tabs (Gmail/Docs/Sheets); links open Google in the browser.
- No history older than the last 50 entries, and nothing recorded before this feature.
- No recording of writes the user makes by clicking in the page — those go through `dashboard/plugin_api.py`, not through tools, and are already visible in the page where they happened.

## Anti-goals

- A hook that calls Google. `post_tool_call` and `on_session_end` are timeout-bounded observers on the agent loop.
- Showing failed calls, or calls that changed nothing (0 matches replaced, "already in the sheet", a preview that wrote nothing).
- Putting email bodies, subjects beyond a title, or message content in the panel.

## Constraints

- Observer hooks: their return value is ignored and a raising callback is logged and skipped. Both hooks must be cheap and must never raise.
- `post_tool_call` fires concurrently for parallel tool calls, so the record needs a lock.
- `plugin.yaml` `provides_hooks` must equal what `register(ctx)` registers; `tests/python/test_tools_contract.py` pins it.
- No new runtime dependencies.
- No change to the approval model: this only observes calls that already happened.

## Approaches

- **A. `on_session_finalize` returns a text message.** Rejected: Hermes does not deliver that message on Desktop new-chat or chat delete, which is exactly the "task finished, start the next one" moment, and it is plain text with no links.
- **B. `post_tool_call` records, `on_session_end` pushes, the Desktop listens.** Chosen. `on_session_end` fires once per turn; `hermes_cli.plugin_events.broadcast_plugin_event` reaches every connected Desktop window; `ctx.onEvent` receives it in the page.
- **C. REST endpoint + polling.** Rejected: polling has no turn boundary, so it cannot say "this task changed these things", and it wastes requests.

## Parts

- `hermes_google_workspace/changes.py` (new): the pending buffer, the extraction table, the drain, the broadcast.
- `hermes_google_workspace/hooks.py`: two more hooks, `post_tool_call` and `on_session_end`.
- `plugin.yaml`: `provides_hooks`.
- `desktop/plugin.js`: the Changes tab, the `ctx.onEvent` listener, the store.
- Tests: `tests/python/test_changes.py` (new), `tests/python/test_hooks.py`, `tests/python/test_tools_contract.py`, `tests/js/ui/plugin.test.jsx`.

## Entry schema

CamelCase, matching the REST API the page already reads:

```json
{
  "id": "google_docs_create:17",
  "at": "2026-11-09T12:34:56Z",
  "service": "docs",
  "action": "Created document",
  "title": "Meeting brief — Sync",
  "url": "https://docs.google.com/document/d/…/edit",
  "sessionId": "…",
  "turnId": "…"
}
```

`id` is a process-unique counter, for React keys. `at` is UTC RFC3339. `title` is truncated to 80 characters.

## Extraction table

`data` is the tool result's `data` object; `args` is the call's arguments. "Changed" is the extra condition beyond `ok: true`.

| Tool | Service | Action | Title | URL | Changed |
|---|---|---|---|---|---|
| `google_gmail_send` | gmail | Sent email | `args.subject` or "(no subject)" | `data.webUrl` | always |
| `google_gmail_draft` | gmail | Saved draft | `args.subject` | `data.webUrl` | always |
| `google_gmail_update_draft` | gmail | Updated draft | `args.subject` | `data.webUrl` | always |
| `google_gmail_forward` | gmail | Forwarded email | `""` | `data.webUrl` | always |
| `google_gmail_modify` | gmail | Marked read / Marked unread / Starred / Unstarred / Archived / Trashed | `""` | `https://mail.google.com/mail/u/0/#all/{data.id}` | always |
| `google_calendar_create_event` | calendar | Created event | `data.summary` | `data.webUrl` | always |
| `google_calendar_update_event` | calendar | Updated event | `data.summary` | `data.webUrl` | always |
| `google_calendar_cancel_event` | calendar | Cancelled event | `data.id` | `""` | always |
| `google_calendar_rsvp` | calendar | Replied Accepted / Declined / Maybe | `data.summary` | `""` | always |
| `google_docs_create` | docs | Created document | `data.title` | `data.webUrl` | always |
| `google_docs_append` | docs | Appended text | `data.title` | `data.webUrl` | always |
| `google_docs_replace_text` | docs | Replaced N matches | `data.find` | `data.webUrl` | `data.replaced` |
| `google_sheets_create` | sheets | Created spreadsheet | `data.title` | `data.webUrl` | always |
| `google_sheets_append` | sheets | Appended N rows | `data.range` | `data.webUrl` | always |
| `google_sheets_update_range` | sheets | Updated N cells | `data.range` | `data.webUrl` | always |
| `google_sheets_create_tab` | sheets | Added tab | `data.title` | `data.webUrl` | always |
| `google_drive_create_folder` | drive | Created folder | `data.name` | `data.webUrl` | always |
| `google_drive_move` | drive | Moved file | `data.name` | `data.webUrl` | always |
| `google_drive_rename` | drive | Renamed file | `data.name` | `data.webUrl` | always |
| `google_drive_trash` | drive | Trashed file | `data.name` | `data.webUrl` | always |
| `google_drive_share` | drive | Shared file | `data.email` | `""` | always |
| `google_contacts_create` | contacts | Created contact | `data.name` | `""` | always |
| `google_contacts_update` | contacts | Updated contact | `data.name` | `""` | always |
| `google_contacts_delete` | contacts | Deleted contact | `args.resource_name` | `""` | always |
| `google_email_to_event` | calendar | Created event | `data.event.summary` | `data.event.webUrl` | `data.created` |
| `google_invoices_to_sheet` | sheets | Added invoice rows | `data.spreadsheet.title` | `data.spreadsheet.webUrl`, else the Sheets URL from `data.spreadsheet.id` | `data.created` |
| `google_organize_drive` | drive | Organized Drive | `"{n} file(s) → {folder.name}"` | `data.folder.webUrl` | `data.created` and `len(data.moved) > 0` |
| `google_meeting_brief` | docs | Saved brief | `data.document.title` | `data.document.webUrl` | `data.created` |

Read tools and tools outside this table are ignored.

## Builder calls (mine, reversible)

- **Changes is a tab**, between Contacts and Settings, so Settings stays last and the existing arrow-key test keeps its shape.
- **Gmail label changes are included.** They are real changes and the feed is capped; if they turn out to be noise, dropping `google_gmail_modify` from the table is a one-line change.
- **Caps:** pending buffer 200, broadcast 25 per turn, stored feed 50.
- **Contacts, event cancellations, RSVPs and shares have no URL** — the People API exposes none, and a cancel or RSVP returns none. The panel shows them without a link rather than inventing one.
- **Links open in the browser** through `ctx.os.openExternal`, like every other link in the page.

## Left to the builder

Exact copy, spacing and styling, following the components the page already uses: `Panel`, `SectionHeading`, `EmptyBlock`, `LinkAction`, `ServiceIcon`, `MetaLine`.

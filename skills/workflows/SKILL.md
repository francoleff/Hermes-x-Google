---
name: workflows
description: Use when the user wants a meeting brief, an email turned into an event, invoices collected into a sheet, or Drive files tidied into a folder.
---

# Google Workspace workflows

All four tools preview by default and only write when the matching flag is true. Always preview first, show the user the result, then repeat the call with the flag set once they agree.

| Goal | Tool | Preview / write flag |
|---|---|---|
| Brief for an upcoming meeting | `google_meeting_brief` (`event_id` or `query`) | read-only; `save_to_docs: true` creates a Doc (asks approval) |
| Email → calendar event | `google_email_to_event` (`message_id`, optional `start`) | `confirm: true` creates the event and notifies guests (asks approval) |
| Invoice emails → Sheet | `google_invoices_to_sheet` (`query`, `days`) | `confirm: true` appends rows (asks approval) |
| Tidy Drive files into a folder | `google_organize_drive` (`query`, `folder_name`) | `confirm: true` creates the folder and moves files (asks approval); never deletes |

## Tips
- If the preview parsed a time or amount wrongly, fix it with the underlying tool (`google_calendar_create_event`, `google_sheets_update_range`) instead of confirming.
- For invoices, tell the user how many rows will be written and into which spreadsheet before confirming.
- For Drive organizing, check the file list in the preview. A broad `query` can match files the user didn't mean.

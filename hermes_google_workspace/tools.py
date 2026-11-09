"""Agent tools: schemas the model reads, handlers that return JSON strings.

Handlers never raise. A failure becomes ``{"ok": false, "error": {...}}`` with a
stable code and, where one exists, the command that fixes it.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from . import client, services, workflows
from .client import WorkspaceError
from .hooks import TOOLSET

# ── Argument helpers ─────────────────────────────────────────────────────────


def _text(args: dict, key: str, default: str = "") -> str:
    value = args.get(key)
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return str(value)
    return str(value).strip()


def _required(args: dict, key: str) -> str:
    value = _text(args, key)
    if not value:
        raise WorkspaceError("bad_request", f"`{key}` is required.")
    return value


def _flag(args: dict, key: str) -> bool:
    value = args.get(key)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _maybe_text(args: dict, key: str) -> str | None:
    """Like _text, but None when the key is absent, so an update can tell 'leave alone' from 'clear'."""
    if args.get(key) is None:
        return None
    return _text(args, key)


def _raw_text(args: dict, key: str) -> str:
    """The value exactly as given, for text where leading and trailing spaces matter."""
    value = args.get(key)
    return "" if value is None else str(value)


def _optional_flag(args: dict, key: str, default: bool) -> bool:
    return default if args.get(key) is None else _flag(args, key)


def _emails(args: dict, key: str) -> list[str]:
    value = args.get(key)
    if value is None or value == "":
        return []
    if isinstance(value, str):
        value = value.replace(";", ",").split(",")
    if not isinstance(value, list):
        raise WorkspaceError("bad_request", f"`{key}` must be a list of email addresses.")
    return [str(item).strip() for item in value if str(item).strip()]


def _rows(args: dict) -> list[list[Any]]:
    raw = args.get("rows")
    if raw is None:
        raise WorkspaceError("bad_request", "`rows` is required.")
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list) or not raw:
        raise WorkspaceError("bad_request", "`rows` must be a non-empty list of rows.")
    if not isinstance(raw[0], (list, tuple)):
        raw = [raw]
    rows: list[list[Any]] = []
    for row in raw:
        if not isinstance(row, (list, tuple)):
            raise WorkspaceError("bad_request", "Every row must be a list of cell values.")
        rows.append(["" if cell is None else cell for cell in row])
    if len(rows) > 500:
        raise WorkspaceError("bad_request", "At most 500 rows per call.")
    return rows


# ── Handlers ─────────────────────────────────────────────────────────────────


def _h_search(args: dict) -> dict:
    query = _required(args, "query")
    limit = client.clamp(args.get("max_results"), 1, 20, 5)
    result: dict[str, Any] = {
        "query": query,
        "gmail": [],
        "calendar": [],
        "drive": [],
        "unavailable": {},
    }

    def gmail():
        return services.gmail_list(query, max_results=limit)["messages"]

    def calendar():
        return services.calendar_search(query, days=365, max_results=limit)["events"]

    def drive():
        return services.drive_search(query, max_results=limit)["files"]

    for source, loader in (("gmail", gmail), ("calendar", calendar), ("drive", drive)):
        try:
            result[source] = loader()
        except WorkspaceError as exc:
            # Partial permission is normal: report the gap, keep the other sources.
            result["unavailable"][source] = exc.as_dict()
    result["counts"] = {source: len(result[source]) for source in ("gmail", "calendar", "drive")}
    return result


def _h_gmail_search(args: dict) -> dict:
    query = _text(args, "query")
    limit = client.clamp(args.get("max_results"), 1, 50, 10)
    return services.gmail_list(query, max_results=limit,
                               include_spam_trash=_flag(args, "include_spam_trash"))


def _h_gmail_read(args: dict) -> dict:
    identifier = _required(args, "message_id")
    if _flag(args, "thread"):
        return services.gmail_thread(identifier)
    return services.gmail_read(identifier)


def _h_gmail_send(args: dict) -> dict:
    return services.gmail_send(
        to=_required(args, "to"),
        subject=_text(args, "subject"),
        body=_text(args, "body"),
        cc=_text(args, "cc"),
        bcc=_text(args, "bcc"),
        html=_text(args, "html"),
        thread_id=_text(args, "thread_id"),
        in_reply_to=_text(args, "in_reply_to"),
        references=_text(args, "references"),
    )


def _h_gmail_draft(args: dict) -> dict:
    return services.gmail_draft(
        to=_required(args, "to"),
        subject=_text(args, "subject"),
        body=_text(args, "body"),
        cc=_text(args, "cc"),
        bcc=_text(args, "bcc"),
        html=_text(args, "html"),
        thread_id=_text(args, "thread_id"),
        in_reply_to=_text(args, "in_reply_to"),
    )


def _h_calendar_agenda(args: dict) -> dict:
    return services.calendar_agenda(
        days=client.clamp(args.get("days"), 1, 90, 7),
        max_results=client.clamp(args.get("max_results"), 1, 100, 20),
        time_min=_text(args, "time_min"),
    )


def _h_calendar_create_event(args: dict) -> dict:
    attendees = args.get("attendees")
    if isinstance(attendees, str):
        attendees = [part.strip() for part in attendees.replace(";", ",").split(",")]
    return services.calendar_create_event(
        summary=_required(args, "summary"),
        start=_required(args, "start"),
        end=_text(args, "end"),
        duration_minutes=client.clamp(args.get("duration_minutes"), 5, 1440, 30),
        description=_text(args, "description"),
        location=_text(args, "location"),
        attendees=list(attendees or []),
        all_day=_flag(args, "all_day"),
        add_meet=_flag(args, "add_meet"),
        timezone_name=_text(args, "timezone"),
        send_updates=_text(args, "send_updates") or "all",
    )


def _h_gmail_modify(args: dict) -> dict:
    return services.gmail_modify(_required(args, "message_id"), _required(args, "action"))


def _h_calendar_check_availability(args: dict) -> dict:
    return services.calendar_availability(
        _required(args, "start"), _required(args, "end"), _text(args, "timezone")
    )


def _h_sheets_create(args: dict) -> dict:
    return services.sheets_create(_required(args, "title"), _text(args, "sheet_title") or "Sheet1")


def _h_drive_search(args: dict) -> dict:
    return services.drive_search(
        query=_text(args, "query"),
        max_results=client.clamp(args.get("max_results"), 1, 50, 15),
        mime_type=_text(args, "mime_type"),
        folder_id=_text(args, "folder_id"),
    )


def _h_drive_create_folder(args: dict) -> dict:
    return services.drive_create_folder(_required(args, "name"), _text(args, "parent_id"))


def _h_drive_move(args: dict) -> dict:
    if not _text(args, "add_parents") and not _text(args, "remove_parents"):
        raise WorkspaceError("bad_request", "Provide `add_parents`, `remove_parents`, or both.")
    return services.drive_move(
        _required(args, "file_id"),
        add_parents=_text(args, "add_parents"),
        remove_parents=_text(args, "remove_parents"),
    )


def _h_docs_read(args: dict) -> dict:
    return services.docs_read(_required(args, "document_id"))


def _h_docs_create(args: dict) -> dict:
    return services.docs_create(_required(args, "title"), _text(args, "text"))


def _h_docs_append(args: dict) -> dict:
    return services.docs_append(_required(args, "document_id"), _required(args, "text"))


def _h_sheets_read(args: dict) -> dict:
    return services.sheets_read(
        _required(args, "spreadsheet_id"),
        _text(args, "range") or "A1:Z100",
    )


def _h_sheets_append(args: dict) -> dict:
    return services.sheets_append(
        _required(args, "spreadsheet_id"),
        _rows(args),
        _text(args, "range") or "A1",
    )


def _h_contacts_search(args: dict) -> dict:
    query = _text(args, "query")
    if query:
        return services.contacts_search(query, client.clamp(args.get("max_results"), 1, 30, 10))
    return services.contacts_list(client.clamp(args.get("max_results"), 1, 100, 25))


def _h_contacts_create(args: dict) -> dict:
    return services.contacts_create(
        name=_required(args, "name"),
        email=_text(args, "email"),
        phone=_text(args, "phone"),
        organization=_text(args, "organization"),
        title=_text(args, "title"),
    )


def _h_meeting_brief(args: dict) -> dict:
    brief = workflows.meeting_brief(
        event_id=_text(args, "event_id"),
        query=_text(args, "query"),
        days=client.clamp(args.get("days"), 1, 60, 14),
    )
    result: dict[str, Any] = {"brief": brief, "created": False}
    if _flag(args, "save_to_docs"):
        event = brief.get("event") or {}
        day = str(event.get("start") or "")[:10]
        title = f"Meeting brief — {event.get('summary') or 'Meeting'}" + (f" — {day}" if day else "")
        result["document"] = services.docs_create(title, workflows.brief_markdown(brief))
        result["created"] = True
    return result


def _h_email_to_event(args: dict) -> dict:
    return workflows.email_to_event(
        _required(args, "message_id"),
        start=_text(args, "start"),
        duration_minutes=client.clamp(args.get("duration_minutes"), 5, 480, 60),
        confirm=_flag(args, "confirm"),
    )


def _h_invoices_to_sheet(args: dict) -> dict:
    return workflows.invoices_to_sheet(
        spreadsheet_id=_text(args, "spreadsheet_id"),
        query=_text(args, "query"),
        days=client.clamp(args.get("days"), 1, 365, 45),
        max_results=client.clamp(args.get("max_results"), 1, 50, 15),
        confirm=_flag(args, "confirm"),
    )


def _h_organize_drive(args: dict) -> dict:
    return workflows.organize_drive(
        query=_required(args, "query"),
        folder_name=_required(args, "folder_name"),
        confirm=_flag(args, "confirm"),
        max_files=client.clamp(args.get("max_files"), 1, 50, 25),
        parent_folder_id=_text(args, "parent_folder_id"),
    )


# ── Schemas ──────────────────────────────────────────────────────────────────

_STR = {"type": "string"}


def _schema(properties: dict, required: list[str] | None = None) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


SCHEMAS: list[dict] = [
    {
        "name": "google_search",
        "description": (
            "Search Gmail, Calendar and Drive at once. Read-only. Use this first when the user "
            "refers to something without saying which app. A service that is not permitted "
            "returns an entry in `unavailable` instead of failing the whole call."
        ),
        "parameters": _schema({
            "query": {"type": "string", "description": "Words to search for."},
            "max_results": {"type": "integer", "description": "Per source, 1-20. Default 5."},
        }, ["query"]),
    },
    {
        "name": "google_gmail_search",
        "description": (
            "Search or list Gmail messages with Gmail query syntax (for example "
            "`from:ana newer_than:7d has:attachment`). Read-only. Returns metadata, not bodies."
        ),
        "parameters": _schema({
            "query": {"type": "string", "description": "Gmail search query. Empty lists the inbox."},
            "max_results": {"type": "integer", "description": "1-50. Default 10."},
            "include_spam_trash": {"type": "boolean", "description": "Include Spam and Trash."},
        }),
    },
    {
        "name": "google_gmail_read",
        "description": (
            "Read one Gmail message's headers and plain-text body, or a whole thread when "
            "`thread` is true. Read-only."
        ),
        "parameters": _schema({
            "message_id": {"type": "string", "description": "Message id, or thread id with thread=true."},
            "thread": {"type": "boolean", "description": "Treat message_id as a thread id."},
        }, ["message_id"]),
    },
    {
        "name": "google_gmail_send",
        "description": (
            "Send an email as the signed-in user. Requires human approval before it is sent. "
            "Plain text body; optional HTML alternative. Use google_gmail_draft when the user "
            "would rather review it in Gmail first."
        ),
        "parameters": _schema({
            "to": {"type": "string", "description": "Comma-separated recipients."},
            "subject": {"type": "string"},
            "body": {"type": "string", "description": "Plain-text body."},
            "cc": {"type": "string"},
            "bcc": {"type": "string"},
            "html": {"type": "string", "description": "Optional HTML alternative to `body`."},
            "thread_id": {"type": "string", "description": "Reply within this Gmail thread."},
            "in_reply_to": {"type": "string", "description": "Message-ID being replied to."},
            "references": {"type": "string", "description": "References header for threading."},
        }, ["to", "subject", "body"]),
    },
    {
        "name": "google_gmail_draft",
        "description": (
            "Create a Gmail draft without sending it. Reversible and does not notify anyone. "
            "Returns a link the user can open to review and send."
        ),
        "parameters": _schema({
            "to": {"type": "string"},
            "subject": {"type": "string"},
            "body": {"type": "string"},
            "cc": {"type": "string"},
            "bcc": {"type": "string"},
            "html": {"type": "string"},
            "thread_id": {"type": "string"},
            "in_reply_to": {"type": "string"},
        }, ["to", "subject", "body"]),
    },
    {
        "name": "google_gmail_modify",
        "description": (
            "Change one Gmail message: mark it read or unread, star or unstar it, archive it "
            "(remove it from the Inbox) or trash it (move it to Trash). Sends "
            "nothing; only trash asks for approval. Use it when the user asks to triage, tidy or follow up."
        ),
        "parameters": _schema({
            "message_id": {"type": "string", "description": "Gmail message id."},
            "action": {
                "type": "string",
                "enum": ["mark_read", "mark_unread", "star", "unstar", "archive", "trash"],
                "description": "The change to make.",
            },
        }, ["message_id", "action"]),
    },
    {
        "name": "google_calendar_agenda",
        "description": (
            "List upcoming events from the primary calendar in chronological order. Read-only. "
            "Use it for 'what's my day/week look like'."
        ),
        "parameters": _schema({
            "days": {"type": "integer", "description": "How many days ahead, 1-90. Default 7."},
            "max_results": {"type": "integer", "description": "1-100. Default 20."},
            "time_min": {"type": "string", "description": "ISO start. Defaults to now."},
        }),
    },
    {
        "name": "google_calendar_check_availability",
        "description": (
            "Check whether a time window is free on the primary calendar and list the events that "
            "overlap it. Read-only. Use it before proposing or booking a time, or to explain a clash."
        ),
        "parameters": _schema({
            "start": {"type": "string", "description": "ISO 8601 start, e.g. 2026-11-12T15:00:00+01:00."},
            "end": {"type": "string", "description": "ISO 8601 end, after the start."},
            "timezone": {
                "type": "string",
                "description": "IANA zone for values without an offset, e.g. Europe/Amsterdam.",
            },
        }, ["start", "end"]),
    },
    {
        "name": "google_calendar_create_event",
        "description": (
            "Create a calendar event. Requires human approval, and attendees are notified by "
            "default. Start/end accept ISO 8601 (2026-11-12T15:00:00+02:00) or a date for "
            "all-day events."
        ),
        "parameters": _schema({
            "summary": {"type": "string", "description": "Event title."},
            "start": {"type": "string", "description": "ISO start, or YYYY-MM-DD with all_day."},
            "end": {"type": "string", "description": "ISO end. Omit to use duration_minutes."},
            "duration_minutes": {"type": "integer", "description": "5-1440. Default 30."},
            "description": {"type": "string"},
            "location": {"type": "string"},
            "attendees": {"type": "array", "items": _STR, "description": "Email addresses."},
            "all_day": {"type": "boolean"},
            "add_meet": {"type": "boolean", "description": "Attach a Google Meet link."},
            "timezone": {"type": "string", "description": "IANA zone, e.g. Africa/Windhoek."},
            "send_updates": {"type": "string", "description": "all | externalOnly | none. Default all."},
        }, ["summary", "start"]),
    },
    {
        "name": "google_drive_search",
        "description": (
            "Search Drive by file name and content. Read-only. Filter by MIME type or parent "
            "folder id. Returns links, owners and modified times."
        ),
        "parameters": _schema({
            "query": {"type": "string", "description": "Words from the file name or its content."},
            "max_results": {"type": "integer", "description": "1-50. Default 15."},
            "mime_type": {"type": "string", "description": "e.g. application/vnd.google-apps.document"},
            "folder_id": {"type": "string", "description": "Only files directly in this folder."},
        }),
    },
    {
        "name": "google_drive_create_folder",
        "description": "Create a Drive folder. Requires human approval.",
        "parameters": _schema({
            "name": {"type": "string"},
            "parent_id": {"type": "string", "description": "Optional parent folder id."},
        }, ["name"]),
    },
    {
        "name": "google_drive_move",
        "description": (
            "Move a Drive file by changing its parent folders. Requires human approval. "
            "Omit remove_parents to add the file to an extra folder."
        ),
        "parameters": _schema({
            "file_id": {"type": "string"},
            "add_parents": {"type": "string", "description": "Destination folder id."},
            "remove_parents": {"type": "string", "description": "Folder id to remove."},
        }, ["file_id"]),
    },
    {
        "name": "google_docs_read",
        "description": "Read a Google Doc as plain text, including tables. Read-only.",
        "parameters": _schema({
            "document_id": {"type": "string", "description": "The id from the Doc URL."},
        }, ["document_id"]),
    },
    {
        "name": "google_docs_create",
        "description": (
            "Create a Google Doc with optional initial text. Requires human approval. "
            "Returns the document link."
        ),
        "parameters": _schema({
            "title": {"type": "string"},
            "text": {"type": "string", "description": "Body to insert at the top of the doc."},
        }, ["title"]),
    },
    {
        "name": "google_docs_append",
        "description": "Append text to the end of an existing Google Doc. Requires human approval.",
        "parameters": _schema({
            "document_id": {"type": "string"},
            "text": {"type": "string"},
        }, ["document_id", "text"]),
    },
    {
        "name": "google_sheets_read",
        "description": "Read cell values from a Google Sheet range (A1 notation). Read-only.",
        "parameters": _schema({
            "spreadsheet_id": {"type": "string"},
            "range": {"type": "string", "description": "e.g. Sheet1!A1:D50. Default A1:Z100."},
        }, ["spreadsheet_id"]),
    },
    {
        "name": "google_sheets_create",
        "description": (
            "Create a new Google Sheet in your Drive. Requires human approval. Returns the sheet link."
        ),
        "parameters": _schema({
            "title": {"type": "string"},
            "sheet_title": {"type": "string", "description": "Name of the first tab. Default Sheet1."},
        }, ["title"]),
    },
    {
        "name": "google_sheets_append",
        "description": (
            "Append rows after the last row of a Sheet range. Requires human approval. "
            "`rows` is a list of rows, each a list of cell values."
        ),
        "parameters": _schema({
            "spreadsheet_id": {"type": "string"},
            "rows": {"type": "array", "items": {"type": "array", "items": {}}, "description": "Rows of cells."},
            "range": {"type": "string", "description": "Anchor range, e.g. Invoices!A1."},
        }, ["spreadsheet_id", "rows"]),
    },
    {
        "name": "google_contacts_search",
        "description": (
            "Search Google Contacts by name, email or phone. Read-only. With no query, returns "
            "recently modified contacts."
        ),
        "parameters": _schema({
            "query": {"type": "string"},
            "max_results": {"type": "integer", "description": "1-30. Default 10."},
        }),
    },
    {
        "name": "google_contacts_create",
        "description": (
            "Create a Google contact with a name and an email address and/or phone number. "
            "Requires human approval because it writes to the user's contacts. Check with "
            "google_contacts_search first so the same person is not added twice."
        ),
        "parameters": _schema({
            "name": {"type": "string", "description": "Full name, e.g. Ana Lopez."},
            "email": {"type": "string"},
            "phone": {"type": "string", "description": "Include the country code, e.g. +31 6 1234 5678."},
            "organization": {"type": "string"},
            "title": {"type": "string", "description": "Job title."},
        }, ["name"]),
    },
    {
        "name": "google_meeting_brief",
        "description": (
            "Prepare a meeting brief from your own Gmail, Calendar and Drive: the event, attendees, "
            "recent threads per attendee, files shared with them, related documents and a suggested "
            "agenda. Read-only unless save_to_docs is true, which creates the brief as a Google Doc "
            "and requires approval."
        ),
        "parameters": _schema({
            "event_id": {"type": "string", "description": "Exact calendar event id."},
            "query": {"type": "string", "description": "Find the meeting by title when no id is given."},
            "days": {"type": "integer", "description": "Search window ahead, 1-60. Default 14."},
            "save_to_docs": {"type": "boolean", "description": "Also write the brief into a Google Doc."},
        }),
    },
    {
        "name": "google_email_to_event",
        "description": (
            "Turn an email into a calendar event. Without `confirm` it only proposes the event "
            "(title, parsed start, attendees) and changes nothing. With confirm=true it creates the "
            "event and notifies attendees, which requires approval."
        ),
        "parameters": _schema({
            "message_id": {"type": "string", "description": "Gmail message id."},
            "start": {"type": "string", "description": "Override the parsed start, ISO 8601."},
            "duration_minutes": {"type": "integer", "description": "5-480. Default 60."},
            "confirm": {"type": "boolean", "description": "Actually create the event."},
        }, ["message_id"]),
    },
    {
        "name": "google_invoices_to_sheet",
        "description": (
            "Collect invoice and receipt emails with attachments into a Google Sheet. Without "
            "`confirm` it previews rows (date, sender, subject, amount, currency, file, link) and "
            "writes nothing. With confirm=true it appends them, creating a spreadsheet when no id is "
            "given, and requires approval. Amounts are read from the subject and body, so treat them "
            "as a draft to check."
        ),
        "parameters": _schema({
            "query": {"type": "string", "description": "Extra Gmail terms. Default invoices/receipts."},
            "spreadsheet_id": {"type": "string", "description": "Target sheet. Omit to create one."},
            "days": {"type": "integer", "description": "Look-back window, 1-365. Default 45."},
            "max_results": {"type": "integer", "description": "Emails to inspect, 1-50. Default 15."},
            "confirm": {"type": "boolean", "description": "Write the rows."},
        }),
    },
    {
        "name": "google_organize_drive",
        "description": (
            "File matching Drive items into a named folder. Without `confirm` it previews the files "
            "and destination. With confirm=true it creates the folder if needed and moves the files, "
            "which requires approval. It never deletes or trashes anything."
        ),
        "parameters": _schema({
            "query": {"type": "string", "description": "Drive search for the files to move."},
            "folder_name": {"type": "string", "description": "Destination folder name."},
            "max_files": {"type": "integer", "description": "1-50. Default 25."},
            "parent_folder_id": {"type": "string", "description": "Where the folder lives."},
            "confirm": {"type": "boolean", "description": "Perform the moves."},
        }, ["query", "folder_name"]),
    },
    {
        "name": "google_calendar_search",
        "description": "Search Google Calendar events by text over the next N days (default 30). Read-only.",
        "parameters": _schema({
            "query": {"type": "string", "description": "Words to look for. Leave empty to list upcoming events."},
            "days": {"type": "integer", "description": "How many days ahead to search, 1-365. Default 30."},
            "max_results": {"type": "integer", "description": "1-50. Default 10."},
        }),
    },
    {
        "name": "google_calendar_update_event",
        "description": (
            "Change an existing calendar event: title, time, place, notes, or add guests. Give only the "
            "fields to change; a new start keeps the event's length. Requires human approval."
        ),
        "parameters": _schema({
            "event_id": {"type": "string", "description": "Event id from calendar search or agenda."},
            "summary": {"type": "string"},
            "start": {"type": "string", "description": "New start, ISO date-time, e.g. 2026-11-13T09:00."},
            "end": {"type": "string", "description": "New end, ISO date-time. Optional when start is given."},
            "description": {"type": "string"},
            "location": {"type": "string"},
            "add_attendees": {"type": "array", "items": {"type": "string"},
                              "description": "Email addresses to add as guests. Existing guests are kept."},
            "timezone": {"type": "string", "description": "IANA zone for start and end, e.g. Europe/Amsterdam."},
            "send_updates": {"type": "string", "enum": ["all", "externalOnly", "none"],
                             "description": "Who is told about the change. Default all."},
        }, ["event_id"]),
    },
    {
        "name": "google_calendar_cancel_event",
        "description": (
            "Cancel and delete a calendar event. Guests are told unless send_updates is none. "
            "Requires human approval."
        ),
        "parameters": _schema({
            "event_id": {"type": "string"},
            "send_updates": {"type": "string", "enum": ["all", "externalOnly", "none"],
                             "description": "Who is told. Default all."},
        }, ["event_id"]),
    },
    {
        "name": "google_calendar_rsvp",
        "description": (
            "Accept, decline or tentatively accept an invitation as yourself. The organiser is told. "
            "Requires human approval."
        ),
        "parameters": _schema({
            "event_id": {"type": "string"},
            "response": {"type": "string", "enum": ["accepted", "declined", "tentative"]},
        }, ["event_id", "response"]),
    },
    {
        "name": "google_gmail_update_draft",
        "description": (
            "Replace the content of an existing Gmail draft. Nothing is sent. Every field is replaced, "
            "so pass each one you want kept. Attachments on the old draft are not kept."
        ),
        "parameters": _schema({
            "draft_id": {"type": "string", "description": "Draft id from google_gmail_draft."},
            "to": {"type": "string"},
            "subject": {"type": "string"},
            "body": {"type": "string"},
            "cc": {"type": "string"},
            "bcc": {"type": "string"},
        }, ["draft_id", "to", "subject", "body"]),
    },
    {
        "name": "google_gmail_forward",
        "description": (
            "Forward an existing email to new recipients, with an optional note above the quoted original. "
            "Starts a new thread. Attachments on the original are not included. Requires human approval."
        ),
        "parameters": _schema({
            "message_id": {"type": "string", "description": "Message id from Gmail search or read."},
            "to": {"type": "string", "description": "Comma-separated recipients."},
            "note": {"type": "string", "description": "Optional text above the forwarded message."},
            "cc": {"type": "string"},
            "bcc": {"type": "string"},
        }, ["message_id", "to"]),
    },
    {
        "name": "google_docs_replace_text",
        "description": (
            "Replace every match of a phrase in a Google Doc and report how many changed. "
            "Requires human approval."
        ),
        "parameters": _schema({
            "document_id": {"type": "string"},
            "find": {"type": "string", "description": "Text to find, exactly as it appears."},
            "replace": {"type": "string", "description": "Replacement text. An empty string deletes the matches."},
            "match_case": {"type": "boolean", "description": "Match capitals exactly. Default true."},
        }, ["document_id", "find", "replace"]),
    },
    {
        "name": "google_sheets_metadata",
        "description": "List a Google Sheet's title, its tabs and their row counts. Read-only.",
        "parameters": _schema({"spreadsheet_id": {"type": "string"}}, ["spreadsheet_id"]),
    },
    {
        "name": "google_sheets_update_range",
        "description": (
            "Write rows into a fixed cell range such as Budget!A5:B6. Refuses when any of those cells "
            "already has a value, unless overwrite is true. Requires human approval."
        ),
        "parameters": _schema({
            "spreadsheet_id": {"type": "string"},
            "range": {"type": "string", "description": "A1 notation with the tab name, e.g. Budget!A5:B5."},
            "rows": {"type": "array", "items": {"type": "array", "items": {}}, "description": "Rows of cells."},
            "overwrite": {"type": "boolean", "description": "Replace cells that already have values. Default false."},
        }, ["spreadsheet_id", "range", "rows"]),
    },
    {
        "name": "google_sheets_create_tab",
        "description": "Add a new tab to an existing Google Sheet. Requires human approval.",
        "parameters": _schema({
            "spreadsheet_id": {"type": "string"},
            "title": {"type": "string", "description": "Name for the new tab."},
        }, ["spreadsheet_id", "title"]),
    },
    {
        "name": "google_contacts_update",
        "description": (
            "Change one Google contact. Only the fields you give are touched; existing emails and phone "
            "numbers are kept. Requires human approval."
        ),
        "parameters": _schema({
            "resource_name": {"type": "string", "description": "Contact id from contacts search, e.g. people/c123."},
            "name": {"type": "string"},
            "email": {"type": "string", "description": "An email address to add."},
            "phone": {"type": "string", "description": "A phone number to add."},
            "organization": {"type": "string"},
            "title": {"type": "string"},
        }, ["resource_name"]),
    },
    {
        "name": "google_contacts_delete",
        "description": (
            "Delete one Google contact. Google keeps a 30-day undo in the People app. "
            "Requires human approval."
        ),
        "parameters": _schema({
            "resource_name": {"type": "string", "description": "Contact id from contacts search, e.g. people/c123."},
        }, ["resource_name"]),
    },
    {
        "name": "google_drive_get",
        "description": "Get one Drive file's details: name, type, owners, modified time and link. Read-only.",
        "parameters": _schema({"file_id": {"type": "string"}}, ["file_id"]),
    },
    {
        "name": "google_drive_rename",
        "description": "Rename a Drive file. Collaborators see the new name. Requires human approval.",
        "parameters": _schema({
            "file_id": {"type": "string"},
            "name": {"type": "string", "description": "The new name."},
        }, ["file_id", "name"]),
    },
    {
        "name": "google_drive_trash",
        "description": (
            "Move a Drive file to the trash. The owner can restore it from Google Drive. "
            "Requires human approval."
        ),
        "parameters": _schema({
            "file_id": {"type": "string"},
        }, ["file_id"]),
    },
    {
        "name": "google_drive_share",
        "description": (
            "Give one person access to a Drive file as a reader, commenter or writer. Ownership transfer "
            "and public links are not available. Requires human approval."
        ),
        "parameters": _schema({
            "file_id": {"type": "string"},
            "email": {"type": "string", "description": "The person's email address."},
            "role": {"type": "string", "enum": ["reader", "commenter", "writer"],
                     "description": "Default reader."},
            "notify": {"type": "boolean", "description": "Email the person about the share. Default false."},
        }, ["file_id", "email"]),
    },
]

# ── Extended calendar, mail, docs, sheets, contacts and drive ────────────────


def _h_calendar_search(args: dict) -> dict:
    return services.calendar_search(
        _text(args, "query"),
        days=client.clamp(args.get("days"), 1, 365, 30),
        max_results=client.clamp(args.get("max_results"), 1, 50, 10),
    )


def _h_calendar_update_event(args: dict) -> dict:
    return services.calendar_update_event(
        _required(args, "event_id"),
        summary=_maybe_text(args, "summary"),
        start=_text(args, "start"),
        end=_text(args, "end"),
        description=_maybe_text(args, "description"),
        location=_maybe_text(args, "location"),
        add_attendees=_emails(args, "add_attendees"),
        timezone_name=_text(args, "timezone"),
        send_updates=_text(args, "send_updates") or "all",
    )


def _h_calendar_cancel_event(args: dict) -> dict:
    return services.calendar_cancel_event(
        _required(args, "event_id"),
        send_updates=_text(args, "send_updates") or "all",
    )


def _h_calendar_rsvp(args: dict) -> dict:
    return services.calendar_rsvp(_required(args, "event_id"), _required(args, "response"))


def _h_gmail_update_draft(args: dict) -> dict:
    return services.gmail_update_draft(
        _required(args, "draft_id"),
        to=_required(args, "to"),
        subject=_raw_text(args, "subject"),
        body=_raw_text(args, "body"),
        cc=_text(args, "cc"),
        bcc=_text(args, "bcc"),
    )


def _h_gmail_forward(args: dict) -> dict:
    return services.gmail_forward(
        _required(args, "message_id"),
        to=_required(args, "to"),
        note=_text(args, "note"),
        cc=_text(args, "cc"),
        bcc=_text(args, "bcc"),
    )


def _h_docs_replace_text(args: dict) -> dict:
    return services.docs_replace_text(
        _required(args, "document_id"),
        _raw_text(args, "find"),
        _raw_text(args, "replace"),
        match_case=_optional_flag(args, "match_case", True),
    )


def _h_sheets_metadata(args: dict) -> dict:
    return services.sheets_meta(_required(args, "spreadsheet_id"))


def _h_sheets_update_range(args: dict) -> dict:
    return services.sheets_update_range(
        _required(args, "spreadsheet_id"),
        _required(args, "range"),
        _rows(args),
        overwrite=_flag(args, "overwrite"),
    )


def _h_sheets_create_tab(args: dict) -> dict:
    return services.sheets_create_tab(_required(args, "spreadsheet_id"), _required(args, "title"))


def _h_contacts_update(args: dict) -> dict:
    return services.contacts_update(
        _required(args, "resource_name"),
        name=_text(args, "name"),
        email=_text(args, "email"),
        phone=_text(args, "phone"),
        organization=_text(args, "organization"),
        title=_text(args, "title"),
    )


def _h_drive_get(args: dict) -> dict:
    return services.drive_get(_required(args, "file_id"))


def _h_drive_rename(args: dict) -> dict:
    return services.drive_rename(_required(args, "file_id"), _required(args, "name"))


def _h_drive_trash(args: dict) -> dict:
    return services.drive_trash(_required(args, "file_id"))


def _h_contacts_delete(args: dict) -> dict:
    return services.contacts_delete(_required(args, "resource_name"))


def _h_drive_share(args: dict) -> dict:
    return services.drive_share(
        _required(args, "file_id"),
        _required(args, "email"),
        role=_text(args, "role") or "reader",
        notify=_flag(args, "notify"),
    )


_HANDLERS: dict[str, Callable[[dict], dict]] = {
    "google_search": _h_search,
    "google_gmail_search": _h_gmail_search,
    "google_gmail_read": _h_gmail_read,
    "google_gmail_send": _h_gmail_send,
    "google_gmail_draft": _h_gmail_draft,
    "google_gmail_modify": _h_gmail_modify,
    "google_calendar_agenda": _h_calendar_agenda,
    "google_calendar_create_event": _h_calendar_create_event,
    "google_calendar_check_availability": _h_calendar_check_availability,
    "google_sheets_create": _h_sheets_create,
    "google_drive_search": _h_drive_search,
    "google_drive_create_folder": _h_drive_create_folder,
    "google_drive_move": _h_drive_move,
    "google_docs_read": _h_docs_read,
    "google_docs_create": _h_docs_create,
    "google_docs_append": _h_docs_append,
    "google_sheets_read": _h_sheets_read,
    "google_sheets_append": _h_sheets_append,
    "google_contacts_search": _h_contacts_search,
    "google_contacts_create": _h_contacts_create,
    "google_meeting_brief": _h_meeting_brief,
    "google_email_to_event": _h_email_to_event,
    "google_invoices_to_sheet": _h_invoices_to_sheet,
    "google_organize_drive": _h_organize_drive,
    "google_calendar_search": _h_calendar_search,
    "google_calendar_update_event": _h_calendar_update_event,
    "google_calendar_cancel_event": _h_calendar_cancel_event,
    "google_calendar_rsvp": _h_calendar_rsvp,
    "google_gmail_update_draft": _h_gmail_update_draft,
    "google_gmail_forward": _h_gmail_forward,
    "google_docs_replace_text": _h_docs_replace_text,
    "google_sheets_metadata": _h_sheets_metadata,
    "google_sheets_update_range": _h_sheets_update_range,
    "google_sheets_create_tab": _h_sheets_create_tab,
    "google_contacts_update": _h_contacts_update,
    "google_contacts_delete": _h_contacts_delete,
    "google_drive_get": _h_drive_get,
    "google_drive_rename": _h_drive_rename,
    "google_drive_trash": _h_drive_trash,
    "google_drive_share": _h_drive_share,
}

_EMOJI = {
    "google_search": "🔎",
    "google_gmail_search": "✉️",
    "google_gmail_read": "📬",
    "google_gmail_send": "📤",
    "google_gmail_draft": "📝",
    "google_gmail_modify": "🏷️",
    "google_calendar_check_availability": "🕓",
    "google_sheets_create": "📊",
    "google_calendar_agenda": "📅",
    "google_calendar_create_event": "🗓️",
    "google_drive_search": "📁",
    "google_drive_create_folder": "🗂️",
    "google_drive_move": "➡️",
    "google_docs_read": "📄",
    "google_docs_create": "📃",
    "google_docs_append": "✍️",
    "google_sheets_read": "📊",
    "google_sheets_append": "🧾",
    "google_contacts_search": "👤",
    "google_contacts_create": "➕",
    "google_meeting_brief": "🤝",
    "google_email_to_event": "📨",
    "google_invoices_to_sheet": "🧾",
    "google_organize_drive": "🗃️",
    "google_calendar_search": "🔍",
    "google_calendar_update_event": "✏️",
    "google_calendar_cancel_event": "🗑️",
    "google_calendar_rsvp": "🙋",
    "google_gmail_update_draft": "📝",
    "google_gmail_forward": "↪️",
    "google_docs_replace_text": "🔁",
    "google_sheets_metadata": "📋",
    "google_sheets_update_range": "🔢",
    "google_sheets_create_tab": "🆕",
    "google_contacts_update": "📇",
    "google_contacts_delete": "🗑️",
    "google_drive_get": "📎",
    "google_drive_rename": "🔤",
    "google_drive_trash": "🗑️",
    "google_drive_share": "🔗",
}


def _wrap(handler: Callable[[dict], dict]) -> Callable[..., str]:
    def call(args: dict | None = None, **kwargs) -> str:
        try:
            return client.ok(handler(args or {}))
        except WorkspaceError as exc:
            return client.fail(exc)
        except Exception as exc:  # a tool must never raise into the agent loop
            return client.fail(exc)

    call.__name__ = getattr(handler, "__name__", "google_workspace_tool")
    return call


def register(ctx) -> None:
    for schema in SCHEMAS:
        name = schema["name"]
        handler = _HANDLERS.get(name)
        if handler is None:  # pragma: no cover - guarded by tests
            continue
        ctx.register_tool(
            name=name,
            toolset=TOOLSET,
            schema=schema,
            handler=_wrap(handler),
            description=schema.get("description", ""),
            emoji=_EMOJI.get(name, "🔧"),
        )


def _schemas_json() -> str:  # small helper for tests and docs generation
    return json.dumps(SCHEMAS, indent=2, ensure_ascii=False)

"""Approval policy for Google Workspace writes.

Hermes's ``pre_tool_call`` hook runs before any tool, and returning
``{"action": "approve", "message": ...}`` escalates the call to the human
approval gate. Reads return nothing and run immediately; every tool that can
affect another person, delete nothing but move/insert data, or spend an
irreversible action asks first.

The hook is deliberately narrow: it matches only this plugin's tool names, so it
can never slow down or veto an unrelated tool.
"""

from __future__ import annotations

import logging
from typing import Any

from . import changes

logger = logging.getLogger(__name__)

TOOLSET = "google_workspace"

# Unconditional: the tool exists to do one consequential thing.
_ALWAYS_APPROVE: dict[str, str] = {
    "google_gmail_send": "send an email",
    "google_calendar_create_event": "create a calendar event and notify attendees",
    "google_docs_create": "create a Google Doc in your Drive",
    "google_docs_append": "write into an existing Google Doc",
    "google_sheets_create": "create a Google Sheet in your Drive",
    "google_contacts_create": "add a contact to your Google contacts",
    "google_sheets_append": "append rows to a Google Sheet",
    "google_drive_create_folder": "create a folder in your Drive",
    "google_drive_move": "move a file in your Drive",
    "google_calendar_update_event": "change a calendar event",
    "google_calendar_cancel_event": "cancel a calendar event",
    "google_calendar_rsvp": "reply to a calendar invitation",
    "google_gmail_forward": "forward an email",
    "google_docs_replace_text": "replace text in a Google Doc",
    "google_sheets_update_range": "change cells in a Google Sheet",
    "google_sheets_create_tab": "add a tab to a Google Sheet",
    "google_contacts_update": "change a Google contact",
    "google_contacts_delete": "delete a Google contact",
    "google_drive_rename": "rename a file in your Drive",
    "google_drive_trash": "trash a file in your Drive",
    "google_drive_share": "share a Drive file with someone",
}

# Conditional: read-only by default, consequential when the caller opts in.
_CONDITIONAL: dict[str, tuple[str, str]] = {
    "google_meeting_brief": ("save_to_docs", "create a briefing document in your Drive"),
    "google_email_to_event": ("confirm", "create a calendar event from an email"),
    "google_invoices_to_sheet": ("confirm", "write invoice rows into Google Sheets"),
    "google_organize_drive": ("confirm", "create a folder and move Drive files into it"),
}


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _short(value: Any, limit: int = 60) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        return "(empty)"
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _addresses(value: Any) -> list[str]:
    """Split a comma/semicolon string or a list into trimmed, non-empty addresses."""
    if value is None or value == "":
        return []
    if isinstance(value, str):
        value = value.replace(";", ",").split(",")
    if not isinstance(value, (list, tuple)):
        value = [value]
    return [str(item).strip() for item in value if str(item).strip()]


def _recipient_lines(args: dict) -> list[str]:
    """To/Cc/Bcc lines for an outgoing email. Cc and Bcc are shown in full whenever set,
    so a hidden recipient can never ride along on an approved send."""
    to, cc, bcc = (_addresses(args.get(key)) for key in ("to", "cc", "bcc"))
    total = len(to) + len(cc) + len(bcc)
    lines = [f"To: {', '.join(to) or '(none)'} ({len(to)} recipient{'s' if len(to) != 1 else ''})"]
    if cc:
        lines.append(f"Cc: {', '.join(cc)}")
    if bcc:
        lines.append(f"Bcc: {', '.join(bcc)}")
    if cc or bcc:
        lines.append(f"Total recipients: {total}")
    return lines


def _guest_list(value: Any) -> str:
    guests = _addresses(value)
    return f"{', '.join(guests)} ({len(guests)})" if guests else "(none)"


def _detail(tool_name: str, args: dict) -> str:
    if tool_name == "google_gmail_send":
        subject = str(args.get("subject") or "").strip()
        return "\n".join([*_recipient_lines(args), f"Subject: {subject or '(none)'}"])
    if tool_name == "google_calendar_create_event":
        return (f"{args.get('summary') or '(untitled)'}\n"
                f"Starts: {args.get('start') or '(unset)'}\n"
                f"Attendees: {_guest_list(args.get('attendees'))}")
    if tool_name == "google_docs_create":
        return f"Title: {args.get('title') or '(untitled)'}"
    if tool_name == "google_docs_append":
        return f"Document: {args.get('document_id') or '(unset)'}"
    if tool_name == "google_sheets_create":
        return f"Title: {args.get('title') or '(untitled)'}"
    if tool_name == "google_contacts_create":
        return f"Name: {args.get('name') or '(unnamed)'}"
    if tool_name == "google_sheets_append":
        rows = args.get("rows") or []
        return f"Sheet: {args.get('spreadsheet_id') or '(unset)'}\nRows: {len(rows)}"
    if tool_name in {"google_drive_create_folder", "google_organize_drive"}:
        return f"Folder: {args.get('folder_name') or args.get('name') or '(unset)'}"
    if tool_name == "google_drive_move":
        return f"File: {args.get('file_id') or '(unset)'} → {args.get('add_parents') or '(no destination)'}"
    if tool_name == "google_email_to_event":
        return f"Message: {args.get('message_id') or '(unset)'}"
    if tool_name == "google_invoices_to_sheet":
        return f"Search: {args.get('query') or 'invoices'}\nTarget: {args.get('spreadsheet_id') or 'a new spreadsheet'}"
    if tool_name == "google_meeting_brief":
        return f"Meeting: {args.get('event_id') or args.get('query') or '(next meeting)'}"
    if tool_name == "google_docs_replace_text":
        return (f"Document: {args.get('document_id') or '(unset)'}\n"
                f"Find: {_short(args.get('find'))}\n"
                f"Replace with: {_short(args.get('replace'))}")
    if tool_name == "google_sheets_update_range":
        rows = args.get("rows") if isinstance(args.get("rows"), list) else []
        cells = sum(len(row) for row in rows if isinstance(row, list))
        overwrite = "\nOverwrites cells that already have values" if _truthy(args.get("overwrite")) else ""
        return (f"Sheet: {args.get('spreadsheet_id') or '(unset)'}\n"
                f"Range: {args.get('range') or '(unset)'}\n"
                f"Cells: {cells}{overwrite}")
    if tool_name == "google_sheets_create_tab":
        return f"Sheet: {args.get('spreadsheet_id') or '(unset)'}\nNew tab: {_short(args.get('title'))}"
    if tool_name == "google_calendar_update_event":
        lines = [f"Event: {args.get('event_id') or '(unset)'}"]
        if args.get("summary") is not None:
            lines.append(f"New title: {_short(args.get('summary'))}")
        if args.get("start"):
            lines.append(f"New start: {args.get('start')}")
        if args.get("end"):
            lines.append(f"New end: {args.get('end')}")
        if _addresses(args.get("add_attendees")):
            lines.append(f"Add guests: {_guest_list(args.get('add_attendees'))}")
        return "\n".join(lines)
    if tool_name == "google_calendar_cancel_event":
        return f"Event: {args.get('event_id') or '(unset)'}\nTell guests: {args.get('send_updates') or 'all'}"
    if tool_name == "google_calendar_rsvp":
        return f"Event: {args.get('event_id') or '(unset)'}\nReply: {args.get('response') or '(unset)'}"
    if tool_name == "google_gmail_forward":
        return "\n".join([f"Message: {args.get('message_id') or '(unset)'}", *_recipient_lines(args)])
    if tool_name == "google_gmail_modify":
        return f"Message: {args.get('message_id') or '(unset)'}"
    if tool_name == "google_contacts_update":
        return f"Contact: {args.get('resource_name') or '(unset)'}"
    if tool_name == "google_drive_rename":
        return f"File: {args.get('file_id') or '(unset)'}\nNew name: {_short(args.get('name'))}"
    if tool_name == "google_drive_share":
        return (f"File: {args.get('file_id') or '(unset)'}\n"
                f"Share with: {args.get('email') or '(unset)'} ({args.get('role') or 'reader'})")
    return ""


def pre_tool_call(tool_name: str = "", args: dict | None = None, **kwargs):
    """Escalate this plugin's writes to Hermes's approval gate."""
    if not tool_name or not tool_name.startswith("google_"):
        return None

    arguments = args if isinstance(args, dict) else {}

    if tool_name in _ALWAYS_APPROVE:
        action = _ALWAYS_APPROVE[tool_name]
    elif tool_name == "google_gmail_modify":
        # Only trash is gated: the other actions are label tweaks that notify nobody.
        if str(arguments.get("action") or "").strip().lower() != "trash":
            return None
        action = "move an email to Trash"
    elif tool_name in _CONDITIONAL:
        flag, action = _CONDITIONAL[tool_name]
        if not _truthy(arguments.get(flag)):
            return None
    else:
        return None

    detail = _detail(tool_name, arguments)
    message = f"Google Workspace wants to {action}."
    if detail:
        message = f"{message}\n\n{detail}"
    return {"action": "approve", "message": message}


def post_tool_call(tool_name: str = "", args: dict | None = None, result: Any = None,
                   session_id: str = "", turn_id: str = "", **kwargs):
    """Record a Google write this call made. Observer: never raises."""
    if not tool_name.startswith("google_"):
        return None
    try:
        changes.record(tool_name, result, args=args, session_id=session_id, turn_id=turn_id)
    except Exception:
        logger.debug("google-workspace change record failed", exc_info=True)
    return None


def on_session_end(session_id: str = "", turn_id: str = "", **kwargs):
    """Push this turn's Google changes to the Desktop. Observer: never raises."""
    try:
        changes.broadcast_pending()
    except Exception:
        logger.debug("google-workspace change broadcast failed", exc_info=True)
    return None


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("post_tool_call", post_tool_call)
    ctx.register_hook("on_session_end", on_session_end)

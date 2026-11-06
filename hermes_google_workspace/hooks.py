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


def _detail(tool_name: str, args: dict) -> str:
    if tool_name == "google_gmail_send":
        to = str(args.get("to") or "").strip()
        subject = str(args.get("subject") or "").strip()
        count = len([part for part in to.replace(";", ",").split(",") if part.strip()])
        return f"To: {to or '(none)'} ({count} recipient{'s' if count != 1 else ''})\nSubject: {subject or '(none)'}"
    if tool_name == "google_calendar_create_event":
        return (f"{args.get('summary') or '(untitled)'}\n"
                f"Starts: {args.get('start') or '(unset)'}\n"
                f"Attendees: {len(args.get('attendees') or [])}")
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
    return ""


def pre_tool_call(tool_name: str = "", args: dict | None = None, **kwargs):
    """Escalate this plugin's writes to Hermes's approval gate."""
    if not tool_name or not tool_name.startswith("google_"):
        return None

    arguments = args if isinstance(args, dict) else {}

    if tool_name in _ALWAYS_APPROVE:
        action = _ALWAYS_APPROVE[tool_name]
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


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", pre_tool_call)

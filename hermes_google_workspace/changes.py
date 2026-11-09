"""Record the Google writes Hermes makes, so the Desktop can list them.

Observer-side only: nothing here calls Google or touches the network. ``record`` is
called from ``post_tool_call`` (concurrently for parallel tool calls), ``broadcast_pending``
from ``on_session_end``. Neither may raise into the agent loop.
"""

from __future__ import annotations

import itertools
import json
import logging
import threading
import time
from collections import deque
from typing import Any, Callable

logger = logging.getLogger(__name__)

PLUGIN_ID = "google-workspace"
EVENT_NAME = "turn.changes"

BUFFER_LIMIT = 200
BROADCAST_LIMIT = 25
TITLE_LIMIT = 80

_lock = threading.Lock()
_pending: deque[dict] = deque(maxlen=BUFFER_LIMIT)
_counter = itertools.count(1)

_SHEETS_URL = "https://docs.google.com/spreadsheets/d/{}/edit"
_MODIFY_ACTIONS = {
    "mark_read": "Marked read",
    "mark_unread": "Marked unread",
    "star": "Starred",
    "unstar": "Unstarred",
    "archive": "Archived",
    "trash": "Trashed",
}
_RSVP_ACTIONS = {"accepted": "Accepted", "declined": "Declined", "tentative": "Maybe"}


def _get(obj: Any, *path: str) -> Any:
    for key in path:
        obj = obj.get(key) if isinstance(obj, dict) else None
    return obj


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _count(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _simple(service: str, action: str, title: Callable[[dict, dict], Any],
            url: Callable[[dict, dict], Any] | None = None,
            changed: Callable[[dict, dict], bool] | None = None):
    """One extraction rule: (service, action text, title, url, changed)."""
    return (service, action, title, url or (lambda data, args: ""), changed or (lambda data, args: True))


def _web_url(data: dict, args: dict) -> Any:
    return data.get("webUrl")


def _data(key: str):
    return lambda data, args: data.get(key)


def _arg(key: str):
    return lambda data, args: args.get(key)


def _nested(*path: str):
    return lambda data, args: _get(data, *path)


def _organize_title(data: dict, args: dict) -> str:
    count = len(data.get("moved") or [])
    return f"{count} file{'s' if count != 1 else ''} → {_get(data, 'folder', 'name') or ''}"


def _invoice_url(data: dict, args: dict) -> Any:
    sheet = data.get("spreadsheet") or {}
    if sheet.get("webUrl"):
        return sheet["webUrl"]
    return _SHEETS_URL.format(sheet["id"]) if sheet.get("id") else ""


# tool name -> (service, action, title, url, changed). Actions that depend on the result are
# resolved in _action(); the rest are fixed text.
_RULES: dict[str, tuple] = {
    "google_gmail_send": _simple("gmail", "Sent email", lambda d, a: a.get("subject") or "(no subject)", _web_url),
    "google_gmail_draft": _simple("gmail", "Saved draft", _arg("subject"), _web_url),
    "google_gmail_update_draft": _simple("gmail", "Updated draft", _arg("subject"), _web_url),
    "google_gmail_forward": _simple("gmail", "Forwarded email", lambda d, a: "", _web_url),
    "google_gmail_modify": _simple(
        "gmail", "", lambda d, a: "",
        lambda d, a: f"https://mail.google.com/mail/u/0/#all/{d['id']}" if d.get("id") else ""),
    "google_calendar_create_event": _simple("calendar", "Created event", _data("summary"), _web_url),
    "google_calendar_update_event": _simple("calendar", "Updated event", _data("summary"), _web_url),
    "google_calendar_cancel_event": _simple("calendar", "Cancelled event", _data("id")),
    "google_calendar_rsvp": _simple("calendar", "", _data("summary")),
    "google_docs_create": _simple("docs", "Created document", _data("title"), _web_url),
    "google_docs_append": _simple("docs", "Appended text", _data("title"), _web_url),
    "google_docs_replace_text": _simple(
        "docs", "", _data("find"), _web_url, lambda d, a: bool(d.get("replaced"))),
    "google_sheets_create": _simple("sheets", "Created spreadsheet", _data("title"), _web_url),
    "google_sheets_append": _simple("sheets", "", _data("range"), _web_url),
    "google_sheets_update_range": _simple("sheets", "", _data("range"), _web_url),
    "google_sheets_create_tab": _simple("sheets", "Added tab", _data("title"), _web_url),
    "google_drive_create_folder": _simple("drive", "Created folder", _data("name"), _web_url),
    "google_drive_move": _simple("drive", "Moved file", _data("name"), _web_url),
    "google_drive_rename": _simple("drive", "Renamed file", _data("name"), _web_url),
    "google_drive_trash": _simple("drive", "Trashed file", _data("name"), _web_url),
    "google_drive_share": _simple("drive", "Shared file", _data("email")),
    "google_contacts_create": _simple("contacts", "Created contact", _data("name")),
    "google_contacts_update": _simple("contacts", "Updated contact", _data("name")),
    "google_contacts_delete": _simple("contacts", "Deleted contact", _arg("resource_name")),
    "google_email_to_event": _simple(
        "calendar", "Created event", _nested("event", "summary"), _nested("event", "webUrl"),
        lambda d, a: bool(d.get("created"))),
    "google_invoices_to_sheet": _simple(
        "sheets", "Added invoice rows", _nested("spreadsheet", "title"), _invoice_url,
        lambda d, a: bool(d.get("created"))),
    "google_organize_drive": _simple(
        "drive", "Organized Drive", _organize_title, _nested("folder", "webUrl"),
        lambda d, a: bool(d.get("created")) and len(d.get("moved") or []) > 0),
    "google_meeting_brief": _simple(
        "docs", "Saved brief", _nested("document", "title"), _nested("document", "webUrl"),
        lambda d, a: bool(d.get("created"))),
}


def _action(tool_name: str, fixed: str, data: dict) -> str:
    if tool_name == "google_gmail_modify":
        return _MODIFY_ACTIONS.get(_text(data.get("action")), "Updated email")
    if tool_name == "google_calendar_rsvp":
        return f"Replied {_RSVP_ACTIONS.get(_text(data.get('response')).lower(), 'to invitation')}"
    if tool_name == "google_docs_replace_text":
        n = _count(data.get("occurrencesChanged"))
        return f"Replaced {n} match{'es' if n != 1 else ''}"
    if tool_name == "google_sheets_append":
        n = _count(data.get("updatedRows"))
        return f"Appended {n} row{'s' if n != 1 else ''}"
    if tool_name == "google_sheets_update_range":
        n = _count(data.get("updatedCells"))
        return f"Updated {n} cell{'s' if n != 1 else ''}"
    return fixed


def _parse(result: Any) -> dict | None:
    if isinstance(result, (str, bytes, bytearray)):
        try:
            result = json.loads(result)
        except ValueError:
            return None
    return result if isinstance(result, dict) else None


def record(tool_name: str, result: Any, *, args: dict | None = None,
           session_id: str = "", turn_id: str = "") -> dict | None:
    """Buffer one Google write. Returns the entry, or None when there is nothing to show."""
    rule = _RULES.get(tool_name)
    if rule is None:
        return None
    payload = _parse(result)
    if payload is None or payload.get("ok") is not True:
        return None
    data = payload.get("data")
    data = data if isinstance(data, dict) else {}
    arguments = args if isinstance(args, dict) else {}
    service, action, title, url, changed = rule
    if not changed(data, arguments):
        return None
    with _lock:
        entry = {
            "id": f"{tool_name}:{next(_counter)}",
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "service": service,
            "action": _action(tool_name, action, data),
            "title": _text(title(data, arguments))[:TITLE_LIMIT],
            "url": _text(url(data, arguments)),
            "sessionId": _text(session_id),
            "turnId": _text(turn_id),
        }
        _pending.append(entry)
    return entry


def drain(limit: int = BROADCAST_LIMIT) -> list[dict]:
    """Pop up to ``limit`` buffered entries, oldest first."""
    with _lock:
        count = min(max(int(limit), 0), len(_pending))
        return [_pending.popleft() for _ in range(count)]


def broadcast_pending(limit: int = BROADCAST_LIMIT) -> int:
    """Push the buffered entries to every Desktop window. Never raises."""
    try:
        entries = drain(limit)
        if not entries:
            return 0
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event(PLUGIN_ID, EVENT_NAME, {"changes": entries})
        return len(entries)
    except Exception:
        logger.debug("google-workspace change broadcast failed", exc_info=True)
        return 0

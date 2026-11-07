"""Google Workspace dashboard API.

Mounted by the Hermes desktop backend at ``/api/plugins/google-workspace/``.
Loaded standalone, so the plugin root goes on ``sys.path`` and the shared package
is imported by its real name.

Reads are cached for a few seconds to keep the page snappy while tabbing; writes
clear the cache. Every write requires an explicit ``confirm: true`` in the body,
independent of the human clicking the button, so a stray request cannot send mail.
"""

from __future__ import annotations

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, Body, HTTPException, Query

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from hermes_google_workspace import client, services, workflows  # noqa: E402
from hermes_google_workspace.client import WorkspaceError  # noqa: E402

router = APIRouter()

SIGN_IN_COMMAND = client.SIGN_IN_COMMAND
_CACHE_TTL = 20.0
_cache: dict[tuple, tuple[float, Any]] = {}
_cache_lock = threading.Lock()

_SERVICE_LABELS = {
    "gmail": "Gmail",
    "calendar": "Calendar",
    "drive": "Drive",
    "docs": "Docs",
    "sheets": "Sheets",
    "contacts": "Contacts",
}


# ── Plumbing ─────────────────────────────────────────────────────────────────


def _http(exc: WorkspaceError) -> HTTPException:
    status = {
        "not_connected": 401,
        "configuration": 400,
        "scope_missing": 403,
        "forbidden": 403,
        "not_found": 404,
        "rate_limited": 429,
        "bad_request": 400,
        "network": 502,
        "google_unavailable": 502,
    }.get(exc.code, 502)
    return HTTPException(status_code=status, detail=exc.as_dict())


def _run(fn: Callable[[], Any], cache_key: Optional[tuple] = None) -> Any:
    if cache_key is not None:
        with _cache_lock:
            hit = _cache.get(cache_key)
        if hit and hit[0] > time.time():
            return hit[1]
    try:
        value = fn()
    except WorkspaceError as exc:
        raise _http(exc) from None
    if cache_key is not None:
        with _cache_lock:
            _cache[cache_key] = (time.time() + _CACHE_TTL, value)
    return value


def _invalidate() -> None:
    with _cache_lock:
        _cache.clear()


def _body(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "JSON body required."})
    return payload


def _require_confirm(payload: dict, action: str) -> None:
    confirm = payload.get("confirm")
    if confirm is not True and str(confirm).lower() not in {"true", "1", "yes"}:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "confirm_required",
                "message": f"Refusing to {action} without explicit confirmation.",
                "hint": "Send the same request with confirm: true.",
            },
        )


def _envelope(data: Any) -> dict:
    return {"ok": True, "data": data}


def _flag(value: Any) -> bool:
    """A JSON boolean, or the string forms a form might send. The string "false" is false."""
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _flag_default(value: Any, default: bool) -> bool:
    return default if value is None else _flag(value)


def _emails(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        value = value.replace(";", ",").split(",")
    if not isinstance(value, list):
        raise HTTPException(
            status_code=400,
            detail={"code": "bad_request", "message": "addAttendees must be a list of email addresses."},
        )
    return [str(item).strip() for item in value if str(item).strip()]


# ── Status ───────────────────────────────────────────────────────────────────


def _probe_gmail() -> tuple[str, str]:
    profile = services.gmail_profile()
    return ("ready", str(profile.get("emailAddress") or ""))


def _probe_calendar() -> tuple[str, str]:
    agenda = services.calendar_agenda(days=1, max_results=1)
    return ("ready", f"{agenda.get('count', 0)} event(s) in the next day")


def _probe_drive() -> tuple[str, str]:
    recent = services.drive_recent(max_results=1)
    return ("ready", f"{recent.get('count', 0)} recent file(s)")


def _probe_contacts() -> tuple[str, str]:
    people = services.contacts_list(max_results=1)
    return ("ready", f"{people.get('count', 0)} contact(s) visible")


_PROBES: dict[str, Callable[[], tuple[str, str]]] = {
    "gmail": _probe_gmail,
    "calendar": _probe_calendar,
    "drive": _probe_drive,
    "contacts": _probe_contacts,
}


def _service_rows() -> list[dict]:
    rows: list[dict] = []
    results: dict[str, tuple[str, str]] = {}
    errors: dict[str, dict] = {}

    def probe(name: str) -> None:
        try:
            results[name] = _PROBES[name]()
        except WorkspaceError as exc:
            errors[name] = exc.as_dict()

    with ThreadPoolExecutor(max_workers=len(_PROBES)) as pool:
        list(pool.map(probe, _PROBES))

    for name in ("gmail", "calendar", "drive", "docs", "sheets", "contacts"):
        label = _SERVICE_LABELS[name]
        if name in results:
            state, detail = results[name]
            rows.append({"id": name, "label": label, "state": state, "detail": detail})
        elif name in errors:
            error = errors[name]
            rows.append({
                "id": name,
                "label": label,
                "state": "needs_permission" if error.get("code") == "scope_missing" else "error",
                "detail": error.get("message", ""),
                "hint": error.get("hint", ""),
            })
        else:
            rows.append({
                "id": name,
                "label": label,
                "state": "untested",
                "detail": "Checked the first time you use it.",
            })
    return rows


def _credential_configured(name: str) -> bool:
    """Whether a declared variable is set for this profile. Never returns its value.

    Reads go through Hermes's profile-scoped resolver, so one profile can never report another
    profile's credentials. Outside a Hermes process, or on an unscoped multiplexed read, the answer
    is "not configured" rather than a guess.
    """
    try:
        from agent.secret_scope import get_secret
    except ImportError:
        return False
    try:
        return bool(get_secret(name))
    except Exception:
        return False


@router.get("/status")
def status() -> dict:
    rows = _run(_service_rows, ("status",))
    connected = any(row["state"] == "ready" for row in rows)
    # The Gmail probe reports the signed-in address as its detail line.
    account = next(
        (row["detail"] for row in rows if row["id"] == "gmail" and row["state"] == "ready"), ""
    )
    credential_env = _credential_configured("GOOGLE_WORKSPACE_CLIENT_ID") and _credential_configured(
        "GOOGLE_WORKSPACE_CLIENT_SECRET"
    )
    return _envelope({
        "connected": connected,
        "account": account,
        "services": rows,
        "setup": {
            "clientConfigured": credential_env,
            "signInCommand": SIGN_IN_COMMAND,
            "signOutCommand": "hermes auth logout google-workspace:google",
            "statusCommand": "hermes auth status google-workspace:google",
        },
    })


@router.get("/overview")
def overview() -> dict:
    def build() -> dict:
        result: dict[str, Any] = {
            "unread": 0,
            "events": [],
            "messages": [],
            "files": [],
            "errors": {},
        }
        try:
            result["unread"] = services.gmail_unread_count()
        except WorkspaceError as exc:
            result["errors"]["gmail"] = exc.as_dict()
        try:
            agenda = services.calendar_agenda(days=1, max_results=8)
            result["events"] = agenda.get("events") or []
        except WorkspaceError as exc:
            result["errors"]["calendar"] = exc.as_dict()
        try:
            result["messages"] = services.gmail_list("in:inbox", max_results=5).get("messages") or []
        except WorkspaceError as exc:
            result["errors"]["gmail_inbox"] = exc.as_dict()
        try:
            result["files"] = services.drive_recent(max_results=6).get("files") or []
        except WorkspaceError as exc:
            result["errors"]["drive"] = exc.as_dict()
        result["generatedAt"] = services.rfc3339(services.now_utc())
        return result

    return _envelope(_run(build, ("overview",)))


# ── Reads ────────────────────────────────────────────────────────────────────


@router.get("/gmail")
def gmail_list(
    query: str = Query(""),
    max_results: int = Query(12, ge=1, le=50),
    page_token: str = Query(""),
) -> dict:
    key = ("gmail", query, max_results, page_token)
    return _envelope(_run(lambda: services.gmail_list(query, max_results, page_token), key))


@router.get("/gmail/{message_id}")
def gmail_read(message_id: str) -> dict:
    return _envelope(_run(lambda: services.gmail_read(message_id), ("gmail:read", message_id)))


@router.get("/calendar")
def calendar(days: int = Query(7, ge=1, le=90), max_results: int = Query(30, ge=1, le=100)) -> dict:
    return _envelope(_run(lambda: services.calendar_agenda(days, max_results), ("calendar", days, max_results)))


@router.get("/calendar/month")
def calendar_month(month: str = Query(""), max_results: int = Query(200, ge=1, le=250)) -> dict:
    return _envelope(_run(lambda: services.calendar_month(month, max_results), ("calendar_month", month, max_results)))


@router.get("/drive")
def drive(
    query: str = Query(""),
    max_results: int = Query(25, ge=1, le=100),
    mime_type: str = Query(""),
) -> dict:
    key = ("drive", query, max_results, mime_type)
    if query or mime_type:
        return _envelope(
            _run(
                lambda: services.drive_search(query, max_results, mime_type=mime_type),
                key,
            )
        )
    return _envelope(_run(lambda: services.drive_recent(max_results), key))


@router.get("/docs/{document_id}")
def docs(document_id: str) -> dict:
    return _envelope(_run(lambda: services.docs_read(document_id), ("docs", document_id)))


@router.get("/sheets/{spreadsheet_id}")
def sheets(spreadsheet_id: str, range: str = Query("A1:Z100")) -> dict:
    key = ("sheets", spreadsheet_id, range)
    return _envelope(_run(lambda: services.sheets_read(spreadsheet_id, range), key))


@router.get("/contacts")
def contacts(query: str = Query(""), max_results: int = Query(40, ge=1, le=100)) -> dict:
    key = ("contacts", query, max_results)
    if query:
        return _envelope(_run(lambda: services.contacts_search(query, max_results), key))
    return _envelope(_run(lambda: services.contacts_list(max_results), key))


@router.post("/contacts")
def create_contact(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "create a Google contact")
    try:
        contact = services.contacts_create(
            name=str(body.get("name") or ""),
            email=str(body.get("email") or ""),
            phone=str(body.get("phone") or ""),
            organization=str(body.get("organization") or ""),
            title=str(body.get("title") or ""),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(contact)


@router.get("/search")
def search(query: str = Query(..., min_length=1), max_results: int = Query(5, ge=1, le=20)) -> dict:
    return _envelope(_run(lambda: _search_all(query, max_results), ("search", query, max_results)))


def _search_all(query: str, limit: int) -> dict:
    result: dict[str, Any] = {"query": query, "messages": [], "events": [], "files": [], "errors": {}}
    for key, loader in (
        ("messages", lambda: services.gmail_list(query, max_results=limit).get("messages") or []),
        ("events", lambda: services.calendar_search(query, days=365, max_results=limit).get("events") or []),
        ("files", lambda: services.drive_search(query, max_results=limit).get("files") or []),
    ):
        try:
            result[key] = loader()
        except WorkspaceError as exc:
            result["errors"][key] = exc.as_dict()
    return result


@router.get("/brief")
def brief(event_id: str = Query(""), query: str = Query(""), days: int = Query(14, ge=1, le=60)) -> dict:
    key = ("brief", event_id, query, days)
    return _envelope(_run(lambda: workflows.meeting_brief(event_id=event_id, query=query, days=days), key))


# ── Writes ───────────────────────────────────────────────────────────────────


@router.post("/send")
def send(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "send email")
    to = str(body.get("to") or "").strip()
    if not to:
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "A recipient is required."})
    try:
        sent = services.gmail_send(
            to=to,
            subject=str(body.get("subject") or ""),
            body=str(body.get("body") or ""),
            cc=str(body.get("cc") or ""),
            bcc=str(body.get("bcc") or ""),
            thread_id=str(body.get("thread_id") or ""),
            in_reply_to=str(body.get("in_reply_to") or ""),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(sent)


@router.post("/draft")
def save_draft(payload: dict = Body(...)) -> dict:
    """Save a Gmail draft. Reversible and does not notify anyone, so no confirm."""
    body = _body(payload)
    to = str(body.get("to") or "").strip()
    if not to:
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "A recipient is required."})
    try:
        draft = services.gmail_draft(
            to=to,
            subject=str(body.get("subject") or ""),
            body=str(body.get("body") or ""),
            cc=str(body.get("cc") or ""),
            bcc=str(body.get("bcc") or ""),
            thread_id=str(body.get("thread_id") or ""),
            in_reply_to=str(body.get("in_reply_to") or ""),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(draft)


@router.get("/email-to-event")
def email_to_event_preview(
    message_id: str = Query(..., min_length=1),
    duration_minutes: int = Query(60, ge=5, le=480),
) -> dict:
    return _envelope(
        _run(
            lambda: workflows.email_to_event_proposal(message_id, duration_minutes),
            ("email-to-event", message_id, duration_minutes),
        )
    )


@router.post("/email-to-event")
def email_to_event_create(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "create a calendar event from an email")
    message_id = str(body.get("messageId") or "").strip()
    if not message_id:
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "A message id is required."})
    try:
        result = workflows.email_to_event(
            message_id,
            start=str(body.get("start") or ""),
            duration_minutes=client.clamp(body.get("durationMinutes"), 5, 480, 60),
            confirm=True,
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.get("/invoices")
def invoices_preview(
    query: str = Query(""),
    days: int = Query(45, ge=1, le=365),
    max_results: int = Query(15, ge=1, le=50),
) -> dict:
    return _envelope(
        _run(
            lambda: workflows.invoices_to_sheet(query=query, days=days, max_results=max_results),
            ("invoices", query, days, max_results),
        )
    )


@router.post("/invoices")
def invoices_append(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "write invoice rows into Google Sheets")
    try:
        result = workflows.invoices_to_sheet(
            spreadsheet_id=str(body.get("spreadsheetId") or ""),
            query=str(body.get("query") or ""),
            days=client.clamp(body.get("days"), 1, 365, 45),
            max_results=client.clamp(body.get("maxResults"), 1, 50, 15),
            confirm=True,
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.get("/organize")
def organize_preview(
    query: str = Query(..., min_length=1),
    folder: str = Query(..., min_length=1),
    max_files: int = Query(25, ge=1, le=50),
) -> dict:
    return _envelope(
        _run(
            lambda: workflows.organize_drive(
                query=query, folder_name=folder, max_files=max_files
            ),
            ("organize", query, folder, max_files),
        )
    )


@router.post("/organize")
def organize_apply(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "create a folder and move Drive files into it")
    try:
        result = workflows.organize_drive(
            query=str(body.get("query") or ""),
            folder_name=str(body.get("folder") or ""),
            max_files=client.clamp(body.get("maxFiles"), 1, 50, 25),
            parent_folder_id=str(body.get("parentFolderId") or ""),
            confirm=True,
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/sheets")
def create_sheet(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "create a Google Sheet")
    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "A title is required."})
    try:
        sheet = services.sheets_create(title, str(body.get("sheetTitle") or "Sheet1"))
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(sheet)


@router.post("/event")
def create_event(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "create a calendar event")
    attendees = body.get("attendees") or []
    if isinstance(attendees, str):
        attendees = [part.strip() for part in attendees.replace(";", ",").split(",") if part.strip()]
    try:
        event = services.calendar_create_event(
            summary=str(body.get("summary") or ""),
            start=str(body.get("start") or ""),
            end=str(body.get("end") or ""),
            duration_minutes=client.clamp(body.get("durationMinutes"), 5, 1440, 30),
            description=str(body.get("description") or ""),
            location=str(body.get("location") or ""),
            attendees=attendees,
            add_meet=bool(body.get("addMeet")),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(event)


@router.post("/docs")
def create_doc(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "create a Google Doc")
    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "A title is required."})
    try:
        document = services.docs_create(title, str(body.get("text") or ""))
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(document)


@router.post("/docs/{document_id}/append")
def append_doc(document_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "append text to a Google Doc")
    text = str(body.get("text") or "")
    if not text.strip():
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "Text is required."})
    try:
        result = services.docs_append(document_id, text)
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/brief/save")
def save_brief(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "create a briefing document")
    try:
        brief_data = workflows.meeting_brief(
            event_id=str(body.get("eventId") or ""),
            query=str(body.get("query") or ""),
            days=client.clamp(body.get("days"), 1, 60, 14),
        )
        event = brief_data.get("event") or {}
        day = str(event.get("start") or "")[:10]
        title = f"Meeting brief — {event.get('summary') or 'Meeting'}" + (f" — {day}" if day else "")
        document = services.docs_create(title, workflows.brief_markdown(brief_data))
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope({"document": document, "brief": brief_data})


@router.post("/gmail/{message_id}/modify")
def gmail_modify(message_id: str, payload: dict = Body(...)) -> dict:
    """Mark read or unread, star or unstar, or archive. Reversible and silent, so no confirmation step."""
    body = _body(payload)
    try:
        result = services.gmail_modify(message_id, str(body.get("action") or ""))
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/sheets/{spreadsheet_id}/append")
def sheets_append(spreadsheet_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "append rows to a Google Sheet")
    try:
        result = services.sheets_append(
            spreadsheet_id,
            services.clean_rows(body.get("rows")),
            str(body.get("range") or "A1"),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


# ── Changes to existing items ────────────────────────────────────────────────
# The UI reviews each change and then sends confirm: true. Nothing here is sent without it.


@router.post("/calendar/events/{event_id}/update")
def update_event(event_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "change a calendar event")
    try:
        result = services.calendar_update_event(
            event_id,
            summary=None if body.get("summary") is None else str(body.get("summary")),
            start=str(body.get("start") or ""),
            end=str(body.get("end") or ""),
            description=None if body.get("description") is None else str(body.get("description")),
            location=None if body.get("location") is None else str(body.get("location")),
            add_attendees=_emails(body.get("addAttendees")),
            timezone_name=str(body.get("timezone") or ""),
            send_updates=str(body.get("sendUpdates") or "all"),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/calendar/events/{event_id}/cancel")
def cancel_event(event_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "cancel a calendar event")
    try:
        result = services.calendar_cancel_event(event_id, send_updates=str(body.get("sendUpdates") or "all"))
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/calendar/events/{event_id}/rsvp")
def rsvp_event(event_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "reply to a calendar invitation")
    try:
        result = services.calendar_rsvp(event_id, str(body.get("response") or ""))
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/drive/files/{file_id}/rename")
def rename_file(file_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "rename a Drive file")
    try:
        result = services.drive_rename(file_id, str(body.get("name") or ""))
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/drive/files/{file_id}/share")
def share_file(file_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "share a Drive file")
    try:
        result = services.drive_share(
            file_id,
            str(body.get("email") or ""),
            role=str(body.get("role") or "reader"),
            notify=_flag(body.get("notify")),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/drive/files/{file_id}/trash")
def trash_file(file_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "trash a Drive file")
    try:
        result = services.drive_trash(file_id)
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/docs/{document_id}/replace")
def replace_doc_text(document_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "replace text in a Google Doc")
    try:
        result = services.docs_replace_text(
            document_id,
            str(body.get("find") or ""),
            str(body.get("replace") or ""),
            match_case=_flag_default(body.get("matchCase"), True),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/sheets/{spreadsheet_id}/range")
def sheets_write_range(spreadsheet_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "write cells in a Google Sheet")
    try:
        result = services.sheets_update_range(
            spreadsheet_id,
            str(body.get("range") or ""),
            services.clean_rows(body.get("rows")),
            overwrite=_flag(body.get("overwrite")),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/sheets/{spreadsheet_id}/tabs")
def sheets_add_tab(spreadsheet_id: str, payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "add a tab to a Google Sheet")
    try:
        result = services.sheets_create_tab(spreadsheet_id, str(body.get("title") or ""))
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/contacts/update")
def update_contact(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "change a Google contact")
    try:
        result = services.contacts_update(
            str(body.get("resourceName") or ""),
            name=str(body.get("name") or ""),
            email=str(body.get("email") or ""),
            phone=str(body.get("phone") or ""),
            organization=str(body.get("organization") or ""),
            title=str(body.get("title") or ""),
        )
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.post("/contacts/delete")
def delete_contact(payload: dict = Body(...)) -> dict:
    body = _body(payload)
    _require_confirm(body, "delete a Google contact")
    try:
        result = services.contacts_delete(str(body.get("resourceName") or ""))
    except WorkspaceError as exc:
        raise _http(exc) from None
    _invalidate()
    return _envelope(result)


@router.get("/calendar/availability")
def availability(
    start: str = Query(..., min_length=1),
    end: str = Query(..., min_length=1),
    timezone_name: str = Query("", alias="timezone"),
) -> dict:
    return _envelope(
        _run(
            lambda: services.calendar_availability(start, end, timezone_name),
            ("availability", start, end, timezone_name),
        )
    )

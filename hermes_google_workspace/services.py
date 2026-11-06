"""Google service operations, one thin function per API call.

Everything returns plain dictionaries so the same code serves the agent tools and
the desktop REST endpoints. No function here decides policy: approval gating lives
in :mod:`hooks`, and shapes are trimmed for humans in :mod:`tools`.
"""

from __future__ import annotations

import base64
import re
from datetime import date, datetime, time as dtime, timedelta, timezone
from email.message import EmailMessage
from email.utils import getaddresses
from html.parser import HTMLParser
from typing import Any, Iterable, Optional
from urllib.parse import quote

from . import client
from .client import WorkspaceError, get, patch, post

MAX_TEXT = 20_000


# ── Time helpers ─────────────────────────────────────────────────────────────


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def rfc3339(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    """Parse an ISO date or datetime into an aware datetime (UTC when no zone)."""
    text = str(value or "").strip()
    if not text:
        raise WorkspaceError("bad_request", "A date or time is required.")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.combine(date.fromisoformat(text), dtime(9, 0))
        except ValueError:
            raise WorkspaceError(
                "bad_request",
                f"Could not read the date/time {text!r}.",
                hint="Use ISO 8601, for example 2026-11-12T15:00:00+02:00.",
            ) from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _truncate(text: str, limit: int = MAX_TEXT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n…[truncated {len(text) - limit} characters]"


# ── HTML to text ─────────────────────────────────────────────────────────────


class _TextExtractor(HTMLParser):
    _BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table"}
    _SKIP = {"script", "style", "head"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip += 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)

    def text(self) -> str:
        joined = "".join(self.parts)
        joined = re.sub(r"[ \t]+", " ", joined)
        joined = re.sub(r"\n{3,}", "\n\n", joined)
        return joined.strip()


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(html)
        parser.close()
        return parser.text()
    except Exception:
        return re.sub(r"<[^>]+>", " ", html).strip()


# ── Gmail ────────────────────────────────────────────────────────────────────


def _b64(data: str) -> str:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8", "replace")


def _headers(payload: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in payload.get("headers") or []:
        if isinstance(item, dict) and item.get("name"):
            out[str(item["name"]).lower()] = str(item.get("value") or "")
    return out


def _parts(payload: dict) -> Iterable[dict]:
    yield payload
    for child in payload.get("parts") or []:
        if isinstance(child, dict):
            yield from _parts(child)


def extract_body(payload: dict) -> str:
    """Best-effort readable body: text/plain first, then stripped HTML."""
    plain: list[str] = []
    rich: list[str] = []
    for part in _parts(payload or {}):
        mime = str(part.get("mimeType") or "")
        data = ((part.get("body") or {}).get("data")) or ""
        if not data:
            continue
        if mime == "text/plain":
            plain.append(_b64(data))
        elif mime == "text/html":
            rich.append(html_to_text(_b64(data)))
    if plain:
        return _truncate("\n".join(chunk.strip() for chunk in plain if chunk.strip()))
    if rich:
        return _truncate("\n".join(chunk.strip() for chunk in rich if chunk.strip()))
    return ""


def _message_meta(message: dict) -> dict:
    payload = message.get("payload") or {}
    headers = _headers(payload)
    internal = message.get("internalDate")
    received = ""
    if internal:
        try:
            received = rfc3339(datetime.fromtimestamp(int(internal) / 1000, timezone.utc))
        except (TypeError, ValueError):
            received = ""
    labels = message.get("labelIds") or []
    return {
        "id": message.get("id"),
        "threadId": message.get("threadId"),
        "subject": headers.get("subject", "(no subject)"),
        "from": headers.get("from", ""),
        "to": headers.get("to", ""),
        "cc": headers.get("cc", ""),
        "date": headers.get("date", "") or received,
        "received": received,
        "snippet": message.get("snippet", ""),
        "unread": "UNREAD" in labels,
        "labels": [label for label in labels if not str(label).startswith("CATEGORY_")],
        "hasAttachments": any(
            part.get("filename") for part in _parts(payload) if isinstance(part, dict)
        ),
        "webUrl": f"https://mail.google.com/mail/u/0/#all/{message.get('id')}",
    }


def gmail_profile() -> dict:
    payload, _ = get(f"{client.GMAIL_ROOT}/profile", timeout=15)
    return payload if isinstance(payload, dict) else {}


def gmail_unread_count() -> int:
    payload, _ = get(f"{client.GMAIL_ROOT}/labels/UNREAD", timeout=15)
    if isinstance(payload, dict):
        return int(payload.get("messagesUnread") or 0)
    return 0


def _message_get(message_id: str, fmt: str = "metadata") -> dict:
    params = {"format": fmt}
    if fmt == "metadata":
        params["metadataHeaders"] = ["Subject", "From", "To", "Cc", "Date", "Message-ID"]
    payload, _ = get(
        f"{client.GMAIL_ROOT}/messages/{quote(str(message_id), safe='')}",
        params=params,
    )
    return payload if isinstance(payload, dict) else {}


def gmail_list(query: str = "", max_results: int = 10, page_token: str = "",
               include_spam_trash: bool = False) -> dict:
    limit = client.clamp(max_results, 1, 50, 10)
    params = {
        "q": query or None,
        "maxResults": limit,
        "pageToken": page_token or None,
        "includeSpamTrash": include_spam_trash or None,
    }
    listing, _ = get(f"{client.GMAIL_ROOT}/messages", params=params)
    ids = [m.get("id") for m in (listing.get("messages") or []) if isinstance(m, dict)]
    ids = [i for i in ids if i]
    sizes = listing.get("resultSizeEstimate")

    messages: list[dict] = []
    for message_id in ids:
        try:
            messages.append(_message_meta(_message_get(str(message_id))))
        except WorkspaceError as exc:
            if exc.code == "not_found":
                continue
            raise
    return {
        "messages": messages,
        "estimate": sizes,
        "nextPageToken": listing.get("nextPageToken") or "",
        "query": query,
    }


def gmail_read(message_id: str) -> dict:
    message = _message_get(message_id, fmt="full")
    if not message:
        raise WorkspaceError("not_found", f"No Gmail message {message_id!r}.")
    meta = _message_meta(message)
    meta["body"] = extract_body(message.get("payload") or {})
    meta["messageIdHeader"] = _headers(message.get("payload") or {}).get("message-id", "")
    meta["attachments"] = [
        {"filename": part.get("filename"), "mimeType": part.get("mimeType"),
         "size": int((part.get("body") or {}).get("size") or 0)}
        for part in _parts(message.get("payload") or {})
        if isinstance(part, dict) and part.get("filename")
    ]
    return meta


def gmail_thread(thread_id: str) -> dict:
    payload, _ = get(
        f"{client.GMAIL_ROOT}/threads/{quote(str(thread_id), safe='')}",
        params={"format": "full"},
    )
    messages = []
    for message in (payload.get("messages") or []):
        if not isinstance(message, dict):
            continue
        meta = _message_meta(message)
        meta["body"] = extract_body(message.get("payload") or {})
        messages.append(meta)
    if not messages:
        raise WorkspaceError("not_found", f"No Gmail thread {thread_id!r}.")
    return {"id": payload.get("id") or thread_id, "messages": messages}


_HEADER_UNSAFE = re.compile(r"[\r\n]+")


def _header(value: str, name: str) -> str:
    text = _HEADER_UNSAFE.sub(" ", str(value or "")).strip()
    if "\r" in text or "\n" in text:  # defensive; the sub above already removed them
        raise WorkspaceError("bad_request", f"{name} may not contain line breaks.")
    return text


def _build_raw(
    *,
    to: str,
    subject: str,
    body: str,
    cc: str = "",
    bcc: str = "",
    html: str = "",
    in_reply_to: str = "",
    references: str = "",
    from_addr: str = "",
) -> str:
    if not _header(to, "To"):
        raise WorkspaceError("bad_request", "At least one recipient is required.")
    message = EmailMessage()
    message["To"] = _header(to, "To")
    if cc:
        message["Cc"] = _header(cc, "Cc")
    if bcc:
        message["Bcc"] = _header(bcc, "Bcc")
    message["Subject"] = _header(subject, "Subject")
    if from_addr:
        message["From"] = _header(from_addr, "From")
    if in_reply_to:
        message["In-Reply-To"] = _header(in_reply_to, "In-Reply-To")
    if references:
        message["References"] = _header(references, "References")
    message.set_content(body or "")
    if html:
        message.add_alternative(html, subtype="html")
    return base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")


def gmail_send(*, to: str, subject: str, body: str, cc: str = "", bcc: str = "",
               html: str = "", thread_id: str = "", in_reply_to: str = "",
               references: str = "", from_addr: str = "") -> dict:
    raw = _build_raw(
        to=to, subject=subject, body=body, cc=cc, bcc=bcc, html=html,
        in_reply_to=in_reply_to, references=references, from_addr=from_addr,
    )
    payload: dict[str, Any] = {"raw": raw}
    if thread_id:
        payload["threadId"] = thread_id
    sent, _ = post(f"{client.GMAIL_ROOT}/messages/send", payload)
    return {
        "id": sent.get("id"),
        "threadId": sent.get("threadId"),
        "labels": sent.get("labelIds") or [],
        "webUrl": f"https://mail.google.com/mail/u/0/#all/{sent.get('id')}",
    }


def gmail_draft(*, to: str, subject: str, body: str, cc: str = "", bcc: str = "",
                html: str = "", thread_id: str = "", in_reply_to: str = "") -> dict:
    raw = _build_raw(to=to, subject=subject, body=body, cc=cc, bcc=bcc, html=html,
                     in_reply_to=in_reply_to)
    message: dict[str, Any] = {"raw": raw}
    if thread_id:
        message["threadId"] = thread_id
    draft, _ = post(f"{client.GMAIL_ROOT}/drafts", {"message": message})
    return {
        "draftId": draft.get("id"),
        "messageId": (draft.get("message") or {}).get("id"),
        "threadId": (draft.get("message") or {}).get("threadId"),
        "webUrl": "https://mail.google.com/mail/u/0/#drafts",
    }


def message_addresses(message: dict) -> list[dict]:
    """Every From/To/Cc address in a parsed message, as {name, email}."""
    seen: dict[str, dict] = {}
    for field in ("from", "to", "cc"):
        for name, email in getaddresses([message.get(field) or ""]):
            if not email or "@" not in email:
                continue
            seen.setdefault(email.lower(), {"name": name or "", "email": email})
    return list(seen.values())


# ── Calendar ─────────────────────────────────────────────────────────────────

def _calendar_url(calendar_id: str) -> str:
    return f"{client.CALENDAR_ROOT}/calendars/{quote(calendar_id or 'primary', safe='')}/events"


def _event_summary(event: dict) -> dict:
    start = event.get("start") or {}
    end = event.get("end") or {}
    attendees = []
    for person in event.get("attendees") or []:
        if not isinstance(person, dict):
            continue
        attendees.append({
            "email": person.get("email", ""),
            "name": person.get("displayName", ""),
            "response": person.get("responseStatus", ""),
            "organizer": bool(person.get("organizer")),
            "self": bool(person.get("self")),
        })
    return {
        "id": event.get("id"),
        "summary": event.get("summary") or "(no title)",
        "description": _truncate(str(event.get("description") or ""), 2000),
        "location": event.get("location") or "",
        "start": start.get("dateTime") or start.get("date") or "",
        "end": end.get("dateTime") or end.get("date") or "",
        "allDay": bool(start.get("date") and not start.get("dateTime")),
        "status": event.get("status", ""),
        "organizer": (event.get("organizer") or {}).get("email", ""),
        "attendees": attendees,
        "attendeeCount": len(attendees),
        "meetingLink": event.get("hangoutLink") or "",
        "webUrl": event.get("htmlLink") or "",
        "updated": event.get("updated", ""),
        "recurring": bool(event.get("recurringEventId")),
    }


def calendar_agenda(days: int = 7, max_results: int = 20, calendar_id: str = "primary",
                    time_min: str = "") -> dict:
    horizon = client.clamp(days, 1, 90, 7)
    start = parse_time(time_min) if time_min else now_utc()
    end = start + timedelta(days=horizon)
    payload, _ = get(
        _calendar_url(calendar_id),
        params={
            "timeMin": rfc3339(start),
            "timeMax": rfc3339(end),
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": client.clamp(max_results, 1, 100, 20),
        },
    )
    events = [_event_summary(e) for e in (payload.get("items") or []) if isinstance(e, dict)]
    return {
        "calendarId": calendar_id,
        "from": rfc3339(start),
        "to": rfc3339(end),
        "events": events,
        "count": len(events),
    }


def calendar_search(query: str, days: int = 30, max_results: int = 10) -> dict:
    horizon = client.clamp(days, 1, 365, 30)
    start = now_utc()
    payload, _ = get(
        _calendar_url("primary"),
        params={
            "q": query or None,
            "timeMin": rfc3339(start - timedelta(days=1)),
            "timeMax": rfc3339(start + timedelta(days=horizon)),
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": client.clamp(max_results, 1, 50, 10),
        },
    )
    events = [_event_summary(e) for e in (payload.get("items") or []) if isinstance(e, dict)]
    return {"query": query, "events": events, "count": len(events)}


def calendar_get_event(event_id: str, calendar_id: str = "primary") -> dict:
    payload, _ = get(f"{_calendar_url(calendar_id)}/{quote(str(event_id), safe='')}")
    if not isinstance(payload, dict) or not payload.get("id"):
        raise WorkspaceError("not_found", f"No calendar event {event_id!r}.")
    return _event_summary(payload)


def _event_time(value: str, *, all_day: bool) -> dict:
    if all_day:
        return {"date": value[:10]}
    return {"dateTime": rfc3339(parse_time(value))}


def calendar_create_event(
    *,
    summary: str,
    start: str,
    end: str = "",
    duration_minutes: int = 30,
    description: str = "",
    location: str = "",
    attendees: Optional[list[str]] = None,
    calendar_id: str = "primary",
    timezone_name: str = "",
    all_day: bool = False,
    send_updates: str = "all",
    add_meet: bool = False,
) -> dict:
    if not str(summary or "").strip():
        raise WorkspaceError("bad_request", "An event title is required.")
    starts = parse_time(start)
    if end:
        ends = parse_time(end)
    else:
        ends = starts + timedelta(minutes=client.clamp(duration_minutes, 5, 1440, 30))
    if ends <= starts:
        raise WorkspaceError("bad_request", "The event end must be after its start.")

    body: dict[str, Any] = {
        "summary": summary.strip(),
        "start": _event_time(start, all_day=all_day),
        "end": _event_time(end or rfc3339(ends), all_day=all_day),
    }
    if all_day:
        # Google treats an all-day end date as exclusive.
        body["end"] = {"date": (ends.date() + timedelta(days=1)).isoformat()}
    if timezone_name:
        body["start"]["timeZone"] = timezone_name
        body["end"]["timeZone"] = timezone_name
    if description:
        body["description"] = description
    if location:
        body["location"] = location
    people = [addr.strip() for addr in (attendees or []) if str(addr).strip()]
    if people:
        body["attendees"] = [{"email": addr} for addr in people]
    if add_meet:
        body["conferenceData"] = {
            "createRequest": {"requestId": f"hermes-{int(now_utc().timestamp())}-{abs(hash(summary)) % 9999}"}
        }

    params = {"sendUpdates": send_updates if people else "none", "conferenceDataVersion": 1}
    created, _ = post(_calendar_url(calendar_id), body, params=params)
    event = _event_summary(created if isinstance(created, dict) else {})
    event["created"] = True
    return event


# ── Drive ────────────────────────────────────────────────────────────────────

_DRIVE_FIELDS = (
    "id,name,mimeType,description,webViewLink,iconLink,size,modifiedTime,createdTime,"
    "owners(emailAddress,displayName),parents,shortcutDetails,starred,trashed"
)


def _drive_literal(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace("'", "\\'")


def drive_search(
    query: str = "",
    max_results: int = 15,
    mime_type: str = "",
    folder_id: str = "",
    order_by: str = "modifiedTime desc",
) -> dict:
    clauses = ["trashed = false"]
    if query:
        needle = _drive_literal(query)
        clauses.append(f"(name contains '{needle}' or fullText contains '{needle}')")
    if mime_type:
        clauses.append(f"mimeType = '{_drive_literal(mime_type)}'")
    if folder_id:
        clauses.append(f"'{_drive_literal(folder_id)}' in parents")
    payload, _ = get(
        f"{client.DRIVE_ROOT}/files",
        params={
            "q": " and ".join(clauses),
            "fields": f"nextPageToken,files({_DRIVE_FIELDS})",
            "pageSize": client.clamp(max_results, 1, 100, 15),
            "orderBy": order_by or None,
            "supportsAllDrives": True,
            "includeItemsFromAllDrives": True,
        },
    )
    files = [_file_summary(f) for f in (payload.get("files") or []) if isinstance(f, dict)]
    return {"query": query, "files": files, "count": len(files),
            "nextPageToken": payload.get("nextPageToken") or ""}


def _file_summary(file: dict) -> dict:
    owners = [
        {"email": o.get("emailAddress", ""), "name": o.get("displayName", "")}
        for o in (file.get("owners") or []) if isinstance(o, dict)
    ]
    return {
        "id": file.get("id"),
        "name": file.get("name") or "(untitled)",
        "mimeType": file.get("mimeType", ""),
        "size": int(file.get("size") or 0),
        "modified": file.get("modifiedTime", ""),
        "created": file.get("createdTime", ""),
        "owners": owners,
        "parents": file.get("parents") or [],
        "starred": bool(file.get("starred")),
        "webUrl": file.get("webViewLink") or "",
        "description": _truncate(str(file.get("description") or ""), 500),
    }


def drive_get(file_id: str) -> dict:
    payload, _ = get(
        f"{client.DRIVE_ROOT}/files/{quote(str(file_id), safe='')}",
        params={"fields": _DRIVE_FIELDS, "supportsAllDrives": True},
    )
    if not isinstance(payload, dict) or not payload.get("id"):
        raise WorkspaceError("not_found", f"No Drive file {file_id!r}.")
    return _file_summary(payload)


def drive_create_folder(name: str, parent_id: str = "") -> dict:
    if not str(name or "").strip():
        raise WorkspaceError("bad_request", "A folder name is required.")
    body: dict[str, Any] = {"name": name.strip(), "mimeType": "application/vnd.google-apps.folder"}
    if parent_id:
        body["parents"] = [parent_id]
    created, _ = post(
        f"{client.DRIVE_ROOT}/files",
        body,
        params={"fields": _DRIVE_FIELDS, "supportsAllDrives": True},
    )
    folder = _file_summary(created if isinstance(created, dict) else {})
    folder["created"] = True
    return folder


def drive_move(file_id: str, add_parents: str = "", remove_parents: str = "") -> dict:
    if not add_parents and not remove_parents:
        raise WorkspaceError("bad_request", "Provide a destination folder, a folder to remove, or both.")
    params = {
        "addParents": add_parents or None,
        "removeParents": remove_parents or None,
        "fields": _DRIVE_FIELDS,
        "supportsAllDrives": True,
    }
    payload, _ = patch(
        f"{client.DRIVE_ROOT}/files/{quote(str(file_id), safe='')}", {}, params=params
    )
    return _file_summary(payload if isinstance(payload, dict) else {})


def drive_find_folder(name: str, parent_id: str = "") -> Optional[dict]:
    clauses = [
        "trashed = false",
        "mimeType = 'application/vnd.google-apps.folder'",
        f"name = '{_drive_literal(name)}'",
    ]
    if parent_id:
        clauses.append(f"'{_drive_literal(parent_id)}' in parents")
    payload, _ = get(
        f"{client.DRIVE_ROOT}/files",
        params={"q": " and ".join(clauses), "fields": f"files({_DRIVE_FIELDS})", "pageSize": 1},
    )
    files = payload.get("files") or []
    return _file_summary(files[0]) if files else None


def drive_recent(max_results: int = 8) -> dict:
    payload, _ = get(
        f"{client.DRIVE_ROOT}/files",
        params={
            "q": "trashed = false and (mimeType != 'application/vnd.google-apps.folder')",
            "fields": f"files({_DRIVE_FIELDS})",
            "pageSize": client.clamp(max_results, 1, 30, 8),
            "orderBy": "modifiedTime desc",
        },
    )
    files = [_file_summary(f) for f in (payload.get("files") or []) if isinstance(f, dict)]
    return {"files": files, "count": len(files)}


# ── Docs ─────────────────────────────────────────────────────────────────────


def _doc_url(document_id: str) -> str:
    return f"https://docs.google.com/document/d/{document_id}/edit"


def _doc_text(document: dict) -> str:
    chunks: list[str] = []

    def walk(elements: list) -> None:
        for element in elements or []:
            if not isinstance(element, dict):
                continue
            paragraph = element.get("paragraph")
            if isinstance(paragraph, dict):
                for run in paragraph.get("elements") or []:
                    text = ((run or {}).get("textRun") or {}).get("content")
                    if text:
                        chunks.append(str(text))
            table = element.get("table")
            if isinstance(table, dict):
                for row in table.get("tableRows") or []:
                    cells = []
                    for cell in (row or {}).get("tableCells") or []:
                        cell_chunks: list[str] = []
                        for content in (cell or {}).get("content") or []:
                            paragraph = (content or {}).get("paragraph")
                            if isinstance(paragraph, dict):
                                cell_chunks.extend(
                                    str(((r or {}).get("textRun") or {}).get("content") or "")
                                    for r in paragraph.get("elements") or []
                                )
                        cells.append("".join(cell_chunks).strip())
                    chunks.append(" | ".join(cells) + "\n")
            if element.get("tableOfContents"):
                chunks.append("[table of contents]\n")

    walk(((document.get("body") or {}).get("content")) or [])
    text = "".join(chunks)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def docs_read(document_id: str) -> dict:
    payload, _ = get(f"{client.DOCS_ROOT}/documents/{quote(str(document_id), safe='')}")
    if not isinstance(payload, dict) or not payload.get("documentId"):
        raise WorkspaceError("not_found", f"No Google Doc {document_id!r}.")
    text = _doc_text(payload)
    return {
        "id": payload.get("documentId"),
        "title": payload.get("title") or "(untitled)",
        "revisionId": payload.get("revisionId", ""),
        "text": _truncate(text),
        "characters": len(text),
        "webUrl": _doc_url(str(payload.get("documentId"))),
    }


def docs_create(title: str, text: str = "") -> dict:
    if not str(title or "").strip():
        raise WorkspaceError("bad_request", "A document title is required.")
    created, _ = post(f"{client.DOCS_ROOT}/documents", {"title": title.strip()})
    document_id = str((created or {}).get("documentId") or "")
    if not document_id:
        raise WorkspaceError("google_unavailable", "Google did not return a document id.")
    if text.strip():
        docs_append(document_id, text)
    return {
        "id": document_id,
        "title": title.strip(),
        "webUrl": _doc_url(document_id),
        "created": True,
        "characters": len(text),
    }


def docs_append(document_id: str, text: str) -> dict:
    if not str(text or "").strip():
        raise WorkspaceError("bad_request", "Nothing to append.")
    document, _ = get(f"{client.DOCS_ROOT}/documents/{quote(str(document_id), safe='')}")
    if not isinstance(document, dict) or not document.get("documentId"):
        raise WorkspaceError("not_found", f"No Google Doc {document_id!r}.")
    end_index = int(((document.get("body") or {}).get("endIndex")) or 2)
    existing = _doc_text(document)
    prefix = "" if not existing or existing.endswith("\n") else "\n"
    inserted = prefix + text.strip() + "\n"
    post(
        f"{client.DOCS_ROOT}/documents/{quote(str(document_id), safe='')}:batchUpdate",
        {"requests": [{"insertText": {"location": {"index": max(1, end_index - 1)},
                                      "text": inserted}}]},
    )
    return {
        "id": document_id,
        "title": document.get("title") or "",
        "appendedCharacters": len(inserted),
        "webUrl": _doc_url(str(document_id)),
        "appended": True,
    }


# ── Sheets ───────────────────────────────────────────────────────────────────


def _sheet_url(spreadsheet_id: str) -> str:
    return f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit"


def sheets_read(spreadsheet_id: str, cell_range: str = "A1:Z100") -> dict:
    payload, _ = get(
        f"{client.SHEETS_ROOT}/{quote(str(spreadsheet_id), safe='')}/values/{quote(cell_range, safe='')}",
        params={"valueRenderOption": "UNFORMATTED_VALUE", "majorDimension": "ROWS"},
    )
    values = payload.get("values") or [] if isinstance(payload, dict) else []
    return {
        "id": spreadsheet_id,
        "range": (payload or {}).get("range", cell_range),
        "values": values,
        "rows": len(values),
        "webUrl": _sheet_url(spreadsheet_id),
    }


def sheets_append(spreadsheet_id: str, rows: list, cell_range: str = "A1",
                  value_input_option: str = "USER_ENTERED") -> dict:
    if not rows:
        raise WorkspaceError("bad_request", "No rows to append.")
    payload, _ = post(
        f"{client.SHEETS_ROOT}/{quote(str(spreadsheet_id), safe='')}/values/"
        f"{quote(cell_range, safe='')}:append",
        {"values": rows},
        params={"valueInputOption": value_input_option, "insertDataOption": "INSERT_ROWS"},
    )
    updates = (payload or {}).get("updates") or {}
    return {
        "id": spreadsheet_id,
        "range": updates.get("updatedRange", cell_range),
        "updatedRows": updates.get("updatedRows", len(rows)),
        "updatedCells": updates.get("updatedCells", 0),
        "webUrl": _sheet_url(spreadsheet_id),
        "appended": True,
    }


def sheets_create(title: str, sheet_title: str = "Sheet1") -> dict:
    if not str(title or "").strip():
        raise WorkspaceError("bad_request", "A spreadsheet title is required.")
    body = {
        "properties": {"title": title.strip()},
        "sheets": [{"properties": {"title": sheet_title or "Sheet1"}}],
    }
    created, _ = post(f"{client.SHEETS_ROOT}", body)
    spreadsheet_id = str((created or {}).get("spreadsheetId") or "")
    if not spreadsheet_id:
        raise WorkspaceError("google_unavailable", "Google did not return a spreadsheet id.")
    return {
        "id": spreadsheet_id,
        "title": title.strip(),
        "sheetTitle": sheet_title or "Sheet1",
        "webUrl": (created or {}).get("spreadsheetUrl") or _sheet_url(spreadsheet_id),
        "created": True,
    }


def sheets_meta(spreadsheet_id: str) -> dict:
    payload, _ = get(
        f"{client.SHEETS_ROOT}/{quote(str(spreadsheet_id), safe='')}",
        params={"fields": "spreadsheetId,properties.title,spreadsheetUrl,sheets.properties"},
    )
    props = (payload or {}).get("properties") or {}
    sheets = [
        {"title": ((s or {}).get("properties") or {}).get("title", ""),
         "rows": ((s or {}).get("properties") or {}).get("gridProperties", {}).get("rowCount", 0)}
        for s in (payload or {}).get("sheets") or []
    ]
    return {
        "id": (payload or {}).get("spreadsheetId") or spreadsheet_id,
        "title": props.get("title", ""),
        "sheets": sheets,
        "webUrl": (payload or {}).get("spreadsheetUrl") or _sheet_url(spreadsheet_id),
    }


# ── Contacts ─────────────────────────────────────────────────────────────────

_PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,urls"


def _person_summary(person: dict) -> dict:
    names = person.get("names") or [{}]
    emails = person.get("emailAddresses") or []
    phones = person.get("phoneNumbers") or []
    orgs = person.get("organizations") or []
    name = (names[0] or {}).get("displayName") if names else ""
    org = (orgs[0] or {}).get("name") if orgs else ""
    return {
        "resourceName": person.get("resourceName", ""),
        "name": name or "",
        "emails": [e.get("value", "") for e in emails if isinstance(e, dict)],
        "phones": [p.get("value", "") for p in phones if isinstance(p, dict)],
        "organization": org or "",
        "title": ((orgs[0] or {}).get("title") if orgs else "") or "",
    }


def contacts_search(query: str, max_results: int = 10) -> dict:
    payload, _ = get(
        f"{client.PEOPLE_ROOT}/people:searchContacts",
        params={
            "query": query or None,
            "readMask": _PERSON_FIELDS,
            "pageSize": client.clamp(max_results, 1, 30, 10),
        },
    )
    people = [
        _person_summary((result or {}).get("person") or {})
        for result in (payload or {}).get("results") or []
        if isinstance(result, dict)
    ]
    return {"query": query, "contacts": [p for p in people if p.get("name") or p.get("emails")]}


def contacts_list(max_results: int = 25) -> dict:
    payload, _ = get(
        f"{client.PEOPLE_ROOT}/people/me/connections",
        params={
            "personFields": _PERSON_FIELDS,
            "pageSize": client.clamp(max_results, 1, 100, 25),
            "sortOrder": "LAST_MODIFIED_DESCENDING",
        },
    )
    people = [
        _person_summary(person)
        for person in (payload or {}).get("connections") or []
        if isinstance(person, dict)
    ]
    return {"contacts": people, "count": len(people)}

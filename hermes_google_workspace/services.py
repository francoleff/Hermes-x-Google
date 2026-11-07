"""Google service operations, one thin function per API call.

Everything returns plain dictionaries so the same code serves the agent tools and
the desktop REST endpoints. No function here decides policy: approval gating lives
in :mod:`hooks`, and shapes are trimmed for humans in :mod:`tools`.
"""

from __future__ import annotations

import base64
import re
from datetime import date, datetime, time as dtime, timedelta, timezone, tzinfo
from email.message import EmailMessage
from email.utils import getaddresses
from html.parser import HTMLParser
from typing import Any, Iterable, Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import client
from .client import WorkspaceError, delete, get, patch, post, put

MAX_TEXT = 20_000
MAX_APPEND_ROWS = 500


# ── Time helpers ─────────────────────────────────────────────────────────────
#
# Naive date/times from the agent or the UI mean the *user's* wall clock. They are never read as
# UTC. Without an explicit IANA zone the host's own rules apply to that exact date, so daylight
# saving is handled correctly for events in either half of the year.


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def rfc3339(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _zone(tz_name: str) -> tzinfo:
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        raise WorkspaceError(
            "bad_request",
            f"Unknown timezone {tz_name!r}.",
            hint="Use an IANA name such as Europe/Amsterdam or America/New_York.",
        ) from None


def localize(naive: datetime, tz_name: str = "") -> datetime:
    """Attach the zone a person means: an explicit IANA name, else the host's rules for that date."""
    if naive.tzinfo is not None:
        return naive
    if tz_name:
        return naive.replace(tzinfo=_zone(tz_name))
    return naive.astimezone()


def parse_time(value: str, tz_name: str = "") -> datetime:
    """Parse an ISO date or datetime into an aware datetime. Naive input is local time."""
    text = str(value or "").strip()
    if not text:
        raise WorkspaceError("bad_request", "A date or time is required.")
    try:
        # Python 3.11+ also accepts a bare date in fromisoformat, which would give midnight, so try
        # the date-only form first: a bare date means 09:00 that day.
        parsed = datetime.combine(date.fromisoformat(text), dtime(9, 0))
    except ValueError:
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            raise WorkspaceError(
                "bad_request",
                f"Could not read the date/time {text!r}.",
                hint="Use ISO 8601, for example 2026-11-12T15:00:00+02:00.",
            ) from None
    return localize(parsed, tz_name)


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


def gmail_update_draft(
    draft_id: str,
    *,
    to: str,
    subject: str = "",
    body: str = "",
    cc: str = "",
    bcc: str = "",
    html: str = "",
    thread_id: str = "",
    in_reply_to: str = "",
) -> dict:
    """Replace a draft's content. Nothing is sent. Fields not passed here are cleared."""
    key = str(draft_id or "").strip()
    if not key:
        raise WorkspaceError("bad_request", "A draft id is required.")
    raw = _build_raw(to=to, subject=subject, body=body, cc=cc, bcc=bcc, html=html, in_reply_to=in_reply_to)
    message: dict[str, Any] = {"raw": raw}
    if thread_id:
        message["threadId"] = thread_id
    draft, _ = put(f"{client.GMAIL_ROOT}/drafts/{quote(key, safe='')}", {"message": message})
    draft = draft if isinstance(draft, dict) else {}
    inner = draft.get("message") or {}
    return {
        "draftId": draft.get("id") or key,
        "messageId": inner.get("id"),
        "threadId": inner.get("threadId"),
        "webUrl": "https://mail.google.com/mail/u/0/#drafts",
        "updated": True,
    }


def gmail_forward(message_id: str, *, to: str, note: str = "", cc: str = "", bcc: str = "") -> dict:
    """Send an existing email on to new people, with an optional note above the quoted original.

    The forward starts a new thread. Attachments on the original are not included.
    """
    if not str(to or "").strip():
        raise WorkspaceError("bad_request", "At least one recipient is required.")
    original = gmail_read(message_id)
    subject = str(original.get("subject") or "")
    forwarded_subject = subject if subject.lower().startswith("fwd:") else f"Fwd: {subject}".rstrip()
    header = "\n".join([
        "---------- Forwarded message ---------",
        f"From: {original.get('from') or ''}",
        f"Date: {original.get('date') or ''}",
        f"Subject: {subject}",
        f"To: {original.get('to') or ''}",
    ])
    quoted = f"{header}\n\n{original.get('body') or ''}"
    text = f"{note.strip()}\n\n{quoted}" if str(note or "").strip() else quoted
    raw = _build_raw(to=to, subject=forwarded_subject, body=text, cc=cc, bcc=bcc)
    sent, _ = post(f"{client.GMAIL_ROOT}/messages/send", {"raw": raw})
    sent = sent if isinstance(sent, dict) else {}
    return {
        "id": sent.get("id"),
        "threadId": sent.get("threadId"),
        "forwardedFrom": message_id,
        "webUrl": f"https://mail.google.com/mail/u/0/#all/{sent.get('id')}",
    }


# action -> (labels to add, labels to remove). Each is reversible and notifies nobody.
_MODIFY_ACTIONS: dict[str, tuple[list[str], list[str]]] = {
    "mark_read": ([], ["UNREAD"]),
    "mark_unread": (["UNREAD"], []),
    "star": (["STARRED"], []),
    "unstar": ([], ["STARRED"]),
    "archive": ([], ["INBOX"]),
    "trash": (["TRASH"], ["INBOX"]),
}


def gmail_modify(message_id: str, action: str) -> dict:
    """Read, star, archive or trash one message. Returns the message's resulting label state."""
    if action not in _MODIFY_ACTIONS:
        raise WorkspaceError(
            "bad_request",
            f"Unknown action {action!r}.",
            hint="Use one of: " + ", ".join(sorted(_MODIFY_ACTIONS)) + ".",
        )
    add, remove = _MODIFY_ACTIONS[action]
    body: dict[str, Any] = {}
    if add:
        body["addLabelIds"] = add
    if remove:
        body["removeLabelIds"] = remove
    payload, _ = post(f"{client.GMAIL_ROOT}/messages/{quote(str(message_id), safe='')}/modify", body)
    labels = list((payload or {}).get("labelIds") or [])
    return {
        "id": (payload or {}).get("id") or message_id,
        "threadId": (payload or {}).get("threadId", ""),
        "action": action,
        "labels": labels,
        "unread": "UNREAD" in labels,
        "starred": "STARRED" in labels,
        "inInbox": "INBOX" in labels,
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


def calendar_month(month: str = "", max_results: int = 200, calendar_id: str = "primary") -> dict:
    """Every event inside one calendar month, for the month grid."""
    raw = str(month or "").strip()
    if raw:
        try:
            year, mon = (int(part) for part in raw.split("-"))
            if not 1 <= mon <= 12:
                raise ValueError("month out of range")
        except (TypeError, ValueError):
            raise WorkspaceError("bad_request", "month must be YYYY-MM.")
    else:
        today = now_utc()
        year, mon = today.year, today.month
    start = datetime(year, mon, 1, tzinfo=timezone.utc)
    end = datetime(year + (mon == 12), (mon % 12) + 1, 1, tzinfo=timezone.utc)
    payload, _ = get(
        _calendar_url(calendar_id),
        params={
            "timeMin": rfc3339(start),
            "timeMax": rfc3339(end),
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": client.clamp(max_results, 1, 250, 200),
        },
    )
    events = [_event_summary(e) for e in (payload.get("items") or []) if isinstance(e, dict)]
    return {
        "calendarId": calendar_id,
        "month": f"{year:04d}-{mon:02d}",
        "from": rfc3339(start),
        "to": rfc3339(end),
        "events": events,
        "count": len(events),
    }


_SEND_UPDATES = frozenset({"all", "externalOnly", "none"})
_RSVP_RESPONSES = frozenset({"accepted", "declined", "tentative"})
_GUEST_KEYS = ("email", "displayName", "optional", "resource", "responseStatus")


def _event_id(event_id: str) -> str:
    cleaned = str(event_id or "").strip()
    if not cleaned:
        raise WorkspaceError("bad_request", "An event id is required.")
    return cleaned


def _send_updates(value: str) -> str:
    choice = str(value or "all").strip()
    if choice not in _SEND_UPDATES:
        raise WorkspaceError(
            "bad_request",
            "send_updates must be one of: " + ", ".join(sorted(_SEND_UPDATES)) + ".",
        )
    return choice


def _guest_for_patch(guest: dict) -> dict:
    """The guest fields Google accepts back. The attendee list is replaced whole, so keep every guest."""
    return {key: guest[key] for key in _GUEST_KEYS if guest.get(key) not in (None, "")}


def calendar_update_event(
    event_id: str,
    *,
    summary: Optional[str] = None,
    start: str = "",
    end: str = "",
    description: Optional[str] = None,
    location: Optional[str] = None,
    add_attendees: Optional[list[str]] = None,
    timezone_name: str = "",
    send_updates: str = "all",
    calendar_id: str = "primary",
) -> dict:
    """Change an event. Only the fields given change. A new start keeps the event's length."""
    key = _event_id(event_id)
    notify = _send_updates(send_updates)
    zone = str(timezone_name or "").strip()
    new_title = None if summary is None else " ".join(str(summary).split())
    if new_title is not None and not new_title:
        raise WorkspaceError("bad_request", "An event title cannot be blank.")
    guests = [addr.strip() for addr in (add_attendees or []) if str(addr).strip()]
    for addr in guests:
        if not _valid_email(addr):
            raise WorkspaceError("bad_request", f"{addr!r} is not a valid email address.")
    if not (new_title or start or end or description is not None or location is not None or guests):
        raise WorkspaceError(
            "bad_request",
            "Nothing to change. Give a new time, title, place, notes or guests.",
        )
    new_start = parse_time(start, zone) if start else None
    new_end = parse_time(end, zone) if end else None
    if new_start is not None and new_end is not None and new_end <= new_start:
        raise WorkspaceError("bad_request", "The event end must be after its start.")

    url = f"{_calendar_url(calendar_id)}/{quote(key, safe='')}"
    current: dict = {}
    if start or end or guests:
        payload, _ = get(url)
        if not isinstance(payload, dict) or not payload.get("id"):
            raise WorkspaceError("not_found", f"No calendar event {key!r}.")
        current = payload

    body: dict[str, Any] = {}
    if new_title is not None:
        body["summary"] = new_title
    if description is not None:
        body["description"] = description
    if location is not None:
        body["location"] = location

    if start or end:
        was_start_text = (current.get("start") or {}).get("dateTime")
        if not was_start_text:
            raise WorkspaceError(
                "bad_request",
                "All-day events can't be moved to a specific time here.",
                hint="Change the date in Google Calendar, or cancel the event and create a new one.",
            )
        was_start = parse_time(was_start_text)
        was_end = parse_time((current.get("end") or {}).get("dateTime") or was_start_text)
        starts_at = new_start if new_start is not None else was_start
        ends_at = new_end if new_end is not None else starts_at + (was_end - was_start)
        if ends_at <= starts_at:
            raise WorkspaceError("bad_request", "The event end must be after its start.")
        for field, moment in (("start", starts_at), ("end", ends_at)):
            body[field] = _event_time(moment, all_day=False)
            if zone:
                body[field]["timeZone"] = zone

    if guests:
        guests_now = [g for g in (current.get("attendees") or []) if isinstance(g, dict)]
        known = {str(g.get("email", "")).lower() for g in guests_now}
        added: list[str] = []
        for addr in guests:
            if addr.lower() not in known:
                known.add(addr.lower())
                added.append(addr)
        if added:
            body["attendees"] = [_guest_for_patch(g) for g in guests_now] + [{"email": a} for a in added]

    if not body:
        raise WorkspaceError("bad_request", "Nothing new to change: those guests are already invited.")
    updated, _ = patch(url, body, params={"sendUpdates": notify})
    result = _event_summary(updated if isinstance(updated, dict) else {})
    result["updated"] = True
    return result


def calendar_rsvp(event_id: str, response: str, *, calendar_id: str = "primary") -> dict:
    """Answer an invitation as yourself. Only your own response changes; the organiser is told."""
    key = _event_id(event_id)
    choice = str(response or "").strip().lower()
    if choice not in _RSVP_RESPONSES:
        raise WorkspaceError("bad_request", "response must be accepted, declined or tentative.")
    url = f"{_calendar_url(calendar_id)}/{quote(key, safe='')}"
    current, _ = get(url)
    if not isinstance(current, dict) or not current.get("id"):
        raise WorkspaceError("not_found", f"No calendar event {key!r}.")
    guests = [g for g in (current.get("attendees") or []) if isinstance(g, dict)]
    if not any(g.get("self") for g in guests):
        raise WorkspaceError(
            "bad_request",
            "You are not invited to this event, so there is no response to change.",
        )
    updated_guests = []
    for guest in guests:
        person = _guest_for_patch(guest)
        if guest.get("self"):
            person["responseStatus"] = choice
        updated_guests.append(person)
    patch(url, {"attendees": updated_guests}, params={"sendUpdates": "all"})
    return {
        "id": current.get("id"),
        "summary": current.get("summary") or "(no title)",
        "response": choice,
        "updated": True,
    }


def calendar_cancel_event(event_id: str, *, send_updates: str = "all", calendar_id: str = "primary") -> dict:
    """Delete an event. Guests are told unless send_updates says otherwise."""
    key = _event_id(event_id)
    notify = _send_updates(send_updates)
    delete(f"{_calendar_url(calendar_id)}/{quote(key, safe='')}", params={"sendUpdates": notify})
    return {"id": key, "cancelled": True, "sendUpdates": notify}


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


def _user_declined(event: dict) -> bool:
    return any(person.get("self") and person.get("response") == "declined" for person in event["attendees"])


def calendar_conflicts(start: datetime, end: datetime, calendar_id: str = "primary") -> list[dict]:
    """Events on the calendar that overlap [start, end). Cancelled and declined events never conflict."""
    if end <= start:
        raise WorkspaceError("bad_request", "The window must end after it starts.")
    payload, _ = get(
        _calendar_url(calendar_id),
        params={
            "timeMin": rfc3339(start),
            "timeMax": rfc3339(end),
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": 25,
        },
    )
    events = [_event_summary(item) for item in (payload.get("items") or []) if isinstance(item, dict)]
    return [event for event in events if event["status"] != "cancelled" and not _user_declined(event)]


def calendar_availability(start: str, end: str, tz_name: str = "") -> dict:
    """Whether a window is free on the primary calendar, with the events that block it."""
    window_start = parse_time(start, tz_name)
    window_end = parse_time(end, tz_name)
    if window_end <= window_start:
        raise WorkspaceError("bad_request", "The window must end after it starts.")
    conflicts = calendar_conflicts(window_start, window_end)
    return {
        "free": not conflicts,
        "from": window_start.isoformat(timespec="minutes"),
        "to": window_end.isoformat(timespec="minutes"),
        "conflicts": conflicts,
    }


def _event_time(moment: datetime, *, all_day: bool) -> dict:
    """An offset-bearing RFC 3339 time, so the event keeps the wall-clock time the user meant."""
    if all_day:
        return {"date": moment.date().isoformat()}
    return {"dateTime": moment.isoformat(timespec="seconds")}


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
    starts = parse_time(start, timezone_name)
    if all_day:
        last_day = parse_time(end, timezone_name).date() if end else starts.date()
        if last_day < starts.date():
            raise WorkspaceError("bad_request", "The all-day event ends before it starts.")
        ends = starts
    else:
        if end:
            ends = parse_time(end, timezone_name)
        else:
            ends = starts + timedelta(minutes=client.clamp(duration_minutes, 5, 1440, 30))
        if ends <= starts:
            raise WorkspaceError("bad_request", "The event end must be after its start.")

    body: dict[str, Any] = {
        "summary": summary.strip(),
        "start": _event_time(starts, all_day=all_day),
        "end": _event_time(ends, all_day=all_day),
    }
    if all_day:
        # Google treats an all-day end date as exclusive.
        body["end"] = {"date": (last_day + timedelta(days=1)).isoformat()}
    elif timezone_name:
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


_SHARE_ROLES = frozenset({"reader", "commenter", "writer"})


def drive_rename(file_id: str, name: str) -> dict:
    key = str(file_id or "").strip()
    if not key:
        raise WorkspaceError("bad_request", "A file id is required.")
    new_name = " ".join(str(name or "").split())
    if not new_name:
        raise WorkspaceError("bad_request", "A new name is required.")
    payload, _ = patch(
        f"{client.DRIVE_ROOT}/files/{quote(key, safe='')}",
        {"name": new_name},
        params={"fields": _DRIVE_FIELDS, "supportsAllDrives": True},
    )
    summary = _file_summary(payload if isinstance(payload, dict) else {})
    summary["renamed"] = True
    return summary


def drive_trash(file_id: str) -> dict:
    """Move one Drive file to the trash. Recoverable from Google Drive."""
    key = str(file_id or "").strip()
    if not key:
        raise WorkspaceError("bad_request", "A file id is required.")
    payload, _ = patch(
        f"{client.DRIVE_ROOT}/files/{quote(key, safe='')}",
        {"trashed": True},
        params={"fields": _DRIVE_FIELDS, "supportsAllDrives": True},
    )
    summary = _file_summary(payload if isinstance(payload, dict) else {})
    summary["trashed"] = True
    return summary


def drive_share(file_id: str, email: str, *, role: str = "reader", notify: bool = False) -> dict:
    """Give one person access to a file. Ownership transfer and public links are not offered here."""
    key = str(file_id or "").strip()
    if not key:
        raise WorkspaceError("bad_request", "A file id is required.")
    address = str(email or "").strip()
    if not _valid_email(address):
        raise WorkspaceError("bad_request", f"{address!r} is not a valid email address.")
    choice = str(role or "").strip().lower()
    if choice not in _SHARE_ROLES:
        raise WorkspaceError(
            "bad_request",
            "role must be reader, commenter or writer.",
            hint="Ownership transfer and public links are not available through this tool.",
        )
    payload, _ = post(
        f"{client.DRIVE_ROOT}/files/{quote(key, safe='')}/permissions",
        {"type": "user", "role": choice, "emailAddress": address},
        params={"sendNotificationEmail": bool(notify), "supportsAllDrives": True},
    )
    permission = payload if isinstance(payload, dict) else {}
    return {
        "fileId": key,
        "email": address,
        "role": permission.get("role") or choice,
        "permissionId": permission.get("id"),
        "notified": bool(notify),
        "shared": True,
    }


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


def docs_replace_text(document_id: str, find: str, replace: str = "", *, match_case: bool = True) -> dict:
    """Replace every match of a phrase in a Google Doc and report how many changed."""
    key = str(document_id or "").strip()
    search = str(find or "")
    if not key:
        raise WorkspaceError("bad_request", "A document id is required.")
    if not search.strip():
        raise WorkspaceError("bad_request", "Text to find is required.")
    payload, _ = post(
        f"{client.DOCS_ROOT}/documents/{quote(key, safe='')}:batchUpdate",
        {"requests": [{"replaceAllText": {
            "containsText": {"text": search, "matchCase": bool(match_case)},
            "replaceText": str(replace or ""),
        }}]},
    )
    reply = next(iter((payload or {}).get("replies") or []), {}) if isinstance(payload, dict) else {}
    count = int(((reply or {}).get("replaceAllText") or {}).get("occurrencesChanged") or 0)
    return {"id": key, "find": search, "occurrencesChanged": count, "replaced": count > 0,
            "webUrl": _doc_url(key)}


# ── Sheets ───────────────────────────────────────────────────────────────────


def _sheet_url(spreadsheet_id: str) -> str:
    return f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit"


MAX_UPDATE_CELLS = 1000


def _filled(cell: Any) -> bool:
    return cell is not None and str(cell).strip() != ""


def sheets_update_range(spreadsheet_id: str, cell_range: str, rows: list[list[Any]], *,
                        overwrite: bool = False) -> dict:
    """Write rows into a fixed range. Cells that already hold a value are only replaced when overwrite is set."""
    key = str(spreadsheet_id or "").strip()
    target = str(cell_range or "").strip()
    if not key:
        raise WorkspaceError("bad_request", "A spreadsheet id is required.")
    if not target:
        raise WorkspaceError("bad_request", "A range is required, for example Budget!A1:B2.")
    if not isinstance(rows, list) or not all(isinstance(row, list) for row in rows):
        raise WorkspaceError("bad_request", "Rows must be lists of cell values.")
    cells = sum(len(row) for row in rows)
    if cells == 0:
        raise WorkspaceError("bad_request", "There is nothing to write.")
    if cells > MAX_UPDATE_CELLS:
        raise WorkspaceError("bad_request", f"At most {MAX_UPDATE_CELLS} cells per call.")
    url = f"{client.SHEETS_ROOT}/{quote(key, safe='')}/values/{quote(target, safe='')}"
    if not overwrite:
        current, _ = get(url)
        values = (current.get("values") or []) if isinstance(current, dict) else []
        filled = sum(1 for row in values for cell in row if _filled(cell))
        if filled:
            raise WorkspaceError(
                "bad_request",
                f"{filled} cell(s) in {target} already have values, so nothing was written.",
                hint="Choose an empty range, or call again with overwrite set to true once the user agrees.",
            )
    payload, _ = put(url, {"values": rows}, params={"valueInputOption": "USER_ENTERED"})
    payload = payload if isinstance(payload, dict) else {}
    return {
        "id": key,
        "range": payload.get("updatedRange") or target,
        "updatedCells": int(payload.get("updatedCells") or 0),
        "overwrote": bool(overwrite),
        "updated": True,
        "webUrl": _sheet_url(key),
    }


def sheets_create_tab(spreadsheet_id: str, title: str) -> dict:
    key = str(spreadsheet_id or "").strip()
    clean = " ".join(str(title or "").split())
    if not key:
        raise WorkspaceError("bad_request", "A spreadsheet id is required.")
    if not clean:
        raise WorkspaceError("bad_request", "A tab name is required.")
    payload, _ = post(
        f"{client.SHEETS_ROOT}/{quote(key, safe='')}:batchUpdate",
        {"requests": [{"addSheet": {"properties": {"title": clean}}}]},
    )
    reply = next(iter((payload or {}).get("replies") or []), {}) if isinstance(payload, dict) else {}
    props = ((reply or {}).get("addSheet") or {}).get("properties") or {}
    return {
        "id": key,
        "title": props.get("title") or clean,
        "sheetId": props.get("sheetId"),
        "created": True,
        "webUrl": _sheet_url(key),
    }


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


def clean_rows(rows: Any) -> list[list[Any]]:
    """Validate rows for a Sheets write: a non-empty list of lists, with None cells blanked."""
    if not isinstance(rows, list) or not rows:
        raise WorkspaceError("bad_request", "`rows` must be a non-empty list of rows.")
    if len(rows) > MAX_APPEND_ROWS:
        raise WorkspaceError("bad_request", f"At most {MAX_APPEND_ROWS} rows per call.")
    cleaned: list[list[Any]] = []
    for row in rows:
        if not isinstance(row, (list, tuple)):
            raise WorkspaceError("bad_request", "Every row must be a list of cell values.")
        cleaned.append(["" if cell is None else cell for cell in row])
    return cleaned


def sheets_append(spreadsheet_id: str, rows: list, cell_range: str = "A1",
                  value_input_option: str = "USER_ENTERED") -> dict:
    rows = clean_rows(rows)
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


def _valid_email(value: str) -> bool:
    """A pragmatic check: one @, a local part, and a dotted domain with no spaces."""
    local, separator, domain = value.partition("@")
    return bool(
        separator
        and local
        and " " not in value
        and "." in domain
        and not domain.startswith(".")
        and not domain.endswith(".")
    )


def contacts_update(resource_name: str, *, name: str = "", email: str = "", phone: str = "",
                    organization: str = "", title: str = "") -> dict:
    """Change one contact. Only the fields given are touched; existing emails and phones are kept."""
    resource = str(resource_name or "").strip()
    person_id = resource[len("people/"):].strip() if resource.startswith("people/") else ""
    if not person_id:
        raise WorkspaceError("bad_request", "Use a contact's resource name, such as people/c1234.")
    clean_name = " ".join(str(name or "").split())
    clean_email = str(email or "").strip()
    clean_phone = str(phone or "").strip()
    clean_org = str(organization or "").strip()
    clean_title = str(title or "").strip()
    if not any((clean_name, clean_email, clean_phone, clean_org, clean_title)):
        raise WorkspaceError("bad_request", "Give at least one field to change.")
    if clean_email and not _valid_email(clean_email):
        raise WorkspaceError("bad_request", f"{clean_email!r} is not a valid email address.")
    person_url = f"{client.PEOPLE_ROOT}/people/{quote(person_id, safe='')}"
    current, _ = get(person_url, params={"personFields": _PERSON_FIELDS})
    if not isinstance(current, dict) or not current.get("resourceName"):
        raise WorkspaceError("not_found", f"No contact {resource!r}.")
    if not current.get("etag"):
        raise WorkspaceError(
            "google_unavailable",
            "Google did not return a version for this contact, so it was not changed.",
        )
    body: dict[str, Any] = {"etag": current["etag"]}
    fields: list[str] = []
    if clean_name:
        body["names"] = [_split_name(clean_name)]
        fields.append("names")
    if clean_email:
        known = [e.get("value", "") for e in current.get("emailAddresses") or [] if isinstance(e, dict)]
        if clean_email.lower() not in {value.lower() for value in known}:
            body["emailAddresses"] = [{"value": v} for v in known if v] + [{"value": clean_email}]
            fields.append("emailAddresses")
    if clean_phone:
        known_phones = [p.get("value", "") for p in current.get("phoneNumbers") or [] if isinstance(p, dict)]
        if clean_phone not in known_phones:
            body["phoneNumbers"] = [{"value": v} for v in known_phones if v] + [{"value": clean_phone}]
            fields.append("phoneNumbers")
    if clean_org or clean_title:
        orgs = [o for o in current.get("organizations") or [] if isinstance(o, dict)]
        existing = orgs[0] if orgs else {}
        body["organizations"] = [{
            "name": clean_org or existing.get("name", ""),
            "title": clean_title or existing.get("title", ""),
        }]
        fields.append("organizations")
    if not fields:
        raise WorkspaceError("bad_request", "Nothing new to change: that information is already on the contact.")
    updated, _ = patch(
        f"{person_url}:updateContact",
        body,
        params={"updatePersonFields": ",".join(fields), "personFields": _PERSON_FIELDS},
    )
    summary = _person_summary(updated if isinstance(updated, dict) else {})
    summary["updated"] = True
    return summary


def contacts_delete(resource_name: str) -> dict:
    """Delete one contact. Google keeps a 30-day undo in the People app."""
    resource = str(resource_name or "").strip()
    person_id = resource[len("people/"):].strip() if resource.startswith("people/") else ""
    if not person_id:
        raise WorkspaceError("bad_request", "Use a contact's resource name, such as people/c1234.")
    delete(f"{client.PEOPLE_ROOT}/people/{quote(person_id, safe='')}")
    return {"resourceName": f"people/{person_id}", "deleted": True}


def _split_name(name: str) -> dict:
    parts = name.split()
    if len(parts) <= 1:
        return {"givenName": parts[0] if parts else ""}
    return {"givenName": parts[0], "familyName": " ".join(parts[1:])}


def contacts_create(name: str, email: str = "", phone: str = "", organization: str = "",
                    title: str = "") -> dict:
    """Create one contact. Needs a name and at least one way to reach the person."""
    clean_name = " ".join(str(name or "").split())
    clean_email = str(email or "").strip()
    clean_phone = str(phone or "").strip()
    clean_org = str(organization or "").strip()
    clean_title = str(title or "").strip()
    if not clean_name:
        raise WorkspaceError("bad_request", "A contact name is required.")
    if not clean_email and not clean_phone:
        raise WorkspaceError(
            "bad_request",
            "Add an email address or a phone number for the contact.",
        )
    if clean_email and not _valid_email(clean_email):
        raise WorkspaceError("bad_request", f"{clean_email!r} is not a valid email address.")

    body: dict[str, Any] = {"names": [_split_name(clean_name)]}
    if clean_email:
        body["emailAddresses"] = [{"value": clean_email}]
    if clean_phone:
        body["phoneNumbers"] = [{"value": clean_phone}]
    organization_fields = {key: value for key, value in (("name", clean_org), ("title", clean_title)) if value}
    if organization_fields:
        body["organizations"] = [organization_fields]

    created, _ = post(
        f"{client.PEOPLE_ROOT}/people:createContact",
        body,
        params={"personFields": _PERSON_FIELDS},
    )
    summary = _person_summary(created or {})
    summary["created"] = True
    return summary

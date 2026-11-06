"""Cross-app workflows.

Each function gathers evidence from more than one Google service and returns a
reviewable proposal. Anything that writes takes an explicit ``confirm`` flag, so
the default path is read-only and the agent can show the plan first.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from email.utils import getaddresses
from typing import Any, Optional

from . import services
from .client import WorkspaceError

_STOPWORDS = {
    "the", "and", "for", "with", "about", "from", "into", "your", "our", "their",
    "this", "that", "will", "have", "has", "are", "was", "were", "meeting", "call",
    "sync", "review", "weekly", "daily", "monthly", "team", "project", "update",
    "discussion", "notes", "kickoff", "follow", "up", "1:1", "1-1",
}

_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}


def _keywords(text: str, limit: int = 4) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9&+-]{2,}", text or "")
    picked: list[str] = []
    for word in words:
        lowered = word.lower()
        if lowered in _STOPWORDS or lowered in picked:
            continue
        picked.append(lowered)
        if len(picked) >= limit:
            break
    return picked


def _parse_when(text: str, reference: datetime) -> Optional[datetime]:
    """Best-effort date/time extraction from prose. Returns None rather than guessing."""
    body = text or ""

    iso = re.search(r"\b(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})", body)
    if iso:
        year, month, day, hour, minute = (int(group) for group in iso.groups())
        return services.localize(datetime(year, month, day, hour, minute))

    day_first = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(_MONTHS) + r")\.?\s*(\d{4})?"
        r"(?:\s*(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?",
        body,
        re.IGNORECASE,
    )
    month_first = re.search(
        r"\b(" + "|".join(_MONTHS) + r")\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?"
        r"(?:\s*(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?",
        body,
        re.IGNORECASE,
    )

    match = day_first or month_first
    if not match:
        return None

    groups = match.groups()
    if day_first:
        day, month_name, year_text, hour_text, minute_text, meridiem = groups
    else:
        month_name, day, year_text, hour_text, minute_text, meridiem = groups

    month = _MONTHS.get(str(month_name).lower())
    if not month:
        return None
    year = int(year_text) if year_text else reference.year
    hour = int(hour_text) if hour_text else 9
    minute = int(minute_text) if minute_text else 0
    if meridiem:
        suffix = meridiem.lower()
        if suffix == "pm" and hour < 12:
            hour += 12
        if suffix == "am" and hour == 12:
            hour = 0
    try:
        parsed = datetime(year, month, int(day), hour, minute)
    except ValueError:
        return None
    if not year_text and parsed < reference.replace(tzinfo=None) - timedelta(days=1):
        parsed = parsed.replace(year=year + 1)
    return services.localize(parsed)


def _next_business_day(reference: datetime) -> datetime:
    candidate = reference.replace(tzinfo=None) + timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return services.localize(candidate.replace(hour=10, minute=0, second=0, microsecond=0))


# ── Meeting brief ────────────────────────────────────────────────────────────


def _resolve_event(event_id: str = "", query: str = "", days: int = 14) -> dict:
    if event_id:
        return services.calendar_get_event(event_id)
    if not query:
        raise WorkspaceError("bad_request", "Pass an event_id, or a query to find the meeting.")
    found = services.calendar_search(query, days=days, max_results=5)
    events = [e for e in found.get("events") or [] if (e.get("status") or "") != "cancelled"]
    if not events:
        raise WorkspaceError(
            "not_found",
            f"No upcoming calendar event matches {query!r} in the next {days} days.",
            hint="Try a shorter, distinctive phrase from the event title.",
        )
    return events[0]


def meeting_brief(event_id: str = "", query: str = "", days: int = 14) -> dict:
    event = _resolve_event(event_id=event_id, query=query, days=days)
    title = event.get("summary") or "Meeting"

    try:
        me = services.gmail_profile().get("emailAddress", "").lower()
    except WorkspaceError:
        me = ""

    attendees = [a for a in event.get("attendees") or [] if a.get("email")]
    others = [a for a in attendees if a.get("email", "").lower() != me]
    external = [a for a in others if a.get("email", "").lower().split("@")[-1] not in ("", "gmail.com")]

    conversations: list[dict] = []
    for person in others[:5]:
        address = person["email"]
        try:
            found = services.gmail_list(
                query=f"(from:{address} OR to:{address}) newer_than:180d", max_results=3
            )
        except WorkspaceError:
            continue
        for message in found.get("messages") or []:
            if any(item["id"] == message["id"] for item in conversations):
                continue
            conversations.append({
                "id": message["id"],
                "subject": message["subject"],
                "from": message["from"],
                "date": message["date"],
                "snippet": message["snippet"],
                "about": address,
                "webUrl": message["webUrl"],
            })

    domain_threads: list[dict] = []
    if external:
        domain = external[0]["email"].split("@")[-1]
        try:
            found = services.gmail_list(query=f"from:{domain} newer_than:180d", max_results=3)
            domain_threads = found.get("messages") or []
        except WorkspaceError:
            domain_threads = []

    keywords = _keywords(title)
    files: list[dict] = []
    seen_files: set[str] = set()
    for term in keywords[:3]:
        try:
            found = services.drive_search(query=term, max_results=4)
        except WorkspaceError:
            continue
        for file in found.get("files") or []:
            if file["id"] in seen_files:
                continue
            seen_files.add(file["id"])
            files.append(file)

    prior_notes: list[dict] = []
    for term in ("notes", "minutes", "brief"):
        try:
            found = services.drive_search(query=f"{title} {term}", max_results=3)
        except WorkspaceError:
            continue
        for file in found.get("files") or []:
            if file["id"] not in seen_files:
                seen_files.add(file["id"])
                prior_notes.append(file)

    shared_with_attendees: list[dict] = []
    for person in others[:2]:
        try:
            payload, _ = services.client.get(
                f"{services.client.DRIVE_ROOT}/files",
                params={
                    "q": f"'{person['email']}' in writers and trashed = false",
                    "fields": "files(id,name,mimeType,webViewLink,modifiedTime)",
                    "pageSize": 3,
                    "orderBy": "modifiedTime desc",
                },
            )
        except WorkspaceError:
            continue
        for file in (payload or {}).get("files") or []:
            if file["id"] in seen_files:
                continue
            seen_files.add(file["id"])
            shared_with_attendees.append({
                "id": file.get("id"),
                "name": file.get("name"),
                "mimeType": file.get("mimeType"),
                "webUrl": file.get("webViewLink"),
                "with": person["email"],
            })

    open_questions: list[str] = []
    for thread in (conversations + domain_threads)[:5]:
        subject = str(thread.get("subject") or "").strip()
        if subject and subject not in open_questions:
            open_questions.append(subject)

    brief = {
        "event": event,
        "attendees": others,
        "externalAttendees": external,
        "conversations": conversations[:8],
        "companyThreads": domain_threads[:3],
        "relatedFiles": files[:8],
        "priorNotes": prior_notes[:3],
        "sharedWithAttendees": shared_with_attendees[:4],
        "suggestedAgenda": _agenda(event, conversations, files, open_questions),
        "evidence": {
            "gmailThreads": len(conversations),
            "driveFiles": len(files) + len(prior_notes) + len(shared_with_attendees),
            "attendees": len(attendees),
        },
    }
    return brief


def _agenda(event: dict, conversations: list[dict], files: list[dict],
            subjects: list[str]) -> list[str]:
    agenda: list[str] = []
    description = str(event.get("description") or "").strip()
    if description:
        first_lines = [line.strip(" -•\t") for line in description.splitlines() if line.strip()]
        agenda.extend(first_lines[:3])
    for subject in subjects[:3]:
        cleaned = re.sub(r"^(re|fwd|fw):\s*", "", subject, flags=re.IGNORECASE).strip()
        if cleaned and cleaned not in agenda:
            agenda.append(f"Follow up: {cleaned}")
    for file in files[:2]:
        name = str(file.get("name") or "").strip()
        if name and name not in agenda:
            agenda.append(f"Review: {name}")
    return agenda[:6]


def brief_markdown(brief: dict) -> str:
    event = brief.get("event") or {}
    lines = [f"# Meeting brief — {event.get('summary', 'Meeting')}", ""]
    lines.append(f"**When:** {event.get('start', '')} → {event.get('end', '')}")
    if event.get("location"):
        lines.append(f"**Where:** {event['location']}")
    if event.get("webUrl"):
        lines.append(f"**Event:** {event['webUrl']}")
    lines.append("")

    attendees = brief.get("attendees") or []
    lines.append(f"## Attendees ({len(attendees)})")
    for person in attendees:
        label = person.get("name") or person.get("email")
        lines.append(f"- {label} <{person.get('email')}> — {person.get('response') or 'no response'}")
    if not attendees:
        lines.append("- No other attendees on the invitation.")
    lines.append("")

    agenda = brief.get("suggestedAgenda") or []
    if agenda:
        lines.append("## Suggested agenda")
        lines.extend(f"{index}. {item}" for index, item in enumerate(agenda, 1))
        lines.append("")

    conversations = brief.get("conversations") or []
    lines.append("## Recent threads")
    if conversations:
        for item in conversations:
            lines.append(f"- {item.get('date', '')} — {item.get('subject')} ({item.get('about')})")
            if item.get("snippet"):
                lines.append(f"  {item['snippet'][:200]}")
    else:
        lines.append("- No recent email with these attendees.")
    lines.append("")

    files = brief.get("relatedFiles") or []
    lines.append("## Related files")
    if files:
        lines.extend(f"- {item.get('name')} — {item.get('webUrl', '')}" for item in files)
    else:
        lines.append("- None found.")
    lines.append("")

    prior = brief.get("priorNotes") or []
    if prior:
        lines.append("## Prior notes")
        lines.extend(f"- {item.get('name')} — {item.get('webUrl', '')}" for item in prior)
        lines.append("")

    shared = brief.get("sharedWithAttendees") or []
    if shared:
        lines.append("## Shared with attendees")
        lines.extend(f"- {item.get('name')} (with {item.get('with')})" for item in shared)
        lines.append("")

    lines.append("---")
    lines.append("Prepared by Hermes from your own Gmail and Drive. Verify anything that drives a decision.")
    return "\n".join(lines)


# ── Email → calendar ─────────────────────────────────────────────────────────


def email_to_event_proposal(message_id: str, duration_minutes: int = 60) -> dict:
    message = services.gmail_read(message_id)
    subject = re.sub(r"^(re|fwd|fw):\s*", "", message.get("subject") or "", flags=re.IGNORECASE).strip()
    body = message.get("body") or message.get("snippet") or ""
    received = message.get("received") or ""

    reference = datetime.now().astimezone()
    if received:
        try:
            reference = datetime.fromisoformat(received.replace("Z", "+00:00")).astimezone()
        except ValueError:
            pass

    proposed = _parse_when(f"{subject}\n{body}", reference)
    if proposed is None:
        proposed = _next_business_day(reference)
        certainty = "guess"
        note = "No date or time was found in the email, so this is the next business day at 10:00."
    else:
        certainty = "parsed"
        note = "Date and time were read from the email text; confirm before creating."

    me = ""
    try:
        me = services.gmail_profile().get("emailAddress", "").lower()
    except WorkspaceError:
        pass

    attendees = []
    for _, address in getaddresses([message.get("from") or "", message.get("to") or "",
                                    message.get("cc") or ""]):
        if address and address.lower() != me and address.lower() not in [a.lower() for a in attendees]:
            attendees.append(address)

    duration = max(5, min(480, int(duration_minutes or 60)))
    conflicts: list[dict] = []
    conflict_check: dict[str, Any] = {"ok": True}
    try:
        conflicts = services.calendar_conflicts(proposed, proposed + timedelta(minutes=duration))
    except WorkspaceError as exc:  # a missing calendar grant must not hide the rest of the proposal
        conflict_check = {"ok": False, "error": exc.as_dict()}
    if conflicts:
        count = len(conflicts)
        note = f"{note} It overlaps {count} event{'s' if count != 1 else ''} on your calendar."

    return {
        "source": {
            "messageId": message.get("id"),
            "threadId": message.get("threadId"),
            "subject": message.get("subject"),
            "from": message.get("from"),
            "webUrl": message.get("webUrl"),
        },
        "proposal": {
            "summary": subject[:200] or "New meeting",
            "start": proposed.isoformat(timespec="minutes"),
            "durationMinutes": duration_minutes,
            "attendees": attendees,
            "description": (
                f"Created from an email from {message.get('from')}.\n\n"
                f"{message.get('snippet') or ''}\n\n{message.get('webUrl') or ''}"
            ).strip(),
        },
        "certainty": certainty,
        "note": note,
        "conflicts": conflicts,
        "conflictCheck": conflict_check,
    }


def email_to_event(message_id: str, *, start: str = "", duration_minutes: int = 60,
                   confirm: bool = False) -> dict:
    proposal = email_to_event_proposal(message_id, duration_minutes=duration_minutes)
    chosen_start = start or proposal["proposal"]["start"]
    if not confirm:
        proposal["created"] = False
        proposal["next"] = ("Call again with confirm=true (and optionally a start) to create the event.")
        return proposal

    created = services.calendar_create_event(
        summary=proposal["proposal"]["summary"],
        start=chosen_start,
        duration_minutes=duration_minutes,
        description=proposal["proposal"]["description"],
        attendees=proposal["proposal"]["attendees"],
        send_updates="all",
    )
    proposal["event"] = created
    proposal["created"] = True
    return proposal


# ── Invoices → Sheets ────────────────────────────────────────────────────────

_AMOUNT = re.compile(
    r"(?:total|amount|due|balance|totaal|montant|importe)[^0-9]{0,24}?"
    r"(?P<currency>USD|EUR|GBP|NAD|ZAR|\$|€|£)?\s?"
    r"(?P<amount>\d{1,3}(?:[ ,.]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})?)",
    re.IGNORECASE,
)
_ANY_AMOUNT = re.compile(
    r"(?P<currency>USD|EUR|GBP|NAD|ZAR|\$|€|£)\s?(?P<amount>\d{1,3}(?:[ ,.]\d{3})*(?:[.,]\d{2})?)",
    re.IGNORECASE,
)


def _normalize_amount(raw: str) -> float:
    """Read 1.234,56 and 1,234.56 (both mean one thousand two hundred thirty-four and 56 cents) and 99.50."""
    text = raw.replace(" ", "")
    if "," in text and "." in text:
        # The separator that comes last is the decimal mark; the other one groups thousands.
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif text.count(",") == 1 and len(text.split(",")[1]) == 2:
        text = text.replace(",", ".")
    elif text.count(".") == 1 and len(text.split(".")[1]) == 2:
        pass
    else:
        text = text.replace(",", "").replace(".", "")
    return float(text)


def _parse_amount(*texts: str) -> tuple[str, str]:
    for text in texts:
        for pattern in (_AMOUNT, _ANY_AMOUNT):
            match = pattern.search(text or "")
            if match:
                currency = (match.group("currency") or "").strip()
                try:
                    value = _normalize_amount(match.group("amount"))
                except ValueError:
                    continue
                return currency, f"{value:.2f}"
    return "", ""


def invoices_to_sheet(*, spreadsheet_id: str = "", query: str = "", days: int = 45,
                      max_results: int = 15, confirm: bool = False) -> dict:
    window = max(1, min(365, int(days or 45)))
    limit = max(1, min(50, int(max_results or 15)))
    terms = query.strip() or "invoice OR receipt OR factuur OR bill"
    gmail_query = f"has:attachment newer_than:{window}d ({terms})"

    found = services.gmail_list(query=gmail_query, max_results=limit)
    rows: list[list[str]] = []
    preview: list[dict] = []
    for message in found.get("messages") or []:
        detail = services.gmail_read(message["id"])
        attachments = detail.get("attachments") or []
        if not attachments:
            continue
        currency, amount = _parse_amount(detail.get("subject", ""), detail.get("snippet", ""),
                                         (detail.get("body") or "")[:4000])
        for attachment in attachments[:3]:
            row = [
                (detail.get("received") or "")[:10],
                detail.get("from", ""),
                detail.get("subject", ""),
                amount,
                currency,
                attachment.get("filename", ""),
                detail.get("webUrl", ""),
            ]
            rows.append(row)
            preview.append({
                "date": row[0], "from": row[1], "subject": row[2],
                "amount": amount, "currency": currency, "file": row[5],
            })

    result: dict[str, Any] = {
        "query": gmail_query,
        "found": len(rows),
        "rows": preview,
        "columns": ["Date", "From", "Subject", "Amount", "Currency", "Attachment", "Link"],
        "created": False,
    }
    if not rows:
        result["note"] = "No messages with attachments matched. Nothing to add."
        return result
    if not confirm:
        result["next"] = "Call again with confirm=true to append these rows to Sheets."
        return result

    target = spreadsheet_id
    if not target:
        created = services.sheets_create("Invoices (Hermes)", "Invoices")
        target = created["id"]
        result["spreadsheet"] = created

    meta = services.sheets_meta(target)
    sheet_title = (meta.get("sheets") or [{}])[0].get("title", "Sheet1")
    existing = services.sheets_read(target, f"{sheet_title}!A1:G5000")
    values = existing.get("values") or []
    header_missing = not values
    # Running this twice must not write the same invoice twice. An invoice is already recorded
    # when a row in the sheet has the same message link and attachment name.
    recorded = {
        (str(row[6]) if len(row) > 6 else "", str(row[5]) if len(row) > 5 else "")
        for row in values[1:]
    }
    fresh = [row for row in rows if (row[6], row[5]) not in recorded]
    result["skipped"] = len(rows) - len(fresh)
    if not fresh:
        result["note"] = "Those invoices are already in the sheet. Nothing was added."
        return result

    payload_rows = ([result["columns"]] if header_missing else []) + fresh
    appended = services.sheets_append(target, payload_rows, f"{sheet_title}!A1")
    result["spreadsheet"] = result.get("spreadsheet") or {"id": target, "title": meta.get("title", "")}
    result["appended"] = appended
    result["created"] = True
    return result


# ── Drive organization ───────────────────────────────────────────────────────


def organize_drive(*, query: str, folder_name: str, confirm: bool = False,
                   max_files: int = 25, parent_folder_id: str = "") -> dict:
    if not str(query or "").strip():
        raise WorkspaceError("bad_request", "A search query is required so nothing is moved by accident.")
    if not str(folder_name or "").strip():
        raise WorkspaceError("bad_request", "A destination folder name is required.")
    limit = max(1, min(50, int(max_files or 25)))

    found = services.drive_search(query=query, max_results=limit)
    files = [f for f in found.get("files") or []
             if f.get("mimeType") != "application/vnd.google-apps.folder"]

    folder = services.drive_find_folder(folder_name.strip(), parent_folder_id)
    plan = {
        "query": query,
        "folder": folder or {"name": folder_name.strip(), "created": False},
        "folderExists": bool(folder),
        "files": [{"id": f["id"], "name": f["name"], "parents": f.get("parents") or []}
                  for f in files],
        "count": len(files),
        "moved": [],
        "created": False,
    }
    if not files:
        plan["note"] = "No files matched."
        return plan
    if not confirm:
        plan["next"] = "Call again with confirm=true to create the folder (if needed) and move these files."
        return plan

    if not folder:
        folder = services.drive_create_folder(folder_name.strip(), parent_folder_id)
        plan["folder"] = folder
        plan["folderCreated"] = True
    folder_id = folder["id"]
    plan["folderId"] = folder_id

    for file in files:
        if folder_id in (file.get("parents") or []):
            continue
        try:
            moved = services.drive_move(file["id"], add_parents=folder_id)
            plan["moved"].append({"id": moved["id"], "name": moved["name"], "webUrl": moved["webUrl"]})
        except WorkspaceError as exc:
            plan["moved"].append({"id": file["id"], "name": file["name"], "error": exc.message})
    plan["created"] = True
    return plan

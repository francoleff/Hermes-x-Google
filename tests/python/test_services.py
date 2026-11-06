"""Google service calls: request shape, local-time handling, Gmail writes and calendar checks."""

from __future__ import annotations

import base64
from datetime import datetime, timedelta
from email import message_from_bytes

import pytest
from fakes import FakeResponse

from hermes_google_workspace import services
from hermes_google_workspace.client import WorkspaceError

GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
CALENDAR_EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events"


def decoded_raw(body: dict):
    raw = body["raw"]
    return message_from_bytes(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))


# ── Time handling ────────────────────────────────────────────────────────────


def test_naive_datetime_is_read_in_the_host_zone(cet):
    parsed = services.parse_time("2026-11-07T10:00:00")
    assert parsed.hour == 10
    assert parsed.utcoffset() == timedelta(hours=1)


def test_explicit_offset_is_preserved(cet):
    assert services.parse_time("2026-11-07T10:00:00+02:00").utcoffset() == timedelta(hours=2)


def test_z_suffix_means_utc(cet):
    assert services.parse_time("2026-11-07T10:00:00Z").utcoffset() == timedelta(0)


def test_date_only_defaults_to_nine_in_the_host_zone(cet):
    parsed = services.parse_time("2026-11-07")
    assert (parsed.hour, parsed.utcoffset()) == (9, timedelta(hours=1))


def test_named_timezone_overrides_the_host_zone(cet):
    parsed = services.parse_time("2026-11-07T10:00:00", "Africa/Windhoek")
    assert parsed.utcoffset() == timedelta(hours=2)


def test_unknown_timezone_is_rejected(cet):
    with pytest.raises(WorkspaceError) as caught:
        services.parse_time("2026-11-07T10:00:00", "Mars/Olympus")
    assert caught.value.code == "bad_request"


def test_calendar_create_sends_the_local_offset_not_utc(google, cet):
    google.queue(
        FakeResponse(
            200,
            {
                "id": "evt1",
                "summary": "Sync",
                "start": {"dateTime": "2026-11-07T10:00:00+01:00"},
                "end": {"dateTime": "2026-11-07T10:30:00+01:00"},
            },
        )
    )
    services.calendar_create_event(summary="Sync", start="2026-11-07T10:00:00", duration_minutes=30)
    body = google.calls[0][2]
    assert body["start"] == {"dateTime": "2026-11-07T10:00:00+01:00"}
    assert body["end"] == {"dateTime": "2026-11-07T10:30:00+01:00"}


def test_calendar_create_notifies_attendees(google, cet):
    google.queue(
        FakeResponse(
            200,
            {
                "id": "e5",
                "summary": "Sync",
                "start": {"dateTime": "2026-11-12T10:00:00+01:00"},
                "end": {"dateTime": "2026-11-12T10:30:00+01:00"},
            },
        )
    )
    services.calendar_create_event(summary="Sync", start="2026-11-12T10:00:00", attendees=["ana@example.com"])
    assert "sendUpdates=all" in google.calls[0][1]
    assert google.calls[0][2]["attendees"] == [{"email": "ana@example.com"}]


# ── Calendar conflicts and availability ──────────────────────────────────────


def test_conflicts_list_overlapping_events_and_skip_cancelled(google, cet):
    start = datetime(2026, 11, 12, 15, 0, tzinfo=cet)
    google.queue(
        FakeResponse(
            200,
            {
                "items": [
                    {
                        "id": "e1",
                        "summary": "Board prep",
                        "status": "confirmed",
                        "start": {"dateTime": "2026-11-12T15:30:00+01:00"},
                        "end": {"dateTime": "2026-11-12T16:00:00+01:00"},
                    },
                    {
                        "id": "e2",
                        "summary": "Old",
                        "status": "cancelled",
                        "start": {"dateTime": "2026-11-12T15:10:00+01:00"},
                        "end": {"dateTime": "2026-11-12T15:20:00+01:00"},
                    },
                ]
            },
        )
    )
    conflicts = services.calendar_conflicts(start, start + timedelta(hours=1))
    assert [item["summary"] for item in conflicts] == ["Board prep"]
    url = google.calls[0][1]
    assert "singleEvents=true" in url
    assert "timeMin=2026-11-12T14%3A00%3A00Z" in url


def test_availability_is_free_when_nothing_overlaps(google, cet):
    google.queue(FakeResponse(200, {"items": []}))
    result = services.calendar_availability("2026-11-12T15:00:00", "2026-11-12T16:00:00")
    assert result["free"] is True
    assert result["conflicts"] == []


def test_availability_rejects_a_window_that_ends_before_it_starts(google, cet):
    with pytest.raises(WorkspaceError) as caught:
        services.calendar_availability("2026-11-12T16:00:00", "2026-11-12T15:00:00")
    assert caught.value.code == "bad_request"
    assert google.calls == []


# ── Gmail writes ─────────────────────────────────────────────────────────────


def test_gmail_send_posts_a_raw_message_into_the_thread(google):
    google.queue(FakeResponse(200, {"id": "sent1", "threadId": "t1", "labelIds": ["SENT"]}))
    result = services.gmail_send(to="ana@example.com", subject="Proposal", body="Hello", thread_id="t1")
    method, url, body = google.calls[0]
    assert method == "POST"
    assert url == f"{GMAIL}/messages/send"
    assert body["threadId"] == "t1"
    message = decoded_raw(body)
    assert message["To"] == "ana@example.com"
    assert message["Subject"] == "Proposal"
    assert result["id"] == "sent1"


def test_header_injection_in_a_subject_is_neutralised(google):
    google.queue(FakeResponse(200, {"id": "d1", "message": {"id": "m1"}}))
    services.gmail_draft(to="ana@example.com", subject="Hi\r\nBcc: evil@example.com", body="x")
    message = decoded_raw(google.calls[0][2]["message"])
    assert message["Bcc"] is None
    assert "\r" not in message["Subject"] and "\n" not in message["Subject"]


@pytest.mark.parametrize(
    "action,expected",
    [
        ("mark_read", {"removeLabelIds": ["UNREAD"]}),
        ("mark_unread", {"addLabelIds": ["UNREAD"]}),
        ("star", {"addLabelIds": ["STARRED"]}),
        ("unstar", {"removeLabelIds": ["STARRED"]}),
        ("archive", {"removeLabelIds": ["INBOX"]}),
    ],
)
def test_gmail_modify_maps_each_action_to_one_label_change(google, action, expected):
    google.queue(FakeResponse(200, {"id": "m1", "threadId": "t1", "labelIds": []}))
    services.gmail_modify("m1", action)
    method, url, body = google.calls[0]
    assert method == "POST"
    assert url.endswith("/messages/m1/modify")
    assert body == expected


def test_gmail_modify_reports_the_resulting_state(google):
    google.queue(FakeResponse(200, {"id": "m1", "threadId": "t1", "labelIds": ["UNREAD", "STARRED"]}))
    result = services.gmail_modify("m1", "star")
    assert result["unread"] is True
    assert result["starred"] is True
    assert result["inInbox"] is False


def test_gmail_modify_rejects_unknown_actions_before_calling_google(google):
    with pytest.raises(WorkspaceError) as caught:
        services.gmail_modify("m1", "delete")
    assert caught.value.code == "bad_request"
    assert google.calls == []


def test_gmail_body_prefers_plain_text_and_strips_html(google):
    html = base64.urlsafe_b64encode(b"<html><style>p{}</style><p>Hello <b>there</b></p></html>").decode()
    plain = base64.urlsafe_b64encode(b"Plain wins").decode()
    payload = {
        "mimeType": "multipart/alternative",
        "parts": [
            {"mimeType": "text/html", "body": {"data": html}},
            {"mimeType": "text/plain", "body": {"data": plain}},
        ],
    }
    assert services.extract_body(payload) == "Plain wins"
    html_only = {"mimeType": "text/html", "body": {"data": html}}
    assert services.extract_body(html_only) == "Hello there"


# ── Drive ────────────────────────────────────────────────────────────────────


def test_drive_search_escapes_quotes_in_the_query(google):
    google.queue(FakeResponse(200, {"files": []}))
    services.drive_search("O'Brien")
    assert "O%5C%27Brien" in google.calls[0][1]

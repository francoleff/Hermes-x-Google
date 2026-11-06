"""Write actions added after the first release: edit, cancel, respond, forward, rename, share.

Each test checks the exact request Google receives (method, URL, query and body), and the refusals
that stop a request from being sent at all. Nothing here touches the network.
"""

from __future__ import annotations

import base64
from email import message_from_bytes

import pytest
from fakes import FakeResponse, gmail_message

from hermes_google_workspace import client, services, tools
from hermes_google_workspace.client import WorkspaceError

DOCS = "https://docs.googleapis.com/v1/documents"
SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"
CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
PEOPLE = "https://people.googleapis.com/v1"
DRIVE = "https://www.googleapis.com/drive/v3/files"


def calendar_event(**overrides):
    base = {
        "id": "e1",
        "summary": "Board prep",
        "status": "confirmed",
        "start": {"dateTime": "2026-11-12T15:00:00+01:00"},
        "end": {"dateTime": "2026-11-12T16:00:00+01:00"},
        "attendees": [
            {"email": "me@example.com", "self": True, "responseStatus": "needsAction"},
            {"email": "ana@acme.test", "responseStatus": "accepted"},
        ],
    }
    base.update(overrides)
    return base


def person(**overrides):
    base = {
        "resourceName": "people/c9",
        "etag": "%ETAG-1",
        "names": [{"displayName": "Ana Lopez", "givenName": "Ana", "familyName": "Lopez"}],
        "emailAddresses": [{"value": "ana@acme.test"}],
        "organizations": [{"name": "Acme", "title": "Buyer"}],
    }
    base.update(overrides)
    return base


# ── Client: PUT and DELETE follow the same retry rules as other writes ─────────


def test_put_is_retried_only_when_rate_limited(google):
    google.queue(FakeResponse(429, {"error": {"message": "slow down"}}), FakeResponse(200, {"ok": True}))
    payload, _ = client.put("https://example.test/a", {"v": 1})
    assert payload == {"ok": True}
    assert google.methods() == ["PUT", "PUT"]


def test_put_is_not_retried_after_a_server_error(google):
    google.queue(FakeResponse(500, {"error": {"message": "boom"}}))
    with pytest.raises(WorkspaceError):
        client.put("https://example.test/a", {"v": 1})
    assert google.methods() == ["PUT"]


def test_delete_returns_nothing_on_no_content(google):
    google.queue(FakeResponse(204, None))
    payload, _ = client.delete("https://example.test/a")
    assert payload is None
    assert google.methods() == ["DELETE"]


# ── Docs: find and replace ───────────────────────────────────────────────────


def test_replace_text_sends_one_batch_update_and_counts_the_matches(google):
    google.queue(FakeResponse(200, {"replies": [{"replaceAllText": {"occurrencesChanged": 3}}]}))
    result = services.docs_replace_text("d1", "Q3", "Q4", match_case=False)
    method, url, body = google.calls[0]
    assert method == "POST"
    assert url == f"{DOCS}/d1:batchUpdate"
    assert body == {
        "requests": [{"replaceAllText": {"containsText": {"text": "Q3", "matchCase": False}, "replaceText": "Q4"}}]
    }
    assert result["occurrencesChanged"] == 3
    assert result["replaced"] is True


def test_replace_text_matches_case_by_default(google):
    google.queue(FakeResponse(200, {"replies": [{"replaceAllText": {"occurrencesChanged": 1}}]}))
    services.docs_replace_text("d1", "Acme", "ACME Corp")
    assert google.calls[0][2]["requests"][0]["replaceAllText"]["containsText"]["matchCase"] is True


def test_replace_text_with_no_matches_is_a_zero_not_an_error(google):
    google.queue(FakeResponse(200, {"replies": [{"replaceAllText": {}}]}))
    result = services.docs_replace_text("d1", "missing", "x")
    assert result["occurrencesChanged"] == 0
    assert result["replaced"] is False


@pytest.mark.parametrize("find", ["", "   "])
def test_replace_text_refuses_a_blank_search_before_any_request(google, find):
    with pytest.raises(WorkspaceError) as caught:
        services.docs_replace_text("d1", find, "x")
    assert caught.value.code == "bad_request"
    assert google.calls == []


# ── Sheets: update a range safely, add a tab ─────────────────────────────────


def test_update_range_refuses_to_overwrite_filled_cells_without_permission(google):
    google.queue(FakeResponse(200, {"range": "Budget!A1:B2", "values": [["Item", "Cost"], ["Rent", "900"]]}))
    with pytest.raises(WorkspaceError) as caught:
        services.sheets_update_range("s1", "Budget!A1:B2", [["x", "1"]])
    assert caught.value.code == "bad_request"
    assert "4 cell" in caught.value.message
    assert google.methods() == ["GET"]  # the read happened; no write was sent


def test_update_range_writes_into_an_empty_range(google):
    google.queue(
        FakeResponse(200, {"range": "Budget!A5:B5"}),
        FakeResponse(200, {"updatedRange": "Budget!A5:B5", "updatedCells": 2}),
    )
    result = services.sheets_update_range("s1", "Budget!A5:B5", [["Lunch", "12"]])
    method, url, body = google.calls[1]
    assert method == "PUT"
    assert url.startswith(f"{SHEETS}/s1/values/Budget%21A5%3AB5?")
    assert "valueInputOption=USER_ENTERED" in url
    assert body == {"values": [["Lunch", "12"]]}
    assert result["updatedCells"] == 2
    assert result["overwrote"] is False


def test_update_range_overwrites_only_when_asked(google):
    google.queue(FakeResponse(200, {"updatedCells": 1}))
    result = services.sheets_update_range("s1", "Sheet1!A1", [["new"]], overwrite=True)
    assert google.methods() == ["PUT"]  # an explicit overwrite skips the read
    assert result["overwrote"] is True


def test_update_range_refuses_too_many_cells_before_any_request(google):
    rows = [["x"] * 50 for _ in range(50)]  # 2,500 cells
    with pytest.raises(WorkspaceError):
        services.sheets_update_range("s1", "Sheet1!A1:AX50", rows, overwrite=True)
    assert google.calls == []


def test_create_tab_adds_a_trimmed_name(google):
    google.queue(FakeResponse(200, {"replies": [{"addSheet": {"properties": {"sheetId": 7, "title": "Q4"}}}]}))
    result = services.sheets_create_tab("s1", "  Q4  ")
    method, url, body = google.calls[0]
    assert (method, url) == ("POST", f"{SHEETS}/s1:batchUpdate")
    assert body == {"requests": [{"addSheet": {"properties": {"title": "Q4"}}}]}
    assert result["sheetId"] == 7
    assert result["created"] is True


def test_create_tab_refuses_a_blank_name(google):
    with pytest.raises(WorkspaceError):
        services.sheets_create_tab("s1", "   ")
    assert google.calls == []


# ── Calendar: reschedule, edit, cancel, respond ──────────────────────────────


def test_reschedule_keeps_the_event_length_and_sends_only_the_times(google, cet):
    google.queue(
        FakeResponse(200, calendar_event()),
        FakeResponse(200, calendar_event(
            start={"dateTime": "2026-11-13T09:00:00+01:00"},
            end={"dateTime": "2026-11-13T10:00:00+01:00"},
        )),
    )
    result = services.calendar_update_event("e1", start="2026-11-13T09:00", timezone_name="Europe/Amsterdam")
    method, url, body = google.calls[1]
    assert method == "PATCH"
    assert url.startswith(f"{CAL}/e1?") and "sendUpdates=all" in url
    assert body == {
        "start": {"dateTime": "2026-11-13T09:00:00+01:00", "timeZone": "Europe/Amsterdam"},
        "end": {"dateTime": "2026-11-13T10:00:00+01:00", "timeZone": "Europe/Amsterdam"},
    }
    assert result["id"] == "e1"


def test_adding_attendees_keeps_existing_guests_and_skips_duplicates(google, cet):
    google.queue(FakeResponse(200, calendar_event()), FakeResponse(200, calendar_event()))
    services.calendar_update_event("e1", add_attendees=["ana@acme.test", "bo@acme.test", "BO@acme.test"])
    attendees = google.calls[1][2]["attendees"]
    assert [a["email"] for a in attendees] == ["me@example.com", "ana@acme.test", "bo@acme.test"]
    assert attendees[1]["responseStatus"] == "accepted"


def test_update_refuses_an_empty_change_before_writing(google, cet):
    with pytest.raises(WorkspaceError):
        services.calendar_update_event("e1")
    assert google.calls == []


def test_update_refuses_to_move_an_all_day_event(google, cet):
    google.queue(FakeResponse(200, calendar_event(start={"date": "2026-11-12"}, end={"date": "2026-11-13"})))
    with pytest.raises(WorkspaceError) as caught:
        services.calendar_update_event("e1", start="2026-11-13T09:00", timezone_name="Europe/Amsterdam")
    assert "All-day" in caught.value.message
    assert google.methods() == ["GET"]


def test_update_refuses_an_end_before_the_start_without_reading_the_event(google, cet):
    with pytest.raises(WorkspaceError):
        services.calendar_update_event(
            "e1", start="2026-11-12T17:00", end="2026-11-12T16:00", timezone_name="Europe/Amsterdam"
        )
    assert google.calls == []


def test_cancel_deletes_the_event_and_reports_the_notification_setting(google):
    google.queue(FakeResponse(204, None))
    result = services.calendar_cancel_event("e1", send_updates="all")
    method, url, _ = google.calls[0]
    assert method == "DELETE"
    assert url == f"{CAL}/e1?sendUpdates=all"
    assert result == {"id": "e1", "cancelled": True, "sendUpdates": "all"}


def test_cancel_refuses_an_unknown_notification_setting(google):
    with pytest.raises(WorkspaceError):
        services.calendar_cancel_event("e1", send_updates="everyone")
    assert google.calls == []


def test_rsvp_changes_only_my_own_response(google):
    google.queue(FakeResponse(200, calendar_event()), FakeResponse(200, calendar_event()))
    result = services.calendar_rsvp("e1", "declined")
    method, url, body = google.calls[1]
    assert method == "PATCH"
    assert url.startswith(f"{CAL}/e1?")
    statuses = {a["email"]: a["responseStatus"] for a in body["attendees"]}
    assert statuses == {"me@example.com": "declined", "ana@acme.test": "accepted"}
    assert result["response"] == "declined"


def test_rsvp_refuses_an_event_i_am_not_invited_to(google):
    google.queue(FakeResponse(200, calendar_event(attendees=[{"email": "ana@acme.test", "responseStatus": "accepted"}])))
    with pytest.raises(WorkspaceError):
        services.calendar_rsvp("e1", "accepted")
    assert google.methods() == ["GET"]


def test_rsvp_refuses_an_unknown_response(google):
    with pytest.raises(WorkspaceError):
        services.calendar_rsvp("e1", "maybe")
    assert google.calls == []


# ── Gmail: edit a draft, forward ─────────────────────────────────────────────


def test_update_draft_replaces_the_whole_draft(google):
    google.queue(FakeResponse(200, {"id": "dr1", "message": {"id": "m9", "threadId": "t9"}}))
    result = services.gmail_update_draft("dr1", to="ana@acme.test", subject="Pricing v2", body="Updated numbers")
    method, url, body = google.calls[0]
    assert method == "PUT"
    assert url == f"{GMAIL}/drafts/dr1"
    assert set(body) == {"message"}
    assert "raw" in body["message"]
    assert result["draftId"] == "dr1"
    assert result["updated"] is True


def test_update_draft_refuses_without_a_recipient(google):
    with pytest.raises(WorkspaceError):
        services.gmail_update_draft("dr1", to="", subject="x", body="y")
    assert google.calls == []


def _sent_text(raw: str) -> tuple[str, str]:
    message = message_from_bytes(base64.urlsafe_b64decode(raw))
    return message["Subject"], message.get_payload(decode=True).decode("utf-8")


def test_forward_quotes_the_original_under_a_fwd_subject(google):
    google.queue(
        FakeResponse(200, gmail_message("m1", subject="Pricing", sender="Ana <ana@acme.test>",
                                        body="Here are the numbers.")),
        FakeResponse(200, {"id": "m2", "threadId": "t2", "labelIds": ["SENT"]}),
    )
    result = services.gmail_forward("m1", to="bo@acme.test", note="FYI")
    method, url, body = google.calls[1]
    assert (method, url) == ("POST", f"{GMAIL}/messages/send")
    assert set(body) == {"raw"}  # a forward starts its own thread
    subject, text = _sent_text(body["raw"])
    assert subject == "Fwd: Pricing"
    assert text.startswith("FYI")
    assert "---------- Forwarded message" in text
    assert "Here are the numbers." in text
    assert result == {"id": "m2", "threadId": "t2", "forwardedFrom": "m1",
                      "webUrl": "https://mail.google.com/mail/u/0/#all/m2"}


def test_forward_does_not_stack_the_fwd_prefix(google):
    google.queue(
        FakeResponse(200, gmail_message("m1", subject="Fwd: Pricing", sender="Ana <ana@acme.test>", body="x")),
        FakeResponse(200, {"id": "m2"}),
    )
    services.gmail_forward("m1", to="bo@acme.test")
    subject, _ = _sent_text(google.calls[1][2]["raw"])
    assert subject == "Fwd: Pricing"


def test_forward_refuses_a_missing_recipient_before_reading_the_message(google):
    with pytest.raises(WorkspaceError):
        services.gmail_forward("m1", to="")
    assert google.calls == []


# ── Contacts: update without losing data ─────────────────────────────────────


def test_contact_update_adds_an_email_and_keeps_the_existing_ones(google):
    google.queue(FakeResponse(200, person()), FakeResponse(200, person()))
    services.contacts_update("people/c9", email="a.lopez@home.test")
    get_method, get_url, _ = google.calls[0]
    assert get_method == "GET"
    assert get_url.startswith(f"{PEOPLE}/people/c9?")
    method, url, body = google.calls[1]
    assert method == "PATCH"
    assert url.startswith(f"{PEOPLE}/people/c9:updateContact?")
    assert "updatePersonFields=emailAddresses" in url
    assert body["etag"] == "%ETAG-1"
    assert [entry["value"] for entry in body["emailAddresses"]] == ["ana@acme.test", "a.lopez@home.test"]
    assert "names" not in body  # untouched fields are not sent


def test_contact_rename_sends_only_the_name(google):
    google.queue(FakeResponse(200, person()), FakeResponse(200, person()))
    services.contacts_update("people/c9", name="Anna Lopez")
    url, body = google.calls[1][1], google.calls[1][2]
    assert "updatePersonFields=names" in url
    assert body["names"][0] == {"givenName": "Anna", "familyName": "Lopez"}
    assert "emailAddresses" not in body


def test_contact_update_refuses_a_resource_that_is_not_a_person(google):
    with pytest.raises(WorkspaceError):
        services.contacts_update("calendar/abc", name="X")
    assert google.calls == []


def test_contact_update_refuses_when_nothing_new_would_change(google):
    google.queue(FakeResponse(200, person()))
    with pytest.raises(WorkspaceError):
        services.contacts_update("people/c9", email="ana@acme.test")
    assert google.methods() == ["GET"]


# ── Drive: rename and share ──────────────────────────────────────────────────


def test_rename_patches_only_the_name(google):
    google.queue(FakeResponse(200, {"id": "f1", "name": "Q4 plan", "mimeType": "application/vnd.google-apps.document"}))
    result = services.drive_rename("f1", "  Q4   plan ")
    method, url, body = google.calls[0]
    assert method == "PATCH"
    assert url.startswith(f"{DRIVE}/f1?")
    assert body == {"name": "Q4 plan"}
    assert result["name"] == "Q4 plan"
    assert result["renamed"] is True


def test_rename_refuses_a_blank_name(google):
    with pytest.raises(WorkspaceError):
        services.drive_rename("f1", "   ")
    assert google.calls == []


def test_share_grants_read_access_without_emailing_by_default(google):
    google.queue(FakeResponse(200, {"id": "perm1", "role": "reader"}))
    result = services.drive_share("f1", "ana@acme.test")
    method, url, body = google.calls[0]
    assert method == "POST"
    assert url.startswith(f"{DRIVE}/f1/permissions?")
    assert "sendNotificationEmail=false" in url
    assert body == {"type": "user", "role": "reader", "emailAddress": "ana@acme.test"}
    assert result["role"] == "reader"
    assert result["notified"] is False


def test_share_can_notify_and_grant_editing(google):
    google.queue(FakeResponse(200, {"id": "perm2", "role": "writer"}))
    services.drive_share("f1", "ana@acme.test", role="writer", notify=True)
    url, body = google.calls[0][1], google.calls[0][2]
    assert "sendNotificationEmail=true" in url
    assert body["role"] == "writer"


@pytest.mark.parametrize("role", ["owner", "organizer", "anyone", ""])
def test_share_refuses_roles_that_hand_over_or_open_the_file(google, role):
    with pytest.raises(WorkspaceError):
        services.drive_share("f1", "ana@acme.test", role=role)
    assert google.calls == []


def test_share_refuses_an_invalid_address(google):
    with pytest.raises(WorkspaceError):
        services.drive_share("f1", "not-an-email")
    assert google.calls == []


# ── Tool surface: envelopes and handler wiring for the new tools ─────────────


def test_tool_wrapper_turns_a_refusal_into_an_envelope_without_a_request(google):
    result = tools._wrap(tools._HANDLERS["google_calendar_cancel_event"])(
        {"event_id": "e1", "send_updates": "everyone"}
    )
    assert '"ok": false' in result
    assert '"bad_request"' in result
    assert google.calls == []


def test_docs_replace_tool_returns_the_match_count(google):
    google.queue(FakeResponse(200, {"replies": [{"replaceAllText": {"occurrencesChanged": 2}}]}))
    result = tools._wrap(tools._HANDLERS["google_docs_replace_text"])(
        {"document_id": "d1", "find": "Acme", "replace": "ACME"}
    )
    assert '"occurrencesChanged": 2' in result


def test_every_new_tool_has_an_emoji():
    for name in NEW_TOOLS:
        assert name in tools._EMOJI, name


NEW_TOOLS = {
    "google_docs_replace_text",
    "google_sheets_update_range",
    "google_sheets_create_tab",
    "google_sheets_metadata",
    "google_calendar_search",
    "google_calendar_update_event",
    "google_calendar_cancel_event",
    "google_calendar_rsvp",
    "google_gmail_update_draft",
    "google_gmail_forward",
    "google_contacts_update",
    "google_drive_get",
    "google_drive_rename",
    "google_drive_share",
}

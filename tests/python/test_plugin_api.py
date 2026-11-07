"""The dashboard REST API the desktop UI calls. Writes need explicit confirmation; errors map cleanly."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from fakes import FakeResponse, gmail_router

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
PREFIX = "/api/plugins/google-workspace"


def load_api():
    spec = importlib.util.spec_from_file_location(
        "gw_dashboard_api_under_test", ROOT / "dashboard" / "plugin_api.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def api_client(google):
    api = load_api()
    app = FastAPI()
    app.include_router(api.router, prefix=PREFIX)
    return TestClient(app), google


CONFIRM_REQUIRED = [
    ("/send", {"to": "a@example.com", "subject": "Hi", "body": "x"}),
    ("/event", {"summary": "Sync", "start": "2026-11-12T10:00:00+01:00"}),
    ("/docs", {"title": "Brief"}),
    ("/docs/d1/append", {"text": "more"}),
    ("/sheets", {"title": "Invoices"}),
    ("/sheets/s1/append", {"rows": [["a", "b"]]}),
    ("/invoices", {"query": "invoice"}),
    ("/organize", {"query": "pdf", "folder": "Archive"}),
    ("/brief/save", {"eventId": "ev1"}),
    ("/email-to-event", {"messageId": "m1"}),
    ("/contacts", {"name": "Ana Lopez", "email": "ana@example.com"}),
    ("/calendar/events/e1/update", {"summary": "Board prep"}),
    ("/calendar/events/e1/cancel", {}),
    ("/calendar/events/e1/rsvp", {"response": "accepted"}),
    ("/drive/files/f1/rename", {"name": "Plan"}),
    ("/drive/files/f1/trash", {}),
    ("/drive/files/f1/share", {"email": "ana@example.com"}),
    ("/docs/d1/replace", {"find": "Q3", "replace": "Q4"}),
    ("/sheets/s1/range", {"range": "Budget!A1", "rows": [["a"]]}),
    ("/sheets/s1/tabs", {"title": "Q4"}),
    ("/contacts/update", {"resourceName": "people/c1", "email": "bo@example.com"}),
]


@pytest.mark.parametrize("path,body", CONFIRM_REQUIRED)
def test_writes_refuse_without_explicit_confirm(api_client, path, body):
    client, google = api_client
    response = client.post(PREFIX + path, json=body)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "confirm_required"
    assert google.calls == []


def test_confirm_must_be_true_not_merely_present(api_client):
    client, google = api_client
    response = client.post(PREFIX + "/docs", json={"title": "x", "confirm": "no"})
    assert response.status_code == 400
    assert google.calls == []


def test_contact_create_route_writes_once_confirmed(api_client):
    client, google = api_client
    google.queue(
        FakeResponse(
            200,
            {
                "resourceName": "people/c42",
                "names": [{"displayName": "Ana Lopez"}],
                "emailAddresses": [{"value": "ana@example.com"}],
            },
        )
    )
    response = client.post(
        PREFIX + "/contacts",
        json={"name": "Ana Lopez", "email": "ana@example.com", "confirm": True},
    )
    assert response.status_code == 200
    assert response.json()["data"]["created"] is True
    assert google.methods() == ["POST"]


def test_contact_create_route_rejects_bad_input_before_writing(api_client):
    client, google = api_client
    response = client.post(
        PREFIX + "/contacts",
        json={"name": "Ana", "email": "not-an-email", "confirm": True},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "bad_request"
    assert google.calls == []


def test_status_is_disconnected_when_google_refuses_everything(api_client):
    client, google = api_client
    google.default = FakeResponse(401, {"error": {"message": "Invalid Credentials"}})
    data = client.get(PREFIX + "/status").json()["data"]
    assert data["connected"] is False
    assert data["account"] == ""
    assert all(row["state"] != "ready" for row in data["services"])
    assert data["setup"]["clientConfigured"] is False
    assert data["setup"]["signInCommand"] == "hermes auth add google-workspace:google"


def test_status_reports_the_account_once_gmail_answers(api_client):
    client, google = api_client
    google.router = gmail_router(profile_email="me@example.com")
    data = client.get(PREFIX + "/status").json()["data"]
    assert data["connected"] is True
    assert data["account"] == "me@example.com"
    gmail_row = next(row for row in data["services"] if row["id"] == "gmail")
    assert gmail_row["state"] == "ready"


def test_read_routes_map_missing_scope_to_403_with_a_fix(api_client):
    client, google = api_client
    google.default = FakeResponse(
        403,
        {
            "error": {
                "message": "Request had insufficient authentication scopes.",
                "errors": [{"reason": "insufficientPermissions"}],
            }
        },
    )
    response = client.get(PREFIX + "/gmail", params={"query": "is:unread"})
    assert response.status_code == 403
    detail = response.json()["detail"]
    assert detail["code"] == "scope_missing"
    assert "hermes auth" in detail["hint"]


def test_modify_route_changes_labels_without_a_confirmation_step(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"id": "m1", "threadId": "t1", "labelIds": ["STARRED"]}))
    response = client.post(PREFIX + "/gmail/m1/modify", json={"action": "star"})
    assert response.status_code == 200
    assert response.json()["data"]["starred"] is True
    assert google.calls[0][2] == {"addLabelIds": ["STARRED"]}


def test_modify_route_rejects_unknown_actions(api_client):
    client, google = api_client
    response = client.post(PREFIX + "/gmail/m1/modify", json={"action": "explode"})
    assert response.status_code == 400
    assert google.calls == []


def test_sheets_append_route_appends_once_confirmed(api_client):
    client, google = api_client
    google.queue(
        FakeResponse(
            200,
            {"updates": {"updatedRange": "Invoices!A5:C5", "updatedRows": 1, "updatedCells": 3}},
        )
    )
    response = client.post(
        PREFIX + "/sheets/s1/append",
        json={"range": "Invoices!A1", "rows": [["a", "b", "c"]], "confirm": True},
    )
    assert response.status_code == 200
    assert response.json()["data"]["updatedRows"] == 1
    assert google.calls[0][0] == "POST"


def test_sheets_append_defaults_to_the_first_tab_not_a_tab_named_sheet1(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"updates": {"updatedRange": "A4:A4", "updatedRows": 1, "updatedCells": 1}}))
    response = client.post(PREFIX + "/sheets/s1/append", json={"rows": [["x"]], "confirm": True})
    assert response.status_code == 200
    assert google.calls[0][1].endswith("/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS")


def test_availability_route_reports_a_conflict(api_client):
    client, google = api_client
    google.queue(
        FakeResponse(
            200,
            {
                "items": [
                    {
                        "id": "e1",
                        "summary": "Standup",
                        "status": "confirmed",
                        "start": {"dateTime": "2026-11-12T10:00:00+01:00"},
                        "end": {"dateTime": "2026-11-12T10:15:00+01:00"},
                    }
                ]
            },
        )
    )
    data = client.get(
        PREFIX + "/calendar/availability",
        params={"start": "2026-11-12T10:00:00+01:00", "end": "2026-11-12T11:00:00+01:00"},
    ).json()["data"]
    assert data["free"] is False
    assert data["conflicts"][0]["summary"] == "Standup"


# ── Changes to existing items: events, files, docs, sheets, contacts ─────────

EVENT_JSON = {
    "id": "e1",
    "summary": "Board prep",
    "start": {"dateTime": "2026-11-12T15:00:00+01:00"},
    "end": {"dateTime": "2026-11-12T16:00:00+01:00"},
    "attendees": [
        {"email": "me@example.com", "self": True, "responseStatus": "needsAction"},
        {"email": "ana@acme.test", "responseStatus": "accepted"},
    ],
}


def test_calendar_update_route_sends_only_the_fields_given(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {**EVENT_JSON, "summary": "Board prep v2"}))
    response = client.post(
        PREFIX + "/calendar/events/e1/update",
        json={"summary": "Board prep v2", "sendUpdates": "none", "confirm": True},
    )
    assert response.status_code == 200
    method, url, body = google.calls[0]
    assert method == "PATCH"
    assert body == {"summary": "Board prep v2"}
    assert "sendUpdates=none" in url
    assert response.json()["data"]["summary"] == "Board prep v2"


def test_calendar_update_route_maps_times_zone_and_guests(api_client, cet):
    client, google = api_client
    google.queue(FakeResponse(200, EVENT_JSON), FakeResponse(200, EVENT_JSON))
    response = client.post(
        PREFIX + "/calendar/events/e1/update",
        json={
            "start": "2026-11-13T09:00",
            "timezone": "Europe/Amsterdam",
            "addAttendees": "bo@acme.test, cy@acme.test",
            "confirm": True,
        },
    )
    assert response.status_code == 200
    assert [call[0] for call in google.calls] == ["GET", "PATCH"]
    body = google.calls[1][2]
    assert body["start"] == {"dateTime": "2026-11-13T09:00:00+01:00", "timeZone": "Europe/Amsterdam"}
    assert body["end"] == {"dateTime": "2026-11-13T10:00:00+01:00", "timeZone": "Europe/Amsterdam"}
    assert [a["email"] for a in body["attendees"]] == [
        "me@example.com", "ana@acme.test", "bo@acme.test", "cy@acme.test",
    ]


def test_calendar_cancel_route_sends_the_notification_setting(api_client):
    client, google = api_client
    google.queue(FakeResponse(204, None))
    response = client.post(PREFIX + "/calendar/events/e1/cancel", json={"sendUpdates": "none", "confirm": True})
    assert response.status_code == 200
    method, url, _ = google.calls[0]
    assert method == "DELETE"
    assert url.endswith("/events/e1?sendUpdates=none")
    assert response.json()["data"] == {"id": "e1", "cancelled": True, "sendUpdates": "none"}


def test_rsvp_route_changes_only_my_response(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, EVENT_JSON), FakeResponse(200, EVENT_JSON))
    response = client.post(PREFIX + "/calendar/events/e1/rsvp", json={"response": "declined", "confirm": True})
    assert response.status_code == 200
    assert [call[0] for call in google.calls] == ["GET", "PATCH"]
    statuses = {a["email"]: a["responseStatus"] for a in google.calls[1][2]["attendees"]}
    assert statuses == {"me@example.com": "declined", "ana@acme.test": "accepted"}
    assert response.json()["data"]["response"] == "declined"


def test_rsvp_route_refuses_an_unknown_response_before_reading(api_client):
    client, google = api_client
    response = client.post(PREFIX + "/calendar/events/e1/rsvp", json={"response": "maybe", "confirm": True})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "bad_request"
    assert google.calls == []


def test_drive_rename_route_returns_the_new_name(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"id": "f1", "name": "Plan v2", "mimeType": "application/pdf"}))
    response = client.post(PREFIX + "/drive/files/f1/rename", json={"name": "Plan v2", "confirm": True})
    assert response.status_code == 200
    assert google.calls[0][2] == {"name": "Plan v2"}
    assert response.json()["data"]["name"] == "Plan v2"


def test_drive_share_route_reads_notify_as_a_flag_not_a_string(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"id": "perm1", "role": "writer"}))
    response = client.post(
        PREFIX + "/drive/files/f1/share",
        json={"email": "ana@acme.test", "role": "writer", "notify": "false", "confirm": True},
    )
    assert response.status_code == 200
    assert "sendNotificationEmail=false" in google.calls[0][1]
    assert response.json()["data"]["notified"] is False


def test_docs_replace_route_reports_the_match_count(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"replies": [{"replaceAllText": {"occurrencesChanged": 2}}]}))
    response = client.post(
        PREFIX + "/docs/d1/replace",
        json={"find": "Q3", "replace": "Q4", "matchCase": False, "confirm": True},
    )
    assert response.status_code == 200
    assert google.calls[0][2]["requests"][0]["replaceAllText"]["containsText"]["matchCase"] is False
    assert response.json()["data"]["occurrencesChanged"] == 2


def test_sheets_range_route_refuses_filled_cells_until_overwrite(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"values": [["Rent"]]}))
    response = client.post(
        PREFIX + "/sheets/s1/range",
        json={"range": "Budget!A1", "rows": [["x"]], "confirm": True},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "bad_request"
    assert google.methods() == ["GET"]


def test_sheets_range_route_writes_when_overwrite_is_chosen(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"updatedRange": "Budget!A1", "updatedCells": 1}))
    response = client.post(
        PREFIX + "/sheets/s1/range",
        json={"range": "Budget!A1", "rows": [["x"]], "overwrite": True, "confirm": True},
    )
    assert response.status_code == 200
    assert google.methods() == ["PUT"]
    assert response.json()["data"]["overwrote"] is True


def test_sheets_tab_route_adds_the_tab(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"replies": [{"addSheet": {"properties": {"sheetId": 9, "title": "Q4"}}}]}))
    response = client.post(PREFIX + "/sheets/s1/tabs", json={"title": "Q4", "confirm": True})
    assert response.status_code == 200
    assert google.calls[0][2] == {"requests": [{"addSheet": {"properties": {"title": "Q4"}}}]}
    assert response.json()["data"]["sheetId"] == 9


def test_contact_update_route_keeps_existing_details(api_client):
    client, google = api_client
    person = {
        "resourceName": "people/c9",
        "etag": "%E-1",
        "names": [{"displayName": "Ana Lopez", "givenName": "Ana", "familyName": "Lopez"}],
        "emailAddresses": [{"value": "ana@acme.test"}],
    }
    google.queue(FakeResponse(200, person), FakeResponse(200, person))
    response = client.post(
        PREFIX + "/contacts/update",
        json={"resourceName": "people/c9", "email": "bo@acme.test", "confirm": True},
    )
    assert response.status_code == 200
    body = google.calls[1][2]
    assert [e["value"] for e in body["emailAddresses"]] == ["ana@acme.test", "bo@acme.test"]
    assert "names" not in body


def test_calendar_month_route_returns_the_month(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"items": []}))
    response = client.get(PREFIX + "/calendar/month", params={"month": "2026-11"})
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["month"] == "2026-11"
    assert data["count"] == 0


def test_calendar_month_route_rejects_a_bad_month(api_client):
    client, google = api_client
    response = client.get(PREFIX + "/calendar/month", params={"month": "2026-13"})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "bad_request"
    assert google.calls == []


def test_drive_trash_route_moves_the_file_to_the_trash(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {"id": "f1", "name": "Plan"}))
    response = client.post(PREFIX + "/drive/files/f1/trash", json={"confirm": True})
    assert response.status_code == 200
    assert response.json()["data"]["trashed"] is True
    assert google.methods() == ["PATCH"]


def test_contact_delete_route_removes_the_contact(api_client):
    client, google = api_client
    google.queue(FakeResponse(200, {}))
    response = client.post(
        PREFIX + "/contacts/delete",
        json={"resourceName": "people/c9", "confirm": True},
    )
    assert response.status_code == 200
    assert response.json()["data"]["deleted"] is True
    assert google.methods() == ["DELETE"]

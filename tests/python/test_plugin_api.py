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
    response = client.post(PREFIX + "/gmail/m1/modify", json={"action": "trash"})
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

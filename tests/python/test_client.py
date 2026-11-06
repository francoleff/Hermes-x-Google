"""The HTTP layer: envelopes, error mapping, retry policy, and the credentialed bridge."""

from __future__ import annotations

import json
import sys
import types

import httpx
import pytest
from fakes import FakeResponse

from hermes_google_workspace import client
from hermes_google_workspace.client import WorkspaceError

URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
GMAIL_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
DRIVE_FILE_URL = "https://www.googleapis.com/drive/v3/files/f1"

# Captured at import time, before any fixture swaps it out.
ORIGINAL_SEND = client._send


@pytest.fixture
def hermes_bridge(monkeypatch):
    """Stand-in for ``hermes_cli.plugin_provider_requests``, which only exists inside Hermes."""

    class ProviderNotSignedIn(RuntimeError):
        pass

    module = types.ModuleType("hermes_cli.plugin_provider_requests")
    module.ProviderNotSignedIn = ProviderNotSignedIn
    module.credentialed_provider_request = None
    package = types.ModuleType("hermes_cli")
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_provider_requests", module)
    return module


# ── Envelopes and query strings ──────────────────────────────────────────────


def test_ok_envelope_has_a_stable_shape():
    assert json.loads(client.ok({"a": 1})) == {"ok": True, "data": {"a": 1}}


def test_fail_envelope_never_leaks_a_traceback():
    payload = json.loads(client.fail(ValueError("boom")))
    assert payload["ok"] is False
    assert payload["error"]["code"] == "unexpected"
    assert "Traceback" not in json.dumps(payload)


def test_query_strings_skip_empty_values_and_repeat_lists():
    assert client.qs({"a": None, "b": "", "c": ["x", "y"], "d": True}) == "c=x&c=y&d=true"


# ── Request behaviour through the fake transport ─────────────────────────────


def test_get_returns_parsed_json(google):
    google.queue(FakeResponse(200, {"items": []}))
    payload, _headers = client.get(URL, {"maxResults": 5})
    assert payload == {"items": []}
    assert google.calls[0][1].endswith("maxResults=5")


def test_no_content_responses_return_none(google):
    google.queue(FakeResponse(204, None, text=""))
    payload, _headers = client.request("DELETE", URL)
    assert payload is None


def test_unauthorized_means_sign_in_again(google):
    google.queue(FakeResponse(401, {"error": {"message": "Invalid Credentials"}}))
    with pytest.raises(WorkspaceError) as caught:
        client.get(URL)
    assert caught.value.code == "not_connected"
    assert caught.value.hint == client.SIGN_IN_COMMAND


def test_insufficient_scopes_name_the_missing_permission(google):
    google.queue(
        FakeResponse(
            403,
            {
                "error": {
                    "message": "Request had insufficient authentication scopes.",
                    "errors": [{"reason": "insufficientPermissions"}],
                }
            },
        )
    )
    with pytest.raises(WorkspaceError) as caught:
        client.get(GMAIL_URL)
    assert caught.value.code == "scope_missing"
    assert "gmail" in caught.value.hint.lower()


def test_file_level_forbidden_is_not_reported_as_a_scope_problem(google):
    google.queue(
        FakeResponse(
            403,
            {
                "error": {
                    "message": "The user does not have sufficient permission for this file.",
                    "errors": [{"reason": "insufficientFilePermissions"}],
                }
            },
        )
    )
    with pytest.raises(WorkspaceError) as caught:
        client.get(DRIVE_FILE_URL)
    assert caught.value.code == "forbidden"


def test_rate_limits_are_retried_even_for_writes(google):
    google.queue(
        FakeResponse(429, {"error": {"message": "Rate Limit Exceeded"}}),
        FakeResponse(200, {"id": "d1"}),
    )
    payload, _headers = client.post(f"{GMAIL_URL}/drafts", {"message": {}})
    assert payload == {"id": "d1"}
    assert google.methods() == ["POST", "POST"]


def test_server_errors_are_not_retried_for_writes(google):
    google.queue(FakeResponse(500, {"error": {"message": "Backend Error"}}))
    with pytest.raises(WorkspaceError) as caught:
        client.post(f"{GMAIL_URL}/messages/send", {"raw": "x"})
    assert caught.value.code == "google_unavailable"
    assert google.methods() == ["POST"]


def test_server_errors_are_retried_for_reads(google):
    google.queue(
        FakeResponse(503, {"error": {"message": "Service Unavailable"}}),
        FakeResponse(200, {"ok": 1}),
    )
    payload, _headers = client.get(URL)
    assert payload == {"ok": 1}
    assert google.methods() == ["GET", "GET"]


def test_network_failures_are_retried_for_reads_only(google):
    network = WorkspaceError("network", "Could not reach Google.")
    google.queue(network, network, network)
    with pytest.raises(WorkspaceError) as caught:
        client.get(URL)
    assert caught.value.code == "network"
    assert google.methods() == ["GET", "GET", "GET"]


def test_network_failures_are_not_retried_for_writes(google):
    google.queue(WorkspaceError("network", "Could not reach Google."))
    with pytest.raises(WorkspaceError) as caught:
        client.post(f"{GMAIL_URL}/messages/send", {"raw": "x"})
    assert caught.value.code == "network"
    assert google.methods() == ["POST"]


# ── The real bridge (_send) with hermes_cli stubbed in ───────────────────────


def test_bridge_is_called_with_the_google_provider_only(hermes_bridge):
    seen = {}

    def fake_request(provider, method, url, *, json, timeout):
        seen.update(provider=provider, method=method, json=json, timeout=timeout)
        return FakeResponse(200, {"ok": True})

    hermes_bridge.credentialed_provider_request = fake_request
    response = ORIGINAL_SEND("POST", URL, {"a": 1}, 9)
    assert seen == {"provider": "google", "method": "POST", "json": {"a": 1}, "timeout": 9}
    assert response.status == 200


def test_transport_errors_from_the_bridge_become_network_errors(hermes_bridge):
    def unreachable(*args, **kwargs):
        raise httpx.ConnectError("connection refused")

    hermes_bridge.credentialed_provider_request = unreachable
    with pytest.raises(WorkspaceError) as caught:
        ORIGINAL_SEND("GET", URL, None, 5)
    assert caught.value.code == "network"


def test_missing_sign_in_becomes_not_connected(hermes_bridge):
    def not_signed_in(*args, **kwargs):
        raise hermes_bridge.ProviderNotSignedIn("no grant")

    hermes_bridge.credentialed_provider_request = not_signed_in
    with pytest.raises(WorkspaceError) as caught:
        ORIGINAL_SEND("GET", URL, None, 5)
    assert caught.value.code == "not_connected"
    assert caught.value.hint == client.SIGN_IN_COMMAND


def test_refused_origin_becomes_a_configuration_error(hermes_bridge):
    def refused(*args, **kwargs):
        raise PermissionError("Refusing to send the google sign-in elsewhere")

    hermes_bridge.credentialed_provider_request = refused
    with pytest.raises(WorkspaceError) as caught:
        ORIGINAL_SEND("GET", URL, None, 5)
    assert caught.value.code == "configuration"


def test_unexpected_bridge_errors_are_not_swallowed(hermes_bridge):
    def broken(*args, **kwargs):
        raise RuntimeError("bridge exploded")

    hermes_bridge.credentialed_provider_request = broken
    with pytest.raises(RuntimeError, match="bridge exploded"):
        ORIGINAL_SEND("GET", URL, None, 5)

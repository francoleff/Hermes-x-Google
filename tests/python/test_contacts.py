"""Contacts writes: creating a person through the People API, and the checks that guard it."""

from __future__ import annotations

import pytest
from fakes import FakeResponse

from hermes_google_workspace import services
from hermes_google_workspace.client import WorkspaceError

CREATE_URL = "https://people.googleapis.com/v1/people:createContact"


def created_person() -> dict:
    return {
        "resourceName": "people/c42",
        "names": [{"displayName": "Ana Lopez"}],
        "emailAddresses": [{"value": "ana@example.com"}],
        "phoneNumbers": [{"value": "+31 6 1234 5678"}],
        "organizations": [{"name": "Acme", "title": "CFO"}],
    }


def test_create_sends_a_split_name_and_every_field(google):
    google.queue(FakeResponse(200, created_person()))
    services.contacts_create(
        name="Ana Lopez",
        email="ana@example.com",
        phone="+31 6 1234 5678",
        organization="Acme",
        title="CFO",
    )
    method, url, body = google.calls[0]
    assert method == "POST"
    assert url.startswith(CREATE_URL)
    assert "personFields=" in url
    assert body == {
        "names": [{"givenName": "Ana", "familyName": "Lopez"}],
        "emailAddresses": [{"value": "ana@example.com"}],
        "phoneNumbers": [{"value": "+31 6 1234 5678"}],
        "organizations": [{"name": "Acme", "title": "CFO"}],
    }


def test_create_returns_a_summary_marked_as_created(google):
    google.queue(FakeResponse(200, created_person()))
    result = services.contacts_create(name="Ana Lopez", email="ana@example.com")
    assert result["resourceName"] == "people/c42"
    assert result["emails"] == ["ana@example.com"]
    assert result["created"] is True


def test_a_single_word_name_becomes_a_given_name_only(google):
    google.queue(FakeResponse(200, created_person()))
    services.contacts_create(name="Ana", phone="+31 6 1234 5678")
    body = google.calls[0][2]
    assert body["names"] == [{"givenName": "Ana"}]
    assert "emailAddresses" not in body


def test_a_phone_number_alone_is_enough(google):
    google.queue(FakeResponse(200, created_person()))
    services.contacts_create(name="Ana Lopez", phone="+31 6 1234 5678")
    assert google.calls[0][2]["phoneNumbers"] == [{"value": "+31 6 1234 5678"}]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"name": "   ", "email": "ana@example.com"},
        {"name": "Ana", "email": "", "phone": ""},
    ],
)
def test_incomplete_contacts_never_reach_google(google, kwargs):
    with pytest.raises(WorkspaceError) as caught:
        services.contacts_create(**kwargs)
    assert caught.value.code == "bad_request"
    assert google.calls == []


@pytest.mark.parametrize("email", ["ana.example.com", "ana@", "ana @example.com", "ana@localhost"])
def test_malformed_email_is_rejected_before_writing(google, email):
    with pytest.raises(WorkspaceError) as caught:
        services.contacts_create(name="Ana", email=email)
    assert caught.value.code == "bad_request"
    assert google.calls == []

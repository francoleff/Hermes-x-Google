"""The OAuth grant: exactly the scopes the features need, no more, and no less.

A missing write scope is only discovered when a user clicks a button, so the grant is pinned here.
Changing it must be a deliberate edit to this test as well as to plugin.yaml.
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
BASE = "https://www.googleapis.com/auth/"

EXPECTED_SCOPES = {
    BASE + "gmail.modify",  # read mail, mark read/unread, star, archive (labels). Covers readonly.
    BASE + "gmail.send",  # send mail after explicit approval
    BASE + "gmail.compose",  # create and update drafts
    BASE + "calendar.events",  # read agenda, create events, check conflicts
    BASE + "drive",  # search, move and organise files; drive.file would hide existing files
    BASE + "documents",  # read and write Google Docs
    BASE + "spreadsheets",  # read and write Google Sheets
    BASE + "contacts",  # read contacts and create them. There is no narrower write scope.
}


def granted_scopes() -> list[str]:
    manifest = yaml.safe_load((ROOT / "plugin.yaml").read_text(encoding="utf-8"))
    (google,) = [entry for entry in manifest["oauth"] if entry["id"] == "google"]
    return list(google["scopes"])


def test_the_grant_is_exactly_the_expected_scopes():
    assert set(granted_scopes()) == EXPECTED_SCOPES


def test_no_scope_is_requested_twice():
    scopes = granted_scopes()
    assert len(scopes) == len(set(scopes))


def test_the_broad_full_gmail_scope_is_never_requested():
    assert "https://mail.google.com/" not in granted_scopes()


def test_contacts_are_granted_with_write_access_because_creating_needs_it():
    scopes = granted_scopes()
    assert BASE + "contacts" in scopes
    assert BASE + "contacts.readonly" not in scopes

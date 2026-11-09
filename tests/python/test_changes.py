import json
import sys
import types
from unittest.mock import Mock

import pytest

from hermes_google_workspace import changes

DOCS_CREATE = json.dumps({"ok": True, "data": {
    "id": "d1", "title": "Meeting brief",
    "webUrl": "https://docs.google.com/document/d/d1/edit", "created": True,
}})
SHEETS_CREATE = json.dumps({"ok": True, "data": {
    "id": "s1", "title": "Invoices",
    "webUrl": "https://docs.google.com/spreadsheets/d/s1/edit", "created": True,
}})


@pytest.fixture(autouse=True)
def empty_buffer():
    """The buffer is module state; start and finish every test with it empty."""
    while changes.drain(limit=1000):
        pass
    yield
    while changes.drain(limit=1000):
        pass


def test_record_extracts_service_action_title_and_url():
    entry = changes.record("google_docs_create", DOCS_CREATE, session_id="sess", turn_id="turn")
    assert entry["service"] == "docs"
    assert entry["action"] == "Created document"
    assert entry["title"] == "Meeting brief"
    assert entry["url"] == "https://docs.google.com/document/d/d1/edit"
    assert entry["sessionId"] == "sess"
    assert entry["turnId"] == "turn"
    assert entry["id"] and entry["at"].endswith("Z")


def test_record_accepts_a_dict_result():
    entry = changes.record("google_docs_create", json.loads(DOCS_CREATE))
    assert entry["title"] == "Meeting brief"


def test_record_ignores_a_failed_call():
    failed = json.dumps({"ok": False, "error": {"code": "forbidden", "message": "no"}})
    assert changes.record("google_docs_create", failed) is None


def test_record_ignores_a_call_that_changed_nothing():
    assert changes.record("google_email_to_event", {"ok": True, "data": {"created": False}}) is None
    assert changes.record("google_docs_replace_text", {"ok": True, "data": {
        "find": "Q3", "occurrencesChanged": 0, "replaced": False,
    }}) is None
    assert changes.record("google_organize_drive", {"ok": True, "data": {
        "created": True, "moved": [], "folder": {"name": "Archive", "webUrl": "https://drive.google.com/drive/folders/f1"},
    }}) is None


def test_record_ignores_read_tools_and_unknown_names():
    assert changes.record("google_docs_read", {"ok": True, "data": {"id": "d1"}}) is None
    assert changes.record("terminal", {"ok": True, "data": {}}) is None


def test_drain_returns_then_clears():
    changes.record("google_docs_create", DOCS_CREATE)
    changes.record("google_sheets_create", SHEETS_CREATE)
    assert [entry["service"] for entry in changes.drain()] == ["docs", "sheets"]
    assert changes.drain() == []


def test_drain_is_capped():
    for _ in range(40):
        changes.record("google_docs_create", DOCS_CREATE)
    assert len(changes.drain(limit=5)) == 5


def test_record_is_safe_for_parallel_calls():
    import threading
    threads = [threading.Thread(target=changes.record, args=("google_docs_create", DOCS_CREATE))
               for _ in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(changes.drain()) == 20


@pytest.fixture
def bridge(monkeypatch):
    """Stand-in for hermes_cli.plugin_events, which only exists inside Hermes."""
    sent = []
    module = types.ModuleType("hermes_cli.plugin_events")
    module.broadcast_plugin_event = lambda plugin_id, event, payload=None: sent.append(
        (plugin_id, event, payload))
    package = types.ModuleType("hermes_cli")
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_events", module)
    return sent


def test_broadcast_pending_pushes_the_plugin_event(bridge):
    changes.record("google_docs_create", DOCS_CREATE)
    assert changes.broadcast_pending() == 1
    plugin_id, event, payload = bridge[0]
    assert plugin_id == "google-workspace"
    assert event == "turn.changes"
    assert payload["changes"][0]["title"] == "Meeting brief"
    assert changes.broadcast_pending() == 0
    assert len(bridge) == 1


# ── Spec table: titles from the call's arguments, result-dependent actions, no URL ──


def test_record_takes_the_title_from_the_call_arguments():
    sent = json.dumps({"ok": True, "data": {"id": "m1", "webUrl": "https://mail.google.com/mail/u/0/#all/m1"}})
    entry = changes.record("google_gmail_send", sent, args={"subject": "Hello"})
    assert (entry["service"], entry["action"], entry["title"]) == ("gmail", "Sent email", "Hello")
    assert changes.record("google_gmail_send", sent, args={})["title"] == "(no subject)"


def test_record_keeps_a_write_that_has_no_url():
    entry = changes.record("google_contacts_delete", {"ok": True, "data": {"deleted": True}},
                           args={"resource_name": "people/c1"})
    assert entry["url"] == ""
    assert entry["title"] == "people/c1"
    rsvp = changes.record("google_calendar_rsvp", {"ok": True, "data": {
        "summary": "Sync", "response": "tentative"}})
    assert (rsvp["action"], rsvp["url"]) == ("Replied Maybe", "")


def test_record_names_the_gmail_label_change_and_links_the_message():
    entry = changes.record("google_gmail_modify", {"ok": True, "data": {"id": "m9", "action": "archive"}})
    assert entry["action"] == "Archived"
    assert entry["url"] == "https://mail.google.com/mail/u/0/#all/m9"


def test_record_counts_rows_cells_and_matches_in_the_action():
    assert changes.record("google_sheets_append", {"ok": True, "data": {"updatedRows": 3, "range": "A1:C3"}})[
        "action"] == "Appended 3 rows"
    assert changes.record("google_sheets_update_range", {"ok": True, "data": {"updatedCells": 1}})[
        "action"] == "Updated 1 cell"
    assert changes.record("google_docs_replace_text", {"ok": True, "data": {
        "find": "Q3", "occurrencesChanged": 2, "replaced": True}})["action"] == "Replaced 2 matches"


def test_record_summarises_a_drive_organisation_and_falls_back_to_the_sheet_id():
    organised = changes.record("google_organize_drive", {"ok": True, "data": {
        "created": True, "moved": [{"id": "a"}, {"id": "b"}],
        "folder": {"name": "Archive", "webUrl": "https://drive.google.com/drive/folders/f1"}}})
    assert organised["title"] == "2 files → Archive"
    invoices = changes.record("google_invoices_to_sheet", {"ok": True, "data": {
        "created": True, "spreadsheet": {"id": "s7", "title": "Invoices"}}})
    assert invoices["url"] == "https://docs.google.com/spreadsheets/d/s7/edit"


def test_record_truncates_the_title_to_eighty_characters():
    entry = changes.record("google_docs_create", {"ok": True, "data": {"title": "x" * 200}})
    assert len(entry["title"]) == 80


def test_buffer_keeps_the_newest_two_hundred():
    for _ in range(250):
        changes.record("google_docs_create", DOCS_CREATE)
    assert len(changes.drain(limit=1000)) == 200


def test_broadcast_pending_swallows_a_failing_bridge(monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("no window")

    module = types.ModuleType("hermes_cli.plugin_events")
    module.broadcast_plugin_event = boom
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_events", module)
    changes.record("google_docs_create", DOCS_CREATE)
    assert changes.broadcast_pending() == 0


def test_broadcast_pending_outside_hermes_does_nothing_and_does_not_raise(monkeypatch):
    monkeypatch.setitem(sys.modules, "hermes_cli", None)
    changes.record("google_docs_create", DOCS_CREATE)
    assert changes.broadcast_pending() == 0


def test_organize_drive_ignores_moves_that_failed():
    failed = {"ok": True, "data": {"created": True, "moved": [{"id": "a", "name": "A", "error": "denied"}],
                                    "folder": {"name": "Archive", "webUrl": "https://drive.google.com/drive/folders/f1"}}}
    assert changes.record("google_organize_drive", failed) is None
    mixed = {"ok": True, "data": {"created": True, "moved": [{"id": "a", "name": "A", "error": "denied"}, {"id": "b", "name": "B"}],
                                   "folder": {"name": "Archive", "webUrl": "https://drive.google.com/drive/folders/f1"}}}
    assert changes.record("google_organize_drive", mixed)["title"] == "1 file → Archive"


def test_entry_ids_differ_across_a_backend_restart(monkeypatch):
    first = changes.record("google_docs_create", DOCS_CREATE)["id"]
    monkeypatch.setattr(changes, "_counter", __import__("itertools").count(1))
    monkeypatch.setattr(changes, "_RUN", "other-run")
    second = changes.record("google_docs_create", DOCS_CREATE)["id"]
    assert first != second

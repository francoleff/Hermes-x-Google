"""The approval gate. Every consequential write must ask; reads and reversible actions must not."""

from __future__ import annotations

import pytest

from hermes_google_workspace import hooks, tools

# Writes that notify someone, create or change content, or move things. Always ask.
APPROVE_ALWAYS = {
    "google_gmail_send",
    "google_calendar_create_event",
    "google_docs_create",
    "google_docs_append",
    "google_sheets_create",
    "google_sheets_append",
    "google_drive_create_folder",
    "google_drive_move",
    "google_contacts_create",
}

# Writes that only ask when the caller opts in with a confirm-style flag.
APPROVE_WHEN_CONFIRMED = {
    "google_email_to_event": "confirm",
    "google_invoices_to_sheet": "confirm",
    "google_organize_drive": "confirm",
}

# Reads, drafts and reversible non-notifying changes run without a prompt.
NO_APPROVAL = {
    "google_search",
    "google_gmail_search",
    "google_gmail_read",
    "google_gmail_draft",
    "google_gmail_modify",
    "google_calendar_agenda",
    "google_calendar_check_availability",
    "google_drive_search",
    "google_docs_read",
    "google_sheets_read",
    "google_contacts_search",
}

SAMPLE_ARGS = {
    "google_gmail_send": {"to": "a@example.com", "subject": "Hi", "body": "secret body text"},
    "google_calendar_create_event": {
        "summary": "Sync",
        "start": "2026-11-12T10:00:00+01:00",
        "attendees": ["a@example.com"],
    },
    "google_docs_create": {"title": "Brief"},
    "google_docs_append": {"document_id": "d1", "text": "t"},
    "google_sheets_create": {"title": "Invoices"},
    "google_sheets_append": {"spreadsheet_id": "s1", "rows": [["a"]]},
    "google_drive_create_folder": {"name": "Projects"},
    "google_drive_move": {"file_id": "f1", "add_parents": "p1"},
    "google_contacts_create": {"name": "Ana Lopez", "email": "ana@example.com"},
}


@pytest.mark.parametrize("tool", sorted(APPROVE_ALWAYS))
def test_consequential_write_asks_for_approval(tool):
    result = hooks.pre_tool_call(tool_name=tool, args=SAMPLE_ARGS[tool])
    assert result is not None and result["action"] == "approve"
    assert result["message"].startswith("Google Workspace wants to ")


@pytest.mark.parametrize("tool", sorted(NO_APPROVAL))
def test_reads_and_reversible_actions_run_without_a_prompt(tool):
    assert hooks.pre_tool_call(tool_name=tool, args={}) is None


@pytest.mark.parametrize("tool,flag", sorted(APPROVE_WHEN_CONFIRMED.items()))
def test_conditional_writes_ask_only_when_confirmed(tool, flag):
    assert hooks.pre_tool_call(tool_name=tool, args={flag: False}) is None
    assert hooks.pre_tool_call(tool_name=tool, args={flag: "true"})["action"] == "approve"


def test_meeting_brief_asks_only_when_saving_to_docs():
    assert hooks.pre_tool_call(tool_name="google_meeting_brief", args={"query": "x"}) is None
    saving = hooks.pre_tool_call(tool_name="google_meeting_brief", args={"query": "x", "save_to_docs": True})
    assert saving["action"] == "approve"


def test_approval_message_names_recipients_and_never_quotes_the_body():
    result = hooks.pre_tool_call(
        tool_name="google_gmail_send",
        args={"to": "a@example.com, c@example.com", "subject": "Q4", "body": "secret body text"},
    )
    assert "2 recipients" in result["message"]
    assert "Q4" in result["message"]
    assert "secret body text" not in result["message"]


def test_other_tools_are_left_alone():
    assert hooks.pre_tool_call(tool_name="terminal", args={"command": "ls"}) is None
    assert hooks.pre_tool_call(tool_name="", args={}) is None


def test_every_registered_tool_is_classified_for_approval():
    classified = (
        APPROVE_ALWAYS
        | set(APPROVE_WHEN_CONFIRMED)
        | {"google_meeting_brief"}
        | NO_APPROVAL
    )
    assert {schema["name"] for schema in tools.SCHEMAS} == classified


def test_hook_registration_uses_the_pre_tool_call_hook():
    class Ctx:
        def __init__(self) -> None:
            self.names: list[str] = []

        def register_hook(self, name, callback):
            self.names.append(name)

    ctx = Ctx()
    hooks.register(ctx)
    assert ctx.names == ["pre_tool_call"]

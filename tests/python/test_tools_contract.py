"""The tool surface Hermes sees: names, schemas, registration, and the manifest declaration."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import yaml

from hermes_google_workspace import hooks, tools

ROOT = Path(__file__).resolve().parents[2]

EXPECTED_TOOLS = {
    "google_search",
    "google_gmail_search",
    "google_gmail_read",
    "google_gmail_send",
    "google_gmail_draft",
    "google_gmail_modify",
    "google_calendar_agenda",
    "google_calendar_create_event",
    "google_calendar_check_availability",
    "google_drive_search",
    "google_drive_create_folder",
    "google_drive_move",
    "google_docs_read",
    "google_docs_create",
    "google_docs_append",
    "google_sheets_read",
    "google_sheets_create",
    "google_sheets_append",
    "google_contacts_search",
    "google_contacts_create",
    "google_meeting_brief",
    "google_email_to_event",
    "google_invoices_to_sheet",
    "google_organize_drive",
}


class RecordingContext:
    """Records what ``register(ctx)`` asks for, the way the Hermes loader would."""

    def __init__(self) -> None:
        self.tools: dict[str, dict] = {}
        self.hooks: dict[str, list] = {}

    def register_tool(self, *, name, toolset, schema, handler, description="", emoji="", **kwargs):
        self.tools[name] = {
            "toolset": toolset,
            "schema": schema,
            "handler": handler,
            "description": description,
            "emoji": emoji,
        }

    def register_hook(self, hook_name, callback, **kwargs):
        self.hooks.setdefault(hook_name, []).append(callback)


def load_plugin_package():
    """Import the root ``__init__.py`` as the loader does, so its relative imports resolve."""
    name = "gw_plugin_under_test"
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_registered_tools_match_the_expected_surface():
    ctx = RecordingContext()
    tools.register(ctx)
    assert set(ctx.tools) == EXPECTED_TOOLS


def test_every_tool_uses_the_google_workspace_toolset():
    ctx = RecordingContext()
    tools.register(ctx)
    assert {entry["toolset"] for entry in ctx.tools.values()} == {"google_workspace"}


def test_schemas_are_strict_object_schemas_with_descriptions():
    for schema in tools.SCHEMAS:
        assert schema["name"] in EXPECTED_TOOLS
        assert schema["description"].strip(), schema["name"]
        params = schema["parameters"]
        assert params["type"] == "object"
        assert params["additionalProperties"] is False
        assert set(params["required"]) <= set(params["properties"]), schema["name"]


def test_every_schema_has_a_handler():
    assert set(tools._HANDLERS) == {schema["name"] for schema in tools.SCHEMAS}


def test_gmail_modify_only_offers_reversible_actions():
    schema = next(s for s in tools.SCHEMAS if s["name"] == "google_gmail_modify")
    assert set(schema["parameters"]["properties"]["action"]["enum"]) == {
        "mark_read",
        "mark_unread",
        "star",
        "unstar",
        "archive",
    }


def test_wrapper_returns_a_json_envelope_for_bad_input():
    result = json.loads(tools._wrap(tools._h_gmail_read)({}))
    assert result["ok"] is False
    assert result["error"]["code"] == "bad_request"


def test_manifest_declares_exactly_the_registered_tools_and_hooks():
    manifest = yaml.safe_load((ROOT / "plugin.yaml").read_text(encoding="utf-8"))
    assert set(manifest["provides_tools"]) == EXPECTED_TOOLS
    assert manifest["provides_hooks"] == ["pre_tool_call"]


def test_root_register_wires_every_tool_and_the_approval_hook():
    plugin = load_plugin_package()
    ctx = RecordingContext()
    plugin.register(ctx)
    assert set(ctx.tools) == EXPECTED_TOOLS
    assert list(ctx.hooks) == ["pre_tool_call"]

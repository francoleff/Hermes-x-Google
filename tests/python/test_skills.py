"""The plugin ships skills; each must be registered with a name and a "Use when" description."""

from __future__ import annotations

from pathlib import Path

from test_tools_contract import RecordingContext, load_plugin_package

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_SKILLS = {"email", "calendar", "drive-docs-sheets", "workflows"}


def test_register_adds_every_skill_with_a_description():
    ctx = RecordingContext()
    load_plugin_package().register(ctx)
    assert set(ctx.skills) == EXPECTED_SKILLS
    for name, entry in ctx.skills.items():
        assert isinstance(entry["path"], Path) and entry["path"].is_file(), name
        assert entry["description"].startswith("Use when"), name


def test_skill_frontmatter_name_matches_directory():
    found = {p.parent.name for p in (ROOT / "skills").glob("*/SKILL.md")}
    assert found == EXPECTED_SKILLS
    for name in found:
        head = (ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8").split("---")[1]
        assert f"name: {name}\n" in head

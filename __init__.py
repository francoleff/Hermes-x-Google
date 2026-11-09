"""Google Workspace for Hermes.

The agent half of a unified package: tools registered against the Hermes tool
registry, an approval hook for consequential writes, and a thin REST layer that
reaches Google through Hermes's own OAuth grant.

See ``plugin.yaml`` for the ``oauth:`` declaration and ``README.md`` for setup.
"""

from __future__ import annotations

from pathlib import Path

from .hermes_google_workspace import hooks, tools

SKILLS_DIR = Path(__file__).resolve().parent / "skills"


def _description(skill_md: Path) -> str:
    """Read the flat ``description:`` scalar from a SKILL.md frontmatter block."""
    for line in skill_md.read_text(encoding="utf-8").splitlines()[1:]:
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if sep and key.strip() == "description":
            return value.strip().strip("\"'")
    return ""


def register(ctx) -> None:
    """Called once by the Hermes plugin loader."""
    tools.register(ctx)
    hooks.register(ctx)
    for skill_md in sorted(SKILLS_DIR.glob("*/SKILL.md")):
        ctx.register_skill(skill_md.parent.name, skill_md, description=_description(skill_md))


__all__ = ["register"]

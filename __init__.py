"""Google Workspace for Hermes.

The agent half of a unified package: tools registered against the Hermes tool
registry, an approval hook for consequential writes, and a thin REST layer that
reaches Google through Hermes's own OAuth grant.

See ``plugin.yaml`` for the ``oauth:`` declaration and ``README.md`` for setup.
"""

from __future__ import annotations

from .hermes_google_workspace import hooks, tools


def register(ctx) -> None:
    """Called once by the Hermes plugin loader."""
    tools.register(ctx)
    hooks.register(ctx)


__all__ = ["register"]

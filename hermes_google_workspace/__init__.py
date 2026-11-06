"""Workspace internals, importable both as a plugin subpackage and by the dashboard.

The plugin loader imports this package as ``hermes_plugins.<slug>.hermes_google_workspace``;
``dashboard/plugin_api.py`` is loaded standalone, so it adds the plugin root to
``sys.path`` and imports ``hermes_google_workspace`` directly. Every module here is
stateless apart from short-lived read caches, so the two import paths never disagree.
"""

from __future__ import annotations

__all__ = ["client", "services", "workflows", "tools", "hooks"]

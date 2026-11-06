"""Shared fixtures. Every test runs without network access or a Hermes sign-in."""

from __future__ import annotations

import sys
import time
import types
from datetime import timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TESTS = Path(__file__).resolve().parent
for _path in (ROOT, TESTS):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from fakes import FakeGoogle  # noqa: E402
from hermes_google_workspace import client  # noqa: E402

CET = timezone(timedelta(hours=1), "CET")


@pytest.fixture
def google(monkeypatch):
    """Route every Google request through a scripted fake instead of the network."""
    fake = FakeGoogle()
    monkeypatch.setattr(client, "_send", fake)
    monkeypatch.setattr(client, "time", types.SimpleNamespace(sleep=lambda _seconds: None))
    return fake


@pytest.fixture
def cet(monkeypatch):
    """Pin the host to Europe/Amsterdam so local-time behaviour is the same on every machine.

    The host's own daylight-saving rules are then what the code under test relies on, exactly as
    in production. ``CET`` is the fixed offset the expected values are written against (November).
    """
    monkeypatch.setenv("TZ", "Europe/Amsterdam")
    time.tzset()
    yield CET
    monkeypatch.undo()
    time.tzset()

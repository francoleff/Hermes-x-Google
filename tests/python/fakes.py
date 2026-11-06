"""Scripted stand-ins for Google's HTTP responses. Nothing here touches the network.

``FakeGoogle`` replaces ``client._send``, the single function that hands a request to Hermes's
credentialed request helper. Replacing it exercises the real retry, error-mapping and envelope
code without a sign-in.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import Any, Callable

Responder = Callable[[str, str, Any], Any]


class FakeResponse:
    """The attributes of ``hermes_cli.plugin_provider_requests.ProviderResponse`` the plugin reads."""

    def __init__(
        self,
        status: int = 200,
        payload: Any = None,
        *,
        text: str | None = None,
        headers: dict | None = None,
    ) -> None:
        self.status = status
        self._payload = payload
        if text is None:
            text = "" if payload is None else json.dumps(payload)
        self.text = text
        self.body = text.encode("utf-8")
        self.headers = headers or {}

    def json(self) -> Any:
        if self._payload is None:
            raise ValueError("no JSON body")
        return self._payload


class FakeGoogle:
    """Answers from a queue first, then from ``router``, then from ``default``.

    Any request that matches none of these fails the test loudly, so tests cannot pass by
    accident through an unexpected call.
    """

    def __init__(self) -> None:
        self._items: list[Any] = []
        self.router: Responder | None = None
        self.default: Any = None
        self.calls: list[tuple[str, str, Any]] = []

    def queue(self, *items: Any) -> None:
        """Answer the next requests in order with these responses or exceptions."""
        self._items.extend(items)

    def __call__(self, method: str, url: str, body: Any, timeout: float = 0) -> Any:
        self.calls.append((method, url, body))
        if self._items:
            item = self._items.pop(0)
        elif self.router is not None:
            item = self.router(method, url, body)
        elif self.default is not None:
            item = self.default
        else:
            raise AssertionError(f"Unexpected Google request: {method} {url}")
        if isinstance(item, BaseException):
            raise item
        return item

    def methods(self) -> list[str]:
        return [method for method, _, _ in self.calls]


def b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii")


DEFAULT_RECEIVED = int(datetime(2026, 11, 6, 9, 0, tzinfo=timezone.utc).timestamp() * 1000)


def gmail_message(
    message_id: str,
    *,
    subject: str,
    sender: str,
    body: str = "",
    attachment: str = "",
    internal_date_ms: int = DEFAULT_RECEIVED,
) -> dict:
    """A Gmail API ``users.messages.get`` payload (format=full shape)."""
    parts: list[dict] = [{"mimeType": "text/plain", "body": {"data": b64(body)}}]
    if attachment:
        parts.append(
            {
                "filename": attachment,
                "mimeType": "application/pdf",
                "body": {"size": 2048, "attachmentId": f"att-{message_id}"},
            }
        )
    return {
        "id": message_id,
        "threadId": f"thread-{message_id}",
        "labelIds": ["INBOX", "UNREAD"],
        "snippet": body[:60],
        "internalDate": str(internal_date_ms),
        "payload": {
            "mimeType": "multipart/mixed",
            "headers": [
                {"name": "Subject", "value": subject},
                {"name": "From", "value": sender},
                {"name": "To", "value": "me@example.com"},
                {"name": "Date", "value": "Fri, 6 Nov 2026 10:00:00 +0100"},
                {"name": "Message-ID", "value": f"<{message_id}@mail.example.test>"},
            ],
            "parts": parts,
        },
    }


def gmail_router(*messages: dict, profile_email: str = "me@example.com") -> Responder:
    """Read-only Gmail: profile, message listing, and message gets. Anything else is {}."""
    by_id = {message["id"]: message for message in messages}

    def route(method: str, url: str, body: Any) -> Any:
        if method != "GET":
            return FakeResponse(405, {"error": {"message": "read-only test router"}})
        if "/gmail/v1/users/me/profile" in url:
            return FakeResponse(200, {"emailAddress": profile_email})
        if "/gmail/v1/users/me/messages?" in url or url.endswith("/gmail/v1/users/me/messages"):
            listing = [{"id": m["id"], "threadId": m["threadId"]} for m in messages]
            return FakeResponse(200, {"messages": listing})
        for message_id, payload in by_id.items():
            if f"/messages/{message_id}?" in url or url.endswith(f"/messages/{message_id}"):
                return FakeResponse(200, payload)
        return FakeResponse(200, {})

    return route

"""HTTP access to Google APIs through Hermes's OAuth grant.

Hermes owns the credential: ``credentialed_provider_request`` attaches the bearer
itself and returns only the response, so no token ever enters this process's
plugin code. This module adds the parts that helper deliberately leaves out --
query-string building, retries, Google error normalization, and the JSON envelope
every tool returns.

Nothing here names an OAuth endpoint: refresh belongs to Hermes.
"""

from __future__ import annotations

import json
import random
import time
from typing import Any, Iterable, Mapping, Optional

API_ROOT = "https://www.googleapis.com"
GMAIL_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me"
CALENDAR_ROOT = "https://www.googleapis.com/calendar/v3"
DRIVE_ROOT = "https://www.googleapis.com/drive/v3"
DOCS_ROOT = "https://docs.googleapis.com/v1"
SHEETS_ROOT = "https://sheets.googleapis.com/v4/spreadsheets"
PEOPLE_ROOT = "https://people.googleapis.com/v1"

PROVIDER = "google"
SIGN_IN_COMMAND = "hermes auth add google-workspace:google"

# 429 is safe to retry for every method: Google rejected the request before doing
# work. 5xx is only retried for reads -- a send or an insert that timed out may
# already have happened, and duplicating it is worse than reporting the failure.
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_MAX_ATTEMPTS = 3


class WorkspaceError(Exception):
    """A failure the caller can explain to a person.

    ``code`` is stable and machine-readable; ``message`` is Google's own text or
    ours; ``hint`` is the next action (usually a command to run).
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: Optional[int] = None,
        hint: str = "",
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.hint = hint
        self.details = details

    def as_dict(self) -> dict:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.status is not None:
            payload["status"] = self.status
        if self.hint:
            payload["hint"] = self.hint
        if self.details:
            payload["details"] = self.details
        return payload


# ── Envelopes ─────────────────────────────────────────────────────────────────


def ok(data: Any = None, **meta: Any) -> str:
    """The success envelope every tool handler returns."""
    payload: dict[str, Any] = {"ok": True, "data": data}
    payload.update({k: v for k, v in meta.items() if v is not None})
    return json.dumps(payload, ensure_ascii=False, default=str)


def fail(error: BaseException | WorkspaceError, **meta: Any) -> str:
    """The failure envelope. Handlers return this instead of raising."""
    if isinstance(error, WorkspaceError):
        payload: dict[str, Any] = {"ok": False, "error": error.as_dict()}
    else:  # never leak a traceback or an unexpected exception type to the model
        payload = {
            "ok": False,
            "error": {"code": "unexpected", "message": f"{type(error).__name__}: {error}"},
        }
    payload.update({k: v for k, v in meta.items() if v is not None})
    return json.dumps(payload, ensure_ascii=False, default=str)


# ── Query strings ────────────────────────────────────────────────────────────


def qs(params: Optional[Mapping[str, Any]]) -> str:
    """Encode query params, skipping ``None`` and expanding lists/repeats."""
    if not params:
        return ""
    parts: list[str] = []
    for key, value in params.items():
        if value is None or value == "":
            continue
        values: Iterable[Any] = value if isinstance(value, (list, tuple)) else (value,)
        for item in values:
            if item is None:
                continue
            if isinstance(item, bool):
                item = "true" if item else "false"
            parts.append(f"{key}={_quote(str(item))}")
    return "&".join(parts)


def with_query(url: str, params: Optional[Mapping[str, Any]]) -> str:
    query = qs(params)
    if not query:
        return url
    return f"{url}{'&' if '?' in url else '?'}{query}"


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


# ── Errors ───────────────────────────────────────────────────────────────────


def _scope_hint(url: str) -> str:
    if "gmail.googleapis.com" in url:
        return "Gmail needs gmail.readonly, gmail.send or gmail.compose."
    if "calendar" in url:
        return "Calendar needs the calendar.events permission."
    if "docs.googleapis.com" in url:
        return "Docs needs the documents permission."
    if "sheets.googleapis.com" in url:
        return "Sheets needs the spreadsheets permission."
    if "people.googleapis.com" in url:
        return "Contacts needs the contacts.readonly permission."
    if "drive" in url or "www.googleapis.com" in url:
        return "Drive needs the drive permission."
    return ""


def _google_reason(payload: Any) -> tuple[str, str]:
    """Pull (message, reason) out of Google's error body; tolerant of odd shapes."""
    if not isinstance(payload, dict):
        return "", ""
    error = payload.get("error")
    if isinstance(error, str):
        return error, ""
    if not isinstance(error, dict):
        return "", ""
    message = str(error.get("message") or "").strip()
    reason = ""
    errors = error.get("errors")
    if isinstance(errors, list) and errors and isinstance(errors[0], dict):
        reason = str(errors[0].get("reason") or "")
    if not reason:
        reason = str(error.get("status") or "")
    return message, reason


_SCOPE_REASONS = frozenset({"insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"})


def _is_scope_failure(reason: str, lowered: str) -> bool:
    """True when the grant lacks a scope, as opposed to the user lacking access to one item."""
    return (
        reason in _SCOPE_REASONS
        or "insufficient authentication scopes" in lowered
        or "access_token_scope_insufficient" in lowered
    )


def _raise_http(status: int, payload: Any, text: str, url: str) -> None:
    message, reason = _google_reason(payload)
    if not message:
        message = (text or "").strip()[:400] or f"Google returned HTTP {status}."
    lowered = f"{message} {reason}".lower()

    if status == 401:
        raise WorkspaceError(
            "not_connected",
            "Google rejected the stored sign-in. Sign in again from a terminal.",
            status=status,
            hint=SIGN_IN_COMMAND,
        )
    if status == 403 and _is_scope_failure(reason, lowered):
        scope = _scope_hint(url)
        raise WorkspaceError(
            "scope_missing",
            f"Google refused this call: {message}",
            status=status,
            hint=(
                "The grant is missing a permission. Run `hermes auth logout google-workspace:google`, "
                "then `hermes auth add google-workspace:google` and approve every requested scope. "
                + scope
            ).strip(),
        )
    if status == 403:
        raise WorkspaceError(
            "forbidden",
            message,
            status=status,
            hint="The signed-in account may not have access to this item.",
        )
    if status == 404:
        raise WorkspaceError("not_found", message, status=status)
    if status == 429:
        raise WorkspaceError(
            "rate_limited",
            "Google is rate-limiting this account right now.",
            status=status,
            hint="Wait a few seconds and retry.",
        )
    if status >= 500:
        raise WorkspaceError(
            "google_unavailable",
            f"Google returned HTTP {status}: {message}",
            status=status,
            hint="Transient upstream failure. Retry shortly.",
        )
    raise WorkspaceError("bad_request", message, status=status, details=reason or None)


# ── Transport ────────────────────────────────────────────────────────────────


def _send(method: str, url: str, body: Any, timeout: float):
    from hermes_cli.plugin_provider_requests import (
        ProviderNotSignedIn,
        credentialed_provider_request,
    )

    try:
        return credentialed_provider_request(
            PROVIDER, method, url, json=body, timeout=timeout
        )
    except ProviderNotSignedIn:
        raise WorkspaceError(
            "not_connected",
            "No Google Workspace sign-in is stored for this Hermes profile.",
            hint=SIGN_IN_COMMAND,
        ) from None
    except PermissionError as exc:
        raise WorkspaceError("configuration", str(exc)) from None
    except ValueError as exc:
        raise WorkspaceError("configuration", str(exc)) from None
    except Exception as exc:  # httpx errors are re-raised detached by Hermes
        if _is_transport_error(exc):
            raise WorkspaceError(
                "network",
                f"Could not reach Google ({type(exc).__name__}).",
                hint="Check the network connection and retry.",
            ) from None
        raise


def _is_transport_error(exc: BaseException) -> bool:
    """httpx raises its own classes for refused connections, timeouts and protocol failures."""
    return type(exc).__module__.split(".")[0] == "httpx"


def _backoff(attempt: int, response=None) -> float:
    if response is not None:
        retry_after = (response.headers or {}).get("retry-after")
        if retry_after:
            try:
                return min(8.0, max(0.0, float(retry_after)))
            except ValueError:
                pass
    return min(8.0, 0.6 * (2**attempt)) + random.uniform(0, 0.25)


def request(
    method: str,
    url: str,
    *,
    params: Optional[Mapping[str, Any]] = None,
    body: Any = None,
    timeout: float = 30.0,
) -> tuple[Any, dict]:
    """Call Google. Returns ``(parsed_payload, headers)``; raises WorkspaceError."""
    target = with_query(url, params)
    method = method.upper()
    retryable_method = method in {"GET", "HEAD"}

    last: WorkspaceError | None = None
    for attempt in range(_MAX_ATTEMPTS):
        try:
            response = _send(method, target, body, timeout)
        except WorkspaceError as exc:
            if exc.code == "network" and retryable_method and attempt < _MAX_ATTEMPTS - 1:
                last = exc
                time.sleep(_backoff(attempt))
                continue
            raise

        status = int(response.status)
        if 200 <= status < 300:
            if status == 204 or not response.body:
                return None, dict(response.headers or {})
            try:
                return response.json(), dict(response.headers or {})
            except Exception:
                return response.text, dict(response.headers or {})

        payload: Any = None
        try:
            payload = response.json()
        except Exception:
            payload = None

        should_retry = status in _RETRY_STATUSES and (status == 429 or retryable_method)
        if should_retry and attempt < _MAX_ATTEMPTS - 1:
            time.sleep(_backoff(attempt, response))
            continue

        _raise_http(status, payload, response.text, target)

    raise last or WorkspaceError("unexpected", "Google request failed.")


def get(url: str, params: Optional[Mapping[str, Any]] = None, *, timeout: float = 30.0):
    return request("GET", url, params=params, timeout=timeout)


def post(url: str, body: Any = None, *, params: Optional[Mapping[str, Any]] = None,
         timeout: float = 30.0):
    return request("POST", url, params=params, body=body, timeout=timeout)


def patch(url: str, body: Any = None, *, params: Optional[Mapping[str, Any]] = None,
          timeout: float = 30.0):
    return request("PATCH", url, params=params, body=body, timeout=timeout)


def put(url: str, body: Any = None, *, params: Optional[Mapping[str, Any]] = None,
        timeout: float = 30.0):
    return request("PUT", url, params=params, body=body, timeout=timeout)


def delete(url: str, *, params: Optional[Mapping[str, Any]] = None, timeout: float = 30.0):
    return request("DELETE", url, params=params, timeout=timeout)


# ── Small shared helpers ─────────────────────────────────────────────────────


def account_email() -> str:
    """The signed-in Gmail address, or "" when mail is not available."""
    try:
        profile, _ = get(f"{GMAIL_ROOT}/profile", timeout=15)
    except WorkspaceError:
        return ""
    if isinstance(profile, dict):
        return str(profile.get("emailAddress") or "")
    return ""


def clamp(value: Any, low: int, high: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))

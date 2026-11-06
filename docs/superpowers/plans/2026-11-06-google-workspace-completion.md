# Google Workspace for Hermes — Completion Plan

> **For agentic workers:** Execution method: native (single session), per the user's instruction to proceed without waiting. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the opencode-generated draft into a plugin that loads in Hermes Desktop, passes `hermes plugins validate`, exposes its tools to Hermes with approval gates on every consequential write, and is verified by automated tests plus a real desktop run.

**Architecture:** Three layers, unchanged from the draft. `hermes_google_workspace/` holds the Google REST layer (`client.py`, `services.py`), agent tools (`tools.py`), cross-app workflows (`workflows.py`) and the approval hook (`hooks.py`). `dashboard/plugin_api.py` is the FastAPI backend the desktop UI calls. `desktop/plugin.js` is the disk-plugin ESM UI. Google OAuth is owned by Hermes (`oauth:` in `plugin.yaml`, `credentialed_provider_request`); the plugin never holds a token.

**Tech Stack:** Python 3.11 (stdlib + Hermes-provided fastapi/httpx only, no new runtime deps), plain ESM JavaScript using `@hermes/plugin-sdk`, `react`, `react/jsx-runtime` only. Tests: pytest (Python), vitest + jsdom + eslint (JS). Test tooling lives in `tests/` and never adds runtime dependencies.

**Spec:** This plan is its own spec. Source of requirements: the "Master Build Prompt" (`~/.hermes/composer-pastes/pasted_content_2026-11-06_16-40-32-257_df9bb0.txt`) as scoped by the user's instruction to complete the existing work, and the Hermes admission rules (`plugin-catalog/README.md`, `hermes plugins validate`).

## Global Constraints

- Desktop code: no JSX syntax, no `document`/`window` DOM queries, no `eval`/`new Function`, imports only `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.
- Every Google call goes through `hermes_google_workspace/client.py` → `credentialed_provider_request("google", ...)`. No token, client secret or `auth.json` access in plugin code.
- Secrets read through `agent.secret_scope.get_secret(NAME)`, never a bare `os.environ` read.
- Every write that notifies others, deletes, shares or changes existing content requires approval (`pre_tool_call` hook returns `{"action": "approve"}`) or an explicit `confirm: true` on the REST route.
- Reads and reversible non-notifying actions (drafts, mark read/unread, star, archive) need no approval.
- Declared `provides_tools` / `provides_hooks` in `plugin.yaml` must equal what `register(ctx)` registers.
- `requires_hermes: ">=0.22.7"` in `plugin.yaml` (the local core build the plugin was verified against).
- No `.pyc`, no committed secrets, no `package.json` at plugin root (Hermes installer would try Node installs).
- Calendar times: naive datetimes are interpreted in the host's local timezone, never UTC. Explicit `timezone` wins.

## Review Focus

1. Naive date/time from the agent is read as UTC, so "10:00 tomorrow" becomes the wrong hour for a CET user. Test: naive input resolves to local offset; explicit offset preserved.
2. Network failure (`httpx.ConnectError`, timeouts) escapes as `unexpected` instead of `network`. Test: a transport raising `httpx.ConnectError` yields `code == "network"`.
3. A write tool missing from the approval hook runs without approval. Test: every tool in the write set yields an approve directive; every read tool yields none.
4. Desktop plugin does not parse or has no `export default` (already present in the draft). Test: `node --check` on ESM copy; registration test loads the default export and calls `register` against a stub context.
5. Missing OAuth grant or revoked token surfaces as a raw traceback or as a fake "Ready". Test: 401 → `not_connected` with sign-in hint; 403 scope → `scope_missing`; status route never reports `ready` without a successful probe.

## Tasks

### Task 1: Backend correctness fixes
**Files:** Modify `hermes_google_workspace/client.py`, `hermes_google_workspace/services.py` (`parse_time`), `dashboard/plugin_api.py` (secret reads), `plugin.yaml` (top-level `provides_tools`, `provides_hooks`, `requires_hermes`). Test: `tests/python/test_client.py`, `tests/python/test_services_time.py`.
- Consumes: `client.request`, `client._send`, `services.parse_time`.
- Produces: `client._send` maps any `httpx` exception to `WorkspaceError("network")`; `parse_time(value: str, tz_name: str = "") -> datetime` returns aware local datetimes for naive input.

### Task 2: Capability additions for the workflows
**Files:** Modify `services.py` (add `gmail_modify`, `calendar_conflicts`, `calendar_find_event`-free helpers), `workflows.py` (`email_to_event_proposal` adds `conflicts`), `tools.py` (new schemas+handlers), `hooks.py` (approval set), `dashboard/plugin_api.py` (routes). Test: `tests/python/test_tools_contract.py`, `tests/python/test_workflows.py`, `tests/python/test_plugin_api.py`.
- New tools: `google_gmail_modify` (no approval), `google_calendar_check_availability` (no approval), `google_sheets_create` (approval).
- New REST: `POST /gmail/{message_id}/modify {action}`, `POST /sheets/{spreadsheet_id}/append {range, rows, confirm}`, `GET /calendar/availability?start&end`.
- Produces: `services.gmail_modify(message_id: str, action: str) -> dict`, `services.calendar_conflicts(start: datetime, end: datetime) -> list[dict]`.

### Task 3: Python test suite
**Files:** Create `tests/python/conftest.py`, `test_client.py`, `test_services_time.py`, `test_tools_contract.py`, `test_hooks.py`, `test_workflows.py`, `test_plugin_api.py`, `test_registration.py`, `requirements-dev.txt`, `pytest.ini`.
- Fake transport replaces `client._send`; no network.

### Task 4: Desktop UI completion
**Files:** Modify `desktop/plugin.js`. Fix the `DocsTab` syntax error; delete dead code; add `SheetsTab`, `ContactsTab`, `SettingsView`, `InvoicesDialog`, Gmail message actions, `GlobalSearch`, `GoogleWorkspacePage` (root), `export default` with `register(ctx)` using `ROUTES_AREA`, `SIDEBAR_NAV_AREA`, `PALETTE_AREA`. Remove sent-URL storage.
- Consumes REST routes listed in Task 2 plus existing routes in `plugin_api.py`.

### Task 5: JS test suite
**Files:** Create `tests/js/package.json`, `tests/js/vitest.config.mjs`, `tests/js/stubs/plugin-sdk.jsx`, `tests/js/plugin.test.jsx`, `tests/js/eslint.config.mjs`.
- Renders every view with fixtures; asserts register() contributions; eslint `no-undef`.

### Task 6: Hermes integration checks
- `hermes plugins validate /Users/francoleff/workspace/google-workspace-hermes` must print `Validation passed` with every check ✓.
- `hermes plugins doctor google-workspace` (after install) must pass.
- Install by symlink into the profile plugins dir; enable only after user confirmation of the config change.

### Task 7: Real desktop run
- Open Hermes Desktop, confirm the sidebar entry, the connect/setup state, and each tab. Save screenshots under `docs/screenshots/`.

### Task 8: Documentation and submission kit
**Files:** `README.md`, `docs/ARCHITECTURE.md`, `docs/PERMISSIONS.md`, `docs/SECURITY.md`, `docs/DEMO_SCRIPT.md`, `docs/SUBMISSION.md`, `catalog/google-workspace.yaml.draft`, `LICENSE`.
- The catalog file is a draft: its `sha` stays a placeholder until the user publishes the repo. Nothing is pushed or submitted.

### Task 9: Final verification
- Run all Python and JS tests, the validator, the desktop checks; review `git diff` against the baseline commit; report verified vs unverified.

## Self-Review Notes
- Spec coverage: Gmail, Calendar, Drive, Docs, Sheets, Contacts each have tools and UI; Slides/Tasks/Forms are investigated in the README, not built.
- Deferred (documented in README): Calendar update/delete/RSVP, Drive upload/download/share, Gmail labels, Contacts create/update (needs a broader `contacts` scope), Docs formatting, multi-account, one-click OAuth from the UI (no host RPC for plugin OAuth exists).

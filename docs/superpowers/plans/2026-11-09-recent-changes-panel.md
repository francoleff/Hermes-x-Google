# Recent changes panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Changes" tab to the Google Workspace page that lists the Google writes Hermes made in its tasks, each with a link to the affected item.

**Architecture:** A new `hermes_google_workspace/changes.py` records successful Google write-tool calls in a locked in-memory buffer. Two new observer hooks — `post_tool_call` (record) and `on_session_end` (flush) — connect it to the agent. The flush pushes the buffer through `hermes_cli.plugin_events.broadcast_plugin_event`, which reaches every connected Desktop window; `desktop/plugin.js` listens with `ctx.onEvent`, prepends the entries to a plugin-scoped stored feed, and renders them in a new Changes tab.

**Tech Stack:** Python 3.11 stdlib only (no new runtime dependencies); plain ESM JavaScript with `@hermes/plugin-sdk` and `react/jsx-runtime` (no build step). Tests: pytest, vitest + jsdom + eslint.

**Spec:** `docs/superpowers/specs/2026-11-09-recent-changes-panel-design.md` — the extraction table, the entry schema and the builder calls live there. Read it before Task 1.

## Global Constraints

- Every Google call still goes through `hermes_google_workspace/client.py` → `credentialed_provider_request("google", …)`. `changes.py` makes **no** Google calls and imports nothing from `client.py`.
- Observer hooks must never raise and must do no I/O beyond the in-memory buffer. `post_tool_call` is on the agent's hot path and timeout-bounded at 30s.
- `plugin.yaml` `provides_hooks` must equal, in order, what `hooks.register(ctx)` registers: `["pre_tool_call", "post_tool_call", "on_session_end"]`.
- Desktop code: no JSX syntax, no `document`/`window` DOM queries outside the existing helpers, no `eval`, imports only `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.
- Tests run with no network and no Hermes sign-in. `hermes_cli` exists only inside Hermes, so any test that needs it stubs the module in `sys.modules` (the pattern in `tests/python/test_client.py:25-38`).
- Commit only the files each task touches; the working tree already carries unrelated uncommitted edits to `dashboard/plugin_api.py` and `desktop/plugin.js`.

## Review Focus

1. **A result that is a dict, not a JSON string.** `post_tool_call` may hand either to `record`; parsing must accept both, or the panel silently shows nothing.
2. **A call that returns `ok: true` but changed nothing.** `google_email_to_event` without `confirm`, `google_docs_replace_text` with 0 matches, `google_organize_drive` with no moves — each must be dropped by its `Changed` condition.
3. **Parallel tool calls.** `post_tool_call` fires concurrently; an unguarded append loses entries.
4. **A hook that raises.** `broadcast_plugin_event` is a plain import with no error contract; a failure there must not escape into the agent loop.
5. **A write with no `webUrl`.** Contacts, cancels, RSVPs and shares return none; the entry must still be recorded, and the panel must render it without a link rather than hiding it.

---

### Task 1: The change recorder

**Files:**
- Create: `hermes_google_workspace/changes.py`
- Test: `tests/python/test_changes.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `changes.record(tool_name: str, result: Any, *, session_id: str = "", turn_id: str = "") -> dict | None`
  - `changes.drain(limit: int = 25) -> list[dict]`
  - `changes.broadcast_pending(limit: int = 25) -> int`
  - `changes.PLUGIN_ID: str = "google-workspace"`, `changes.EVENT_NAME: str = "turn.changes"`
  - Entry keys: `id`, `at`, `service`, `action`, `title`, `url`, `sessionId`, `turnId`.

- [ ] **Step 1: Write the failing test**

Create `tests/python/test_changes.py`:

```python
import json
import sys
import types
from unittest.mock import Mock

import pytest

from hermes_google_workspace import changes

DOCS_CREATE = json.dumps({"ok": True, "data": {
    "id": "d1", "title": "Meeting brief",
    "webUrl": "https://docs.google.com/document/d/d1/edit", "created": True,
}})
SHEETS_CREATE = json.dumps({"ok": True, "data": {
    "id": "s1", "title": "Invoices",
    "webUrl": "https://docs.google.com/spreadsheets/d/s1/edit", "created": True,
}})


def test_record_extracts_service_action_title_and_url():
    entry = changes.record("google_docs_create", DOCS_CREATE, session_id="sess", turn_id="turn")
    assert entry["service"] == "docs"
    assert entry["action"] == "Created document"
    assert entry["title"] == "Meeting brief"
    assert entry["url"] == "https://docs.google.com/document/d/d1/edit"
    assert entry["sessionId"] == "sess"
    assert entry["turnId"] == "turn"
    assert entry["id"] and entry["at"].endswith("Z")


def test_record_accepts_a_dict_result():
    entry = changes.record("google_docs_create", json.loads(DOCS_CREATE))
    assert entry["title"] == "Meeting brief"


def test_record_ignores_a_failed_call():
    failed = json.dumps({"ok": False, "error": {"code": "forbidden", "message": "no"}})
    assert changes.record("google_docs_create", failed) is None


def test_record_ignores_a_call_that_changed_nothing():
    assert changes.record("google_email_to_event", {"ok": True, "data": {"created": False}}) is None
    assert changes.record("google_docs_replace_text", {"ok": True, "data": {
        "find": "Q3", "occurrencesChanged": 0, "replaced": False,
    }}) is None
    assert changes.record("google_organize_drive", {"ok": True, "data": {
        "created": True, "moved": [], "folder": {"name": "Archive", "webUrl": "https://drive.google.com/drive/folders/f1"},
    }}) is None


def test_record_ignores_read_tools_and_unknown_names():
    assert changes.record("google_docs_read", {"ok": True, "data": {"id": "d1"}}) is None
    assert changes.record("terminal", {"ok": True, "data": {}}) is None


def test_drain_returns_then_clears():
    changes.record("google_docs_create", DOCS_CREATE)
    changes.record("google_sheets_create", SHEETS_CREATE)
    assert [entry["service"] for entry in changes.drain()] == ["docs", "sheets"]
    assert changes.drain() == []


def test_drain_is_capped():
    for _ in range(40):
        changes.record("google_docs_create", DOCS_CREATE)
    assert len(changes.drain(limit=5)) == 5


def test_record_is_safe_for_parallel_calls():
    import threading
    threads = [threading.Thread(target=changes.record, args=("google_docs_create", DOCS_CREATE))
               for _ in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(changes.drain()) == 20


@pytest.fixture
def bridge(monkeypatch):
    """Stand-in for hermes_cli.plugin_events, which only exists inside Hermes."""
    sent = []
    module = types.ModuleType("hermes_cli.plugin_events")
    module.broadcast_plugin_event = lambda plugin_id, event, payload=None: sent.append(
        (plugin_id, event, payload))
    package = types.ModuleType("hermes_cli")
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_events", module)
    return sent


def test_broadcast_pending_pushes_the_plugin_event(bridge):
    changes.record("google_docs_create", DOCS_CREATE)
    assert changes.broadcast_pending() == 1
    plugin_id, event, payload = bridge[0]
    assert plugin_id == "google-workspace"
    assert event == "turn.changes"
    assert payload["changes"][0]["title"] == "Meeting brief"
    assert changes.broadcast_pending() == 0
    assert len(bridge) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3.13 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest tests/python/test_changes.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hermes_google_workspace.changes'`.

- [ ] **Step 3: Implement `changes.py`**

One module-level buffer with a `threading.Lock`, a process-unique counter for `id`, and the spec's extraction table. Behavior the tests pin:

- `record` returns `None` unless the tool is in the table, the result parses (`json.loads` when it is a string, otherwise the object itself), `ok` is true, and the table's `Changed` condition holds.
- `data` is the parsed `data` object; `args` is the call's arguments (default `{}`).
- `title` is truncated to 80 characters; `at` is `time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())`.
- The buffer keeps at most 200 entries (drop the oldest) and `drain` pops up to `limit`.
- `broadcast_pending` imports `hermes_cli.plugin_events` lazily inside the function, calls `broadcast_plugin_event(PLUGIN_ID, EVENT_NAME, {"changes": drained})`, returns the count, and swallows every exception (log at `debug`).

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/python/test_changes.py -v`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add hermes_google_workspace/changes.py tests/python/test_changes.py
git commit -m "feat: record the Google changes Hermes makes"
```

---

### Task 2: The hooks

**Files:**
- Modify: `hermes_google_workspace/hooks.py`
- Modify: `plugin.yaml` (`provides_hooks`)
- Test: `tests/python/test_hooks.py`, `tests/python/test_tools_contract.py`

**Interfaces:**
- Consumes: `changes.record`, `changes.broadcast_pending` from Task 1.
- Produces: `hooks.post_tool_call`, `hooks.on_session_end`; `hooks.register(ctx)` registers exactly `["pre_tool_call", "post_tool_call", "on_session_end"]`.

- [ ] **Step 1: Write the failing test**

Add to `tests/python/test_hooks.py`:

```python
def test_post_tool_call_records_a_google_write(monkeypatch):
    from hermes_google_workspace import changes
    record = Mock()
    monkeypatch.setattr(changes, "record", record)
    hooks.post_tool_call(tool_name="google_docs_create", args={"title": "Brief"},
                         result='{"ok": true}', session_id="sess", turn_id="turn")
    record.assert_called_once_with("google_docs_create", '{"ok": true}',
                                   session_id="sess", turn_id="turn")


def test_post_tool_call_ignores_a_non_google_tool(monkeypatch):
    from hermes_google_workspace import changes
    record = Mock()
    monkeypatch.setattr(changes, "record", record)
    hooks.post_tool_call(tool_name="terminal", args={}, result='{"ok": true}')
    record.assert_not_called()


def test_on_session_end_broadcasts_the_pending_changes(monkeypatch):
    from hermes_google_workspace import changes
    broadcast = Mock(return_value=3)
    monkeypatch.setattr(changes, "broadcast_pending", broadcast)
    hooks.on_session_end(session_id="sess", turn_id="turn", completed=True)
    broadcast.assert_called_once_with()


def test_hook_registration_registers_the_three_hooks():
    class Ctx:
        def __init__(self) -> None:
            self.names: list[str] = []

        def register_hook(self, name, callback):
            self.names.append(name)

    ctx = Ctx()
    hooks.register(ctx)
    assert ctx.names == ["pre_tool_call", "post_tool_call", "on_session_end"]
```

Add the missing import at the top of `test_hooks.py`: `from unittest.mock import Mock`.

Update `tests/python/test_tools_contract.py`:

```python
    assert manifest["provides_hooks"] == ["pre_tool_call", "post_tool_call", "on_session_end"]
...
    assert list(ctx.hooks) == ["pre_tool_call", "post_tool_call", "on_session_end"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/python/test_hooks.py tests/python/test_tools_contract.py -v`
Expected: FAIL — `post_tool_call` / `on_session_end` do not exist; the hook lists are wrong.

- [ ] **Step 3: Implement the hooks**

In `hooks.py`, import the recorder (`from . import changes`) and add:

```python
def post_tool_call(tool_name: str = "", args: dict | None = None, result: Any = None,
                   session_id: str = "", turn_id: str = "", **kwargs):
    """Record a Google write this call made. Observer: never raises."""
    if not tool_name.startswith("google_"):
        return None
    try:
        changes.record(tool_name, result, session_id=session_id, turn_id=turn_id)
    except Exception:
        logger.debug("google-workspace change record failed", exc_info=True)
    return None


def on_session_end(session_id: str = "", turn_id: str = "", **kwargs):
    """Push this turn's Google changes to the Desktop. Observer: never raises."""
    try:
        changes.broadcast_pending()
    except Exception:
        logger.debug("google-workspace change broadcast failed", exc_info=True)
    return None
```

`register` becomes:

```python
def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("post_tool_call", post_tool_call)
    ctx.register_hook("on_session_end", on_session_end)
```

Set `provides_hooks` in `plugin.yaml` to exactly `["pre_tool_call", "post_tool_call", "on_session_end"]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/python -v`
Expected: PASS, the whole Python suite.

- [ ] **Step 5: Commit**

```bash
git add hermes_google_workspace/hooks.py plugin.yaml tests/python/test_hooks.py tests/python/test_tools_contract.py
git commit -m "feat: observe Google writes and flush them at turn end"
```

---

### Task 3: The Changes panel

**Files:**
- Modify: `desktop/plugin.js`
- Modify: `tests/js/sdk-shim.jsx` (no change expected — `host` is already there)
- Test: `tests/js/ui/plugin.test.jsx`

**Interfaces:**
- Consumes: the gateway event `plugin.google-workspace.turn.changes` with `{"changes": [<entry>, …]}`; each entry carries the keys from Task 1.
- Produces: `ChangesTab`, `useRecentChanges()`.

- [ ] **Step 1: Write the failing test**

In `tests/js/ui/plugin.test.jsx`'s `fakeContext`, add an event listener registry:

```js
function fakeContext(routes) {
  const registrations = []
  const eventListeners = []
  // …existing rest/register/registerMany/onDispose/i18n/os/storage…
  return {
    rest, registrations, eventListeners,
    register: (entry) => { registrations.push(entry); return () => {} },
    registerMany: (entries) => entries.map((entry) => { registrations.push(entry); return () => {} }),
    onEvent: (type, listener) => { eventListeners.push({ type, listener }); return () => {} },
    onDispose: () => {},
    // …
  }
}
```

Add a helper and the describe block:

```js
const CHANGES_EVENT = 'plugin.google-workspace.turn.changes'
const CHANGE = {
  id: 'google_docs_create:17',
  at: '2026-11-09T12:34:56Z',
  service: 'docs',
  action: 'Created document',
  title: 'Meeting brief — Sync',
  url: 'https://docs.google.com/document/d/d1/edit',
  sessionId: 'sess',
  turnId: 'turn',
}

function fireChanges(ctx, changes) {
  const listener = ctx.eventListeners.find((entry) => entry.type === CHANGES_EVENT)?.listener
  if (!listener) throw new Error('The plugin did not subscribe to ' + CHANGES_EVENT)
  act(() => listener({ payload: { changes } }))
}

describe('recent changes', () => {
  it('lists Changes between Contacts and Settings', async () => {
    const ctx = fakeContext(defaultRoutes())
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 9, 'the nine tabs')
    expect(tabs().map((node) => node.textContent.trim())).toEqual([
      'Workspace', 'Gmail', 'Calendar', 'Drive', 'Docs', 'Sheets', 'Contacts', 'Changes', 'Settings',
    ])
  })

  it('shows the empty state before any task changes something', async () => {
    const ctx = fakeContext(defaultRoutes())
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 9, 'the nine tabs')
    await click(tab('Changes'))
    await until(() => container.textContent.includes('No changes yet'), 'the empty state')
  })

  it("records a turn's changes, links each item, and clears the feed", async () => {
    const ctx = fakeContext(defaultRoutes())
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 9, 'the nine tabs')
    await click(tab('Changes'))

    fireChanges(ctx, [CHANGE])
    await until(() => container.textContent.includes('Meeting brief — Sync'), 'the recorded change')
    expect(container.textContent).toContain('Created document')

    const open = [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Open')
    await click(open)
    expect(ctx.os.openExternal).toHaveBeenCalledWith(CHANGE.url)

    expect(ctx.storage.get('recentChanges', null)).toHaveLength(1)

    await click(button('Clear changes'))
    await until(() => container.textContent.includes('No changes yet'), 'the cleared feed')
    expect(ctx.storage.get('recentChanges', null)).toEqual([])
  })

  it('restores the feed from storage on the next visit', async () => {
    const ctx = fakeContext(defaultRoutes())
    ctx.storage.set('recentChanges', [CHANGE])
    plugin.register(ctx)
    mount(ctx)
    await until(() => tabs().length === 9, 'the nine tabs')
    await click(tab('Changes'))
    await until(() => container.textContent.includes('Meeting brief — Sync'), 'the stored change')
  })
})
```

Replace every `tabs().length === 8` assertion in the file with `tabs().length === 9` (24 occurrences), and update the tab-list expectation at line 238.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests/js && npm test`
Expected: FAIL — the Changes tab does not exist, and `ctx.onEvent` is missing.

- [ ] **Step 3: Implement the panel in `desktop/plugin.js`**

Add to `TABS`, between Contacts and Settings:

```js
  { id: 'Changes', label: 'Changes', icon: 'history' },
```

Add a module-level store beside the other helpers, following the `overview.layout` pattern:

- `const CHANGES_EVENT = 'plugin.google-workspace.turn.changes'`, `const CHANGES_STORAGE_KEY = 'recentChanges'`, `const CHANGES_LIMIT = 50`.
- `let recentChanges = []`, hydrated from `pluginCtx.storage` inside `register(ctx)` right after `pluginCtx = ctx`.
- `recordChanges(entries)` validates each entry, prepends the batch, caps at `CHANGES_LIMIT`, writes `ctx.storage`, and notifies listeners.
- `useRecentChanges()` subscribes with `useEffect` and returns the current list.
- `clearChanges()` empties the store, storage and listeners.

In `register(ctx)`, after `pluginCtx = ctx`:

```js
    recentChanges = readStoredChanges()
    ctx.onEvent(CHANGES_EVENT, (event) => recordChanges(event?.payload?.changes))
```

Add a `ChangesTab` component and a `case 'Changes'` in `renderTab()`. It renders, in order: a `Panel` with a `SectionHeading` (`title: 'Recent changes'`, `detail: 'From Hermes tasks'`, `action: jsx(Button, { variant: 'ghost', size: 'xs', onClick: clearChanges, children: 'Clear changes' })`), then either `EmptyBlock` (icon `history`, title `No changes yet`, description `When Hermes sends, creates or edits something in your Google account, it shows up here with a link.`) or one row per entry.

Each row: `ServiceIcon` for `entry.service`; the action in `0.78rem/600`; the title in `0.73rem` `var(--ui-text-tertiary)`; `MetaLine` with `fmtRelative(entry.at)`; and, when `entry.url`, a `LinkAction` labelled `Open` that calls `openUrl(entry.url)`. An entry with no URL renders no link. Use `entry.id` as the React key.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tests/js && npm test`
Expected: PASS, the whole UI suite.

- [ ] **Step 5: Lint the desktop file**

Run:
```bash
cd tests/js && cat ../../desktop/plugin.js | node node_modules/eslint/bin/eslint.js \
  --config eslint.config.mjs --stdin --stdin-filename plugin.js
```
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add desktop/plugin.js tests/js/ui/plugin.test.jsx
git commit -m "feat: add a recent changes panel to Google Workspace"
```

---

### Task 4: Documentation and verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the panel**

In `README.md`, add a short paragraph under **What you can do** (after the table) explaining the Changes tab: it lists the Google writes Hermes made in its tasks — sends, docs, sheets, events, Drive moves — each with a link, kept for the last 50 entries, and nothing is recorded until a task finishes. Note that it reflects agent tasks, not clicks in the page.

- [ ] **Step 2: Run the full suite**

```bash
.venv/bin/python -m pytest tests/python
cd tests/js && npm test
cd ../.. && hermes plugins validate .
```
Expected: all tests pass; the validator prints `Validation passed`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the recent changes panel"
```

---

## Self-Review

**Spec coverage:** intent (panel of task changes with links) → Task 3; record every successful write → Task 1's table; survive reload → Task 3's storage; no hot-path cost → Tasks 1-2 (no Google calls, never raise); observer return ignored → Task 2 broadcasts instead of returning; `provides_hooks` parity → Task 2; no new dependencies → Global Constraints; links for items that have one, none invented → Task 1's table and Task 3's conditional link.

**Step scan:** every test step names its assertions; every code step names the file, the signature and the values the spec pins; the only bodies are the two hook functions and the extraction table's behavior, which the spec does not determine.

**Type consistency:** `record`/`drain`/`broadcast_pending` are used by Task 2 exactly as Task 1 defines them; `PLUGIN_ID`/`EVENT_NAME` match `plugin.yaml`'s plugin name and the JS `CHANGES_EVENT` constant; entry keys are camelCase in the spec, Task 1's tests and Task 3's component.

**Review Focus:** dict-vs-string result (Task 1, `test_record_accepts_a_dict_result`); `ok: true` but nothing changed (Task 1, `test_record_ignores_a_call_that_changed_nothing`); parallel calls (Task 1, `test_record_is_safe_for_parallel_calls`); a raising broadcast (Task 2 wraps both hooks in `try/except`); a write with no URL (Task 3 renders the row without a link, and Task 1's table pins `""` for contacts, cancels, RSVPs and shares).

**Proportion:** the plan is roughly the length of the code it describes; the extraction table lives in the spec, and the plan references it rather than repeating it.

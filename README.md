# Google Workspace for Hermes

One place for your Google work inside Hermes Desktop, and an agent that can work across it.

- **For you:** a sidebar page with Gmail, Calendar, Drive, Docs, Sheets and Contacts, plus a search that covers all of them at once.
- **For Hermes:** 24 tools that read and write those services. Hermes can combine them in one task, for example "prepare me for my meeting with James tomorrow".

Nothing is sent, shared, created or moved until you approve it. Reading, searching, drafting and reversible label changes run without a prompt.

> **Status:** the automated tests and the Hermes plugin validator pass. The code has **not yet been run against a live Google account**, because no OAuth client exists on the development machine. Treat every Google call as unverified until you have run the [live check](#live-check-what-to-run-with-your-own-account) below.

## What you can do

| Area | In the sidebar page | Hermes tools |
|---|---|---|
| **Overview** | Unread count, next meeting, recent files, workflow cards, search across all services | `google_search` |
| **Gmail** | Inbox and search, read a message, mark read/unread, star, archive, compose, reply, forward, create event from a message | `google_gmail_search`, `_read`, `_send`, `_draft`, `_modify` |
| **Calendar** | Agenda, event details, new event with a live clash warning, meeting brief | `google_calendar_agenda`, `_check_availability`, `_create_event` |
| **Drive** | Recent files and search by type, file details, new folder, organise into a folder | `google_drive_search`, `_create_folder`, `_move` |
| **Docs** | List and search, read text, create, append text | `google_docs_read`, `_create`, `_append` |
| **Sheets** | List and search, preview a range, create a sheet, add rows | `google_sheets_read`, `_create`, `_append` |
| **Contacts** | Search, details, create a contact | `google_contacts_search`, `_create` |
| **Cross-app** | Meeting brief, email → event, invoices → Sheet, organise Drive | `google_meeting_brief`, `google_email_to_event`, `google_invoices_to_sheet`, `google_organize_drive` |
| **Settings** | What Hermes can reach, connection status, sign-in and sign-out commands | — |

Not implemented yet: editing existing drafts, downloading attachments, uploading files, editing contacts, Docs formatting and find-and-replace, Sheets formatting, Slides, Tasks and Forms. See [Limitations](#limitations).

## Install

Requirements: Hermes Agent **v0.22.3 or newer** (the plugin manifest sets `requires_hermes: ">=0.22.3"`; the validator was run on 0.22.7), Hermes Desktop (tested on macOS), Python 3.11 or newer for the tests (run on 3.13), and a Google account.

### 1. Create a Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
2. **APIs & Services → Library:** enable **Gmail API**, **Google Calendar API**, **Google Drive API**, **Google Docs API**, **Google Sheets API** and **People API**.
3. **OAuth consent screen (Google Auth Platform):** set up the app details. While the app is in *Testing*, add your own Google account as a test user.
4. **Clients → Create client → Desktop app.** Copy the client ID and client secret.

Add them to the environment file of the Hermes profile you use (`$HERMES_HOME/.env`; the default profile's home is `~/.hermes`, a named profile's is `~/.hermes/profiles/<name>`):

```
GOOGLE_WORKSPACE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_WORKSPACE_CLIENT_SECRET=…
```

Never commit these values. `.gitignore` already excludes `.env`, `*.env`, `google_token.json`, `google_client_secret.json` and `client_secret*.json`.

### 2. Install the plugin

From a Git URL or catalog name, once the plugin is published:

```bash
hermes plugins install <repo-url-or-catalog-name>
```

From a local checkout, copy the folder into your Hermes profile's plugins directory (`$HERMES_HOME/plugins/`) and enable it. Copy only the files the plugin needs, not `.venv/` or `tests/js/node_modules/`:

```bash
mkdir -p "$HERMES_HOME/plugins/google-workspace"
cp -R /path/to/google-workspace-hermes/{plugin.yaml,__init__.py,hermes_google_workspace,dashboard,desktop} "$HERMES_HOME/plugins/google-workspace/"
hermes plugins enable google-workspace
```

Then reload desktop plugins from the Desktop command palette (⌘K → *Reload desktop plugins*). The sidebar gets a **Google Workspace** entry.

### 3. Sign in

The sign-in runs in a terminal, not in the plugin. Hermes opens your browser, asks for the permissions below, and stores the refresh token in its own credential store.

```bash
hermes auth add google-workspace:google
hermes auth status google-workspace:google
```

Back in Hermes Desktop, open **Google Workspace → Settings** and press **Check again**. The account appears and each service shows **Ready**.

Sign out at any time with `hermes auth logout google-workspace:google`. Reconnect after revoking access with the same `add` command.

## Permissions

The plugin requests exactly these scopes (`plugin.yaml`, checked by `tests/python/test_manifest.py`):

| Scope | Used for |
|---|---|
| `gmail.modify` | Read mail; mark read/unread, star, archive. Read access is included, so `gmail.readonly` is not requested. |
| `gmail.send` | Send mail, after your approval |
| `gmail.compose` | Create and update drafts |
| `calendar.events` | Read the agenda, check for clashes, create events, send invitations after approval |
| `drive` | Search and read files, create folders, move files after approval. The narrower `drive.file` would hide files you already have. |
| `documents` | Read Docs; create and append text after approval |
| `spreadsheets` | Read Sheets; create and add rows after approval |
| `contacts` | Read and search contacts; create a contact after approval. Creating needs write access, and no narrower scope exists. |

The broad `https://mail.google.com/` scope is never requested. Google shows the consent screen with these permissions when you sign in. You can review or revoke them at any time under [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Approval model

Every tool is classified in `hermes_google_workspace/hooks.py` and checked by `tests/python/test_hooks.py`.

| Asks you first | Runs without a prompt |
|---|---|
| `google_gmail_send` | All read and search tools |
| `google_calendar_create_event` | `google_gmail_draft` (saves a draft; sends nothing) |
| `google_docs_create`, `google_docs_append` | `google_gmail_modify` (reversible; notifies nobody) |
| `google_sheets_create`, `google_sheets_append` | `google_calendar_check_availability` |
| `google_drive_create_folder`, `google_drive_move` | |
| `google_contacts_create` | |
| `google_email_to_event`, `google_invoices_to_sheet`, `google_organize_drive`: only when `confirm` is true | |
| `google_meeting_brief`: only when `save_to_docs` is true | |

The approval message names what will change (recipients, title, row count) and never quotes the body of an email. The plugin also checks on its own side: write endpoints refuse requests without `confirm: true`, and the desktop UI sends that flag only after you press confirm in a review dialog.

## Tool reference

All tools are in the `google_workspace` toolset. Each returns a JSON envelope: `{"ok": true, "data": …}` or `{"ok": false, "error": {"code", "message", "hint"}}`.

| Tool | Arguments | Purpose |
|---|---|---|
| `google_search` | `query`, `max_results?` | One query across Gmail, Calendar and Drive. Each result is labelled with its service. |
| `google_gmail_search` | `query?`, `max_results?`, `include_spam_trash?` | Gmail search with Gmail's query syntax, for example `from:ana newer_than:7d has:attachment` |
| `google_gmail_read` | `message_id`, `thread?` | One message's headers and plain-text body, or the whole thread |
| `google_gmail_send` | `to`, `subject`, `body`, `cc?`, `bcc?`, `html?`, `thread_id?`, `in_reply_to?`, `references?` | Send mail. **Asks first.** |
| `google_gmail_draft` | `to`, `subject`, `body`, `cc?`, `bcc?`, `html?`, `thread_id?`, `in_reply_to?` | Save a draft without sending |
| `google_gmail_modify` | `message_id`, `action` (`mark_read`, `mark_unread`, `star`, `unstar`, `archive`) | Change labels on one message |
| `google_calendar_agenda` | `days?`, `max_results?`, `time_min?` | Upcoming events on the primary calendar |
| `google_calendar_check_availability` | `start`, `end`, `timezone?` | Whether a window is free, and the events that overlap it |
| `google_calendar_create_event` | `summary`, `start`, `end?`, `duration_minutes?`, `description?`, `location?`, `attendees?`, `all_day?`, `add_meet?`, `timezone?`, `send_updates?` | Create an event. **Asks first.** |
| `google_drive_search` | `query?`, `max_results?`, `mime_type?`, `folder_id?` | Search by name and content |
| `google_drive_create_folder` | `name`, `parent_id?` | New folder. **Asks first.** |
| `google_drive_move` | `file_id`, `add_parents?`, `remove_parents?` | Change a file's folders. **Asks first.** |
| `google_docs_read` | `document_id` | A Doc as plain text, including tables |
| `google_docs_create` | `title`, `text?` | New Doc. **Asks first.** |
| `google_docs_append` | `document_id`, `text` | Add text at the end of a Doc. **Asks first.** |
| `google_sheets_read` | `spreadsheet_id`, `range?` | Cell values for an A1 range |
| `google_sheets_create` | `title`, `sheet_title?` | New spreadsheet. **Asks first.** |
| `google_sheets_append` | `spreadsheet_id`, `rows`, `range?` | Add rows after the last row. **Asks first.** |
| `google_contacts_search` | `query?`, `max_results?` | Search by name, email or phone; with no query, recent contacts |
| `google_contacts_create` | `name`, `email?`, `phone?`, `organization?`, `title?` | New contact. **Asks first.** |
| `google_meeting_brief` | `event_id?`, `query?`, `days?`, `save_to_docs?` | Event, attendees, recent threads, shared files, suggested agenda. Saving a Doc **asks first.** |
| `google_email_to_event` | `message_id`, `start?`, `duration_minutes?`, `confirm?` | Propose an event from an email; creates it only with `confirm`. **Asks first.** |
| `google_invoices_to_sheet` | `query?`, `spreadsheet_id?`, `days?`, `max_results?`, `confirm?` | Preview invoice emails and their attachments; with `confirm`, add rows to a sheet. Rows already in the sheet are skipped. **Asks first.** |
| `google_organize_drive` | `query`, `folder_name`, `max_files?`, `parent_folder_id?`, `confirm?` | Preview files matching a query; with `confirm`, create the folder and move them. **Asks first.** |

## Cross-app workflows

- **Meeting brief.** Pick a meeting. The brief collects its attendees, your recent threads with them, Drive files they share with you, and a suggested agenda. Saving it creates a Google Doc, after approval.
- **Email → calendar.** From a message, Hermes proposes a date, time and attendees, checks your calendar for clashes, and creates the event only after you confirm.
- **Invoices → Sheet.** Finds invoice and receipt emails with attachments. The preview shows the amount Hermes read and whether it found one. Missing amounts stay empty, and nothing is invented. Repeat runs skip invoices already in the sheet.
- **Organise Drive.** Previews the files that match, then creates one folder and moves them, after confirmation.

Amounts come from the email's subject and body text, so check them before you write. They are a draft, not an accounting record.

## Security

- **Hermes owns the OAuth flow and the tokens.** The plugin never sees a refresh token or client secret. Its REST calls go through Hermes's credentialed request bridge, which only sends the Google credential to the Google API hosts declared in `plugin.yaml`.
- **Secrets stay out of the repository.** `.gitignore` excludes `.env` and credential JSON files. Settings shows only whether the client ID and secret are present, never their values.
- **Writes are gated twice.** Hermes asks you before a tool runs (the `pre_tool_call` approval hook), and the plugin refuses write endpoints that lack `confirm: true`.
- **Content stays out of logs.** Errors carry a code, a message and a hint. They never include message bodies, file contents or tokens.
- **Email HTML is not rendered.** Messages show as plain text. Scripts and remote content in HTML email never run.
- **Narrow scopes**, as listed above, and a test that fails if the grant changes without a deliberate edit.
- **No self-updating code.** The plugin fetches only from the declared Google hosts and never replaces its own files.

## Architecture

```
desktop/plugin.js               Desktop UI (plain ESM, SDK only; no build step)
  │  ctx.rest('/…')             scoped to /api/plugins/google-workspace
dashboard/plugin_api.py         FastAPI routes: read endpoints and confirmed writes
  │
hermes_google_workspace/
  client.py                     HTTP, retries, error mapping, Hermes credentialed bridge
  services.py                   Gmail, Calendar, Drive, Docs, Sheets, Contacts
  workflows.py                  cross-app: brief, email → event, invoices, organise
  tools.py                      the 24 Hermes tool schemas and handlers
  hooks.py                      pre_tool_call approval policy
__init__.py                     register(ctx): tools + hook
```

Services never import each other's HTTP code, and workflows call services rather than Google directly. A failure in one service shows as that service's error, and the others keep working. Each new service would be one module plus a route, a tool and a tab.

## Testing

```bash
# Python: 128 tests, no network. Requires Python 3.11+ (run on 3.13) and the dev requirements.
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/python

# Desktop UI: 15 tests under jsdom, against an SDK stand-in.
cd tests/js && npm install && npm test

# Lint the desktop file for unresolved names and dead code.
cd tests/js && cat ../../desktop/plugin.js | node node_modules/eslint/bin/eslint.js \
  --config eslint.config.mjs --stdin --stdin-filename plugin.js

# Hermes plugin checks.
hermes plugins validate .
hermes plugins doctor .
```

What the tests cover:

- **HTTP layer:** retries for reads only, never for writes; rate limits; scope vs file-level 403s; transport errors; missing sign-in; refused origins.
- **Services:** time zones and daylight saving; conflicts that skip cancelled and declined events; Gmail header injection; Sheets row limits; contact validation; invoice dedupe.
- **Workflows:** previews write nothing; amounts are never invented; email proposals report clashes; the brief gathers evidence from all three services.
- **Contract:** the exact tool set, schemas, approval classification, and the manifest declaration.
- **API:** every write route refuses without `confirm`.
- **UI (jsdom):** registration; connect gate (no data fetched before sign-in); lazy tabs; keyboard tab navigation; review-then-confirm for sheet rows, with cancel; contact validation; reversible star; plain-language permission errors; cross-service search; clash warning; no hard-coded colours; every write call sends `confirm: true`.

Two of these checks were shown to fail when the behaviour was broken on purpose: dropping `confirm: true`, and writing before review.

## Live check: what to run with your own account

The automated suite cannot prove Google accepts these calls. Run this once, in a test Google account, before you rely on the plugin:

1. Sign in (`hermes auth add google-workspace:google`) and confirm Settings shows every service as **Ready**.
2. Overview → search for a word that appears in a test message, a test event and a test document. All three groups should appear, each labelled.
3. Gmail → open a test message → **Star**, then **Unstar**. Confirm the change in Gmail.
4. Sheets → create a test sheet → add two rows → confirm in the review dialog → check the rows in Sheets.
5. Contacts → create a test contact with an email address you control → check it in Google Contacts.
6. Hermes chat → "Prepare a meeting brief for my next meeting" → approve the Doc → open it.

Report any step that fails, with the message shown in the UI. A scope error names the missing permission; re-run the sign-in to grant it.

## Limitations

- **Unverified against Google.** See the status note at the top. Google's own errors (quotas, disabled APIs, verification) are shown as received, not interpreted.
- **Sign-in is terminal-only.** Hermes has no in-app OAuth flow for plugins, so the plugin shows the command and checks the result.
- **One account per profile.** Multiple accounts are not supported.
- **Scopes need verification for public use.** `gmail.modify`, `gmail.send`, `gmail.compose`, `drive` and `contacts` are sensitive or restricted scopes. A public release needs Google's app verification; while the consent screen is in Testing, only listed test users can sign in.
- **Read-only parts:** attachment download, draft editing, file upload, contact editing, and Docs or Sheets formatting are not implemented.
- **Not built:** Slides, Tasks and Forms.
- **Gmail HTML** is shown as plain text.
- **Invoice amounts** come from text heuristics and must be checked.
- **Screenshots** have not been taken yet. They will come from a run with a test account.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Connect Google Workspace" stays on screen | Check that `GOOGLE_WORKSPACE_CLIENT_ID` and `GOOGLE_WORKSPACE_CLIENT_SECRET` are set in the profile's `.env`, then restart Hermes Desktop. Run `hermes auth status google-workspace:google`. |
| A service says *Permission* | Sign in again to grant the missing scope: `hermes auth add google-workspace:google`. |
| A 403 that is not a permission message | Google's message names the API or file. If it says an API is not enabled, enable it in Google Cloud Console (step 1). |
| Requests fail with *Could not reach Google* | Check the network. Reads retry automatically; writes do not, so retry them yourself after checking. |
| The sidebar entry is missing | Run `hermes plugins list`, enable the plugin, then reload desktop plugins (⌘K). |

## Repository layout

```
plugin.yaml                     manifest: tools, hook, OAuth grant, requires_hermes
__init__.py                     plugin entry point
hermes_google_workspace/        Python services, workflows, tools, hooks
dashboard/plugin_api.py         REST routes for the desktop UI
dashboard/manifest.json         dashboard metadata
desktop/plugin.js               desktop UI
tests/python/                   pytest suite (no network)
tests/js/                       Vitest UI suite and lint config
docs/superpowers/plans/         implementation plan
DEMO.md                         demo script (not recorded)
catalog/                        draft catalog entry for a later, approved submission
```

## Licence

MIT. See `plugin.yaml`.

# Google Workspace for Hermes

One place for your Google work inside Hermes Desktop, and an agent that can work across it.

- **For you:** a sidebar page with Gmail, Calendar, Drive, Docs, Sheets and Contacts, plus a search that covers Gmail, Calendar and Drive at once.
- **For Hermes:** 24 tools that read and write those services. Hermes can combine them in one task, for example "prepare me for my meeting with James tomorrow".

Nothing is sent, shared, created or moved until you approve it. Reading, searching, drafting and reversible label changes run without a prompt.

> **Status: not yet proven against a live Google account.** The automated tests (131 Python, 15 desktop UI) and the Hermes plugin validator pass. Plugin discovery, registration and the validator were checked in an isolated Hermes profile. The desktop UI has **not** been run inside the running Hermes Desktop app, and no Google call has been made, because no OAuth client exists on the development machine. Run the [live check](#live-check-what-to-run-with-your-own-account) before relying on it.

## What you can do

| Area | In the sidebar page | Hermes tools |
|---|---|---|
| **Overview** | Unread count, today's agenda, recent files, workflow cards (meeting brief, invoices to Sheet, organise Drive), and a search across Gmail, Calendar and Drive | `google_search` |
| **Gmail** | Inbox and search, read a message, mark read or unread, star, archive, compose, reply, forward, create an event from a message | `google_gmail_search`, `google_gmail_read`, `google_gmail_send`, `google_gmail_draft`, `google_gmail_modify` |
| **Calendar** | Agenda, event details, new event with a live clash warning, meeting brief | `google_calendar_agenda`, `google_calendar_check_availability`, `google_calendar_create_event` |
| **Drive** | Recent files, search, filter by Docs, Sheets or Folders, file details, new folder, move files into a folder | `google_drive_search`, `google_drive_create_folder`, `google_drive_move` |
| **Docs** | List and search, read text, create, append text | `google_docs_read`, `google_docs_create`, `google_docs_append` |
| **Sheets** | List and search, preview a range, create a sheet, add rows after review | `google_sheets_read`, `google_sheets_create`, `google_sheets_append` |
| **Contacts** | Search, contact details, create a contact after review | `google_contacts_search`, `google_contacts_create` |
| **Cross-app** | Meeting brief, email to event, invoices to Sheet, organise Drive | `google_meeting_brief`, `google_email_to_event`, `google_invoices_to_sheet`, `google_organize_drive` |
| **Settings** | What Hermes can reach, live connection status, sign-in and sign-out commands | none |

### Not implemented yet

These are missing, in the UI, as Hermes tools, or both:

- **Gmail:** editing existing drafts; downloading attachments; a forward tool for Hermes (the UI's Forward opens a pre-filled compose window).
- **Calendar:** editing, rescheduling, cancelling or deleting events; RSVP.
- **Drive:** upload, download, rename, sharing changes; a tool that reads a file's contents (Docs and Sheets have their own read tools).
- **Docs:** updating, find-and-replace, and a metadata tool; formatting.
- **Sheets:** updating a cell or range, creating a tab, a metadata tool; formatting.
- **Contacts:** reading one contact by ID, updating, deleting.
- **Account:** disconnecting inside the app (sign-out is a terminal command); more than one Google account.
- **Services:** Slides, Tasks and Forms are not built, and their feasibility has not been investigated.

## Install

Requirements: Hermes Agent **v0.22.3 or newer**. The manifest sets `requires_hermes: ">=0.22.3"`: v0.22.3 is the first stable release that has the plugin sign-in code and the desktop SDK names the plugin imports. The validator was run on v0.22.7. Hermes Desktop (tested on macOS), Python 3.13 for the test suite, and a Google account.

### 1. Create a Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
2. **APIs & Services → Library:** enable the **Gmail API**, **Google Calendar API**, **Google Drive API**, **Google Docs API**, **Google Sheets API** and **People API**.
3. **OAuth consent screen (Google Auth Platform):** set up the app details. While the app is in *Testing*, add your own Google account as a test user.
4. **Clients → Create client → Desktop app.** Copy the client ID and client secret.

Add them to the environment file of the Hermes profile you use. That is `$HERMES_HOME/.env`: the default profile's home is `~/.hermes`, and a named profile's is `~/.hermes/profiles/<name>`.

```
GOOGLE_WORKSPACE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_WORKSPACE_CLIENT_SECRET=…
```

Never commit these values. `.gitignore` already excludes `.env`, `*.env`, `google_token.json`, `google_client_secret.json` and `client_secret*.json`.

### 2. Install the plugin

Once the plugin is published in the catalog, you can install it by name or Git URL:

```bash
hermes plugins install <catalog-name-or-git-url>
```

From a local checkout, copy the plugin files (not `.venv/` or `tests/js/node_modules/`) into your profile's plugins directory, then enable it:

```bash
mkdir -p "$HERMES_HOME/plugins/google-workspace"
cp -R /path/to/google-workspace-hermes/{plugin.yaml,__init__.py,hermes_google_workspace,dashboard,desktop} "$HERMES_HOME/plugins/google-workspace/"
hermes plugins enable google-workspace
```

Then reload desktop plugins from the command palette: press ⌘K and choose **Reload desktop plugins**. The sidebar gets a **Google Workspace** entry.

### 3. Sign in

Sign-in runs in a terminal, not inside the plugin. Hermes opens your browser (add `--no-browser` to print the link instead), asks for the permissions below, and stores and refreshes the grant itself.

```bash
hermes auth add google-workspace:google
hermes auth status google-workspace:google
```

Open **Google Workspace → Settings**. It checks Google live and shows each service as ready or not. If a check fails, the error offers **Check again**.

Sign out with `hermes auth logout google-workspace:google`. After you revoke access, sign in again with the `add` command.

## Permissions

The plugin requests exactly these scopes (`plugin.yaml`, pinned by `tests/python/test_manifest.py`):

| Scope | Used for |
|---|---|
| `gmail.modify` | Read mail; mark read or unread, star, archive. It includes read access, so `gmail.readonly` is not requested. |
| `gmail.send` | Send mail, after your approval |
| `gmail.compose` | Create and update drafts |
| `calendar.events` | Read the agenda, check for clashes, create events and send invitations after approval |
| `drive` | Search and read files, create folders, move files after approval. The narrower `drive.file` would hide files you already have. |
| `documents` | Read Docs; create and append text after approval |
| `spreadsheets` | Read Sheets; create and add rows after approval |
| `contacts` | Read and search contacts; create a contact after approval. Creating needs write access, and no narrower scope exists. |

The broad `https://mail.google.com/` scope is never requested. You can review or revoke access at any time under [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

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

The approval message names what will change (recipients, title, row count). The approval code does not read or quote email bodies. On the plugin's side, consequential write endpoints refuse requests without `confirm: true`. The desktop UI sends that flag only after you press confirm in a review dialog.

## Tool reference

All tools belong to the `google_workspace` toolset. A tool returns `{"ok": true, "data": …}` on success. On failure it returns `{"ok": false, "error": {"code", "message"}}`, plus a `hint` when one exists.

| Tool | Arguments | Purpose |
|---|---|---|
| `google_search` | `query`, `max_results?` | One query across Gmail, Calendar and Drive. Each result is labelled with its service. |
| `google_gmail_search` | `query?`, `max_results?`, `include_spam_trash?` | Gmail search with Gmail's query syntax, for example `from:ana newer_than:7d has:attachment` |
| `google_gmail_read` | `message_id`, `thread?` | One message's headers and text body, or the whole thread |
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
| `google_sheets_append` | `spreadsheet_id`, `rows`, `range?` | Add rows after the last row (at most 500 per call). **Asks first.** |
| `google_contacts_search` | `query?`, `max_results?` | Search by name, email or phone; with no query, recent contacts |
| `google_contacts_create` | `name`, `email?`, `phone?`, `organization?`, `title?` | New contact. **Asks first.** |
| `google_meeting_brief` | `event_id?`, `query?`, `days?`, `save_to_docs?` | Event, attendees, recent threads, shared files, suggested agenda. Saving a Doc **asks first.** |
| `google_email_to_event` | `message_id`, `start?`, `duration_minutes?`, `confirm?` | Propose an event from an email; creates it only with `confirm`. **Asks first.** |
| `google_invoices_to_sheet` | `query?`, `spreadsheet_id?`, `days?`, `max_results?`, `confirm?` | Preview invoice emails and their attachments; with `confirm`, add rows to a sheet. Rows already in the sheet are skipped. **Asks first.** |
| `google_organize_drive` | `query`, `folder_name`, `max_files?`, `parent_folder_id?`, `confirm?` | Preview files matching a query; with `confirm`, create the folder and move them. **Asks first.** |

## Cross-app workflows

- **Meeting brief.** Pick a meeting. The brief collects its attendees, your recent threads with them, Drive files they share with you, and a suggested agenda. Saving it creates a Google Doc, after approval.
- **Email to calendar.** From a message, use **Create event**. Hermes proposes a date, time and attendees, checks your calendar for clashes, and creates the event only after you confirm.
- **Invoices to Sheet.** Finds invoice and receipt emails with attachments. The preview shows the amount Hermes read and whether it found one. Missing amounts stay empty, and nothing is invented. Repeat runs skip invoices already in the sheet.
- **Organise Drive.** Previews the files that match, then creates one folder and moves them, after confirmation.

Amounts come from the email's subject and body text. Check them before you rely on them. They are a draft, not an accounting record.

## Security

- **Hermes owns the OAuth flow and the grant.** The plugin never stores or returns the client secret, and the settings check reports only whether each value is set. The plugin's REST calls go through Hermes's credentialed request bridge, which attaches the Google credential only for HTTPS requests to the hosts declared in `plugin.yaml`.
- **Secrets stay out of the repository.** `.gitignore` excludes `.env` and credential JSON files.
- **Writes are gated twice.** Hermes asks you before an approval-gated tool runs (the `pre_tool_call` hook), and the plugin's consequential write endpoints refuse requests without `confirm: true`. Drafts and reversible label changes are exempt by design.
- **Email HTML is not rendered.** Messages are shown as text. The desktop UI has no HTML rendering path, so scripts and remote content in email do not run.
- **Narrow scopes**, as listed above. A test fails if the grant changes without a deliberate edit.
- **No self-updating code.** The plugin does not replace its own files.

## Architecture

```
desktop/plugin.js               Desktop UI (plain ESM, Hermes SDK only; no build step)
  │  ctx.rest('/…')             scoped to /api/plugins/google-workspace
dashboard/plugin_api.py         FastAPI routes: read endpoints and confirmed writes
  │
hermes_google_workspace/
  client.py                     HTTP, retries, error mapping, Hermes credentialed bridge
  services.py                   Gmail, Calendar, Drive, Docs, Sheets, Contacts
  workflows.py                  cross-app: brief, email to event, invoices, organise Drive
  tools.py                      the 24 Hermes tool schemas and handlers
  hooks.py                      pre_tool_call approval policy
__init__.py                     register(ctx): tools and hook
```

Workflows call the services module and never call Google directly. Each service is one module, so a new Google service needs a module, its routes, its tools and its tab.

## Testing

```bash
# Python: 131 tests, no network. Use Python 3.13.
python3.13 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/python

# Desktop UI: 15 tests under jsdom, against an SDK stand-in.
cd tests/js && npm install && npm test

# Lint the desktop file for unresolved names and dead code.
cd tests/js && cat ../../desktop/plugin.js | node node_modules/eslint/bin/eslint.js \
  --config eslint.config.mjs --stdin --stdin-filename plugin.js

# Hermes plugin checks, from the repository root.
hermes plugins validate .
hermes plugins doctor .
```

What the tests cover:

- **HTTP layer:** reads retry on server errors, rate limits and network failures. Writes retry only on HTTP 429 (rate limit). They never retry after a server error or a network failure, when the outcome is unknown. Also covered: missing permissions (named in the error), file-level 403s, unauthorised responses (sign in again), missing sign-in (shown as not connected), and refused origins.
- **Services:** time zones, including daylight saving; calendar clash checks skip cancelled and declined events; Gmail header injection is neutralised; Sheets appends are capped at 500 rows and empty cells are blanked; contact validation; invoice de-duplication.
- **Workflows:** previews write nothing; amounts are never invented; email proposals report clashes; the brief gathers evidence from all three services; saving a brief asks first.
- **Contract:** the exact tool set, in one toolset; the approval classification; the manifest's scopes.
- **API:** consequential write routes refuse requests without `confirm`, and `confirm` must be `true`, not merely present.
- **UI (jsdom):** registration; the connect gate (no account data is fetched before sign-in); lazy tabs; keyboard tab navigation; review-then-confirm for sheet rows, with cancel; contact validation; reversible star; permission errors in plain language; cross-service search; the calendar clash warning; a success notice after an append; no hard-coded colours; every write call sends `confirm: true` except drafts and reversible label changes.

Two deliberate breakages were tested and caught by the suite: removing `confirm: true` from the Sheets append, and making the review button write without review. Both made tests fail. The plugin file was restored byte-for-byte afterwards.

**Not covered by any test:** dark and light appearance, responsive layout, keyboard focus order beyond tab navigation, screen-reader behaviour, and real Google calls.

## Live check: what to run with your own account

The automated suite cannot prove Google accepts these calls. Run this once, in a test Google account, before you rely on the plugin:

1. Sign in (`hermes auth add google-workspace:google`) and confirm Settings shows every service as ready.
2. Overview: search for a word that appears in a test message, a test event and a test document. Results should appear under Gmail, Calendar and Drive.
3. Gmail: open a test message, press **Star**, then **Unstar**. Confirm the change in Gmail.
4. Sheets: create a test sheet, add two rows, confirm in the review dialog, and check the rows in Sheets.
5. Contacts: create a test contact with an email address you control, and check it in Google Contacts.
6. Hermes chat: "Prepare a meeting brief for my next meeting", approve the Doc, and open it.

Report any step that fails, with the message shown in the UI. A permission error names the missing permission; sign in again to grant it.

## Limitations

- **Unverified against Google.** See the status note at the top. Google's own errors (quotas, disabled APIs, verification) are shown as received.
- **Not run inside Hermes Desktop.** Discovery, registration and validation were checked in an isolated profile. The desktop UI has been tested in jsdom only.
- **Sign-in is terminal-only.** Plugins have no in-app sign-in, sign-out or disconnect in Hermes today, so the plugin shows the commands and checks the result.
- **One Google account per Hermes profile.**
- **Scopes need verification for public use.** `gmail.modify`, `gmail.send`, `gmail.compose`, `drive` and `contacts` are sensitive or restricted scopes. A public release needs Google's app verification. While the consent screen is in *Testing*, only listed test users can sign in.
- **Missing features:** see [Not implemented yet](#not-implemented-yet).
- **Gmail HTML** is shown as plain text.
- **Invoice amounts** come from text heuristics and must be checked.
- **No screenshots** yet. They should come from a run with a test account.
- **No LICENSE file yet.** `plugin.yaml` declares MIT. Add a LICENSE file before any public release.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Connect Google Workspace" stays on screen | Check that `GOOGLE_WORKSPACE_CLIENT_ID` and `GOOGLE_WORKSPACE_CLIENT_SECRET` are set in the profile's `.env`, then restart Hermes Desktop. Run `hermes auth status google-workspace:google`. |
| A service shows a permission message | Sign in again to grant the missing scope: `hermes auth add google-workspace:google`. |
| A 403 that is not a permission message | Google's message names the API or file. If it says an API is not enabled, enable it in Google Cloud Console (step 1). |
| "Could not reach Google" | Check the network. Reads retry automatically. Writes do not, so check the result before you retry them. |
| The sidebar entry is missing | Run `hermes plugins list`, enable the plugin with `hermes plugins enable google-workspace`, then reload desktop plugins (⌘K). |

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
catalog/                        draft catalog entry (not submitted)
DEMO.md                         demo script (not recorded)
```

## Licence

Declared as MIT in `plugin.yaml`. No LICENSE file is included yet; see [Limitations](#limitations).

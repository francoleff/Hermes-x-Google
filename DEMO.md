# Demo script: Google Workspace for Hermes (under 90 seconds)

**Status: not recorded.** Record only after the [live check](README.md#live-check-what-to-run-with-your-own-account) passes with a test account. Use a test mailbox, test calendar and test documents, not personal data. Do not invite anyone real; keep the demo invitation to an address you control.

## Shot list

| Time | On screen | Narration (about) |
|---|---|---|
| 0–10 s | Hermes Desktop. Click **Google Workspace** in the sidebar. The account name and the six services show as Ready. | "Google Workspace lives in the Hermes sidebar, with my account connected." |
| 10–25 s | Overview: type a project name in the search box and press Enter. Results come back labelled Gmail, Calendar and Drive. | "One search covers mail, meetings and files. Each result says where it came from." |
| 25–40 s | Open a test message, then Calendar, and show the next meeting. | "Each service opens in its own tab, with the detail I need." |
| 40–65 s | Return to the Hermes chat. Type: *"Prepare me for my meeting with James tomorrow. Find the relevant emails, documents and earlier meetings, then make a briefing in Google Docs."* Hermes calls the tools. Show the approval prompt for the Doc, then approve. | "Hermes works across the three services in one task. It asks before it creates anything." |
| 65–80 s | Open the new Google Doc: attendees, recent threads, files, suggested agenda. | "The briefing is in Docs, with links back to each source." |
| 80–90 s | Title card: **Google Workspace for Hermes**. Caption: "Your Google Workspace. One place. Connected to Hermes." | — |

## Before recording

- Run the automated checks: `cd tests/js && npm test` and `.venv/bin/python -m pytest tests/python`.
- Run the [live check](README.md#live-check-what-to-run-with-your-own-account) against the test account.
- Clear notifications and unrelated windows. Use a light theme and a dark theme take for the gallery.
- Check that every shown name, address and amount belongs to the test data.

## Caveats to say out loud, if asked

- Amounts in invoice rows come from email text and must be checked.
- Sign-in runs in a terminal with `hermes auth add`, not inside the app.

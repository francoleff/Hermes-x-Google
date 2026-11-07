# Brag plan — Google Workspace for Hermes

**Input:** project `~/workspace/google-workspace-hermes` (Hermes plugin, v0.1.0).
**Format:** landscape 1920×1080, 30 fps, 24.75 s. **Tone:** polished / app-store hybrid — the clean "SaaS launch on X" look: big confident type, a floating app window, cursor-driven UI, every cut on the downbeat.

## Rubric
- **What is it?** A Hermes plugin that puts Gmail, Calendar, Drive, Docs, Sheets and Contacts in the Hermes Desktop sidebar and gives the Hermes agent 38 tools across them.
- **For whom / what it does:** Hermes users who live in Google Workspace — one page and one search instead of six tabs; the agent can do cross-app jobs ("prepare me for my meeting with James tomorrow").
- **What sets it apart:** cross-app workflows (meeting brief, email → event, invoices → Sheet, organise Drive) + a strict approval model: nothing sent, shared or created until you approve.
- **Most impressive claim:** 38 tools; one prompt → calendar + Gmail + Drive → a briefing Doc, gated by approval.
- **Visual hook:** six Google app tabs piling up, then collapsing into one Hermes sidebar entry. Real copy: *"Your Google work, without the tab hunt."*
- **Real UI to show:** the Overview page (stat cards, Today and tomorrow, Workflows "The cross-app part"), the global search, a Hermes chat with tool calls, the approval prompt (exact hook text), the meeting-brief Doc (real section headings from `workflows.py`).
- **Share caption:** "Your Google work, without the tab hunt."

## Source truth / fidelity notes
- The desktop UI imports `@hermes/plugin-sdk` and cannot render outside Hermes, so it is **rebuilt in HTML** using the plugin's real copy, layout (stat cards, tab bar, workflow cards) and Hermes Desktop's real light-theme tokens (`#f8faff` bg, `#0053fd` primary, `#17171a` text).
- Approval text is verbatim from `hooks.py`: "Google Workspace wants to create a briefing document in your Drive." + "Meeting: …".
- Brief Doc headings verbatim from `workflows.py` (Attendees, Suggested agenda, Recent threads, Related files, footer line).
- **All names, subjects and files are fictional stand-ins** (James Park, "Acme launch sync", etc.). No real account data.
- Assets: official Google product icons (Wikimedia Commons), Hermes logo + banner from the hermes-agent repo, Google Sans Flex + JetBrains Mono (Google Fonts, OFL).

## Music
"Happy Beats / Business Moves Vol. 11" — Sascha Ende, ende.app (CC BY 4.0), bundled with /brag. 114.84 BPM, beat = 0.5225 s, bar = 2.09 s. Downbeats (from cue preset): 1.60, 3.70, 5.80, 7.91, 10.01, 12.12, 14.22, 16.34, 18.44, 20.54, 22.65, 24.75. Every scene cut lands on one. Track trimmed to 24.75 s with a 1.2 s fade.
SFX (bundled library, mixed ~14 dB under music, on the 8th/16th grid): soft UI clicks for cursor clicks, keypresses for typing, soft drops for cards landing.

## Storyboard
| # | Time | Scene | On screen | SFX |
|---|---|---|---|---|
| 1 | 0.00–3.70 | **Hook** | Six Google app tabs (Gmail, Calendar, Drive, Docs, Sheets, Contacts) pop in on 8th notes and pile up. On the 1.60 drop they collapse into one row; headline "Your Google work, without the tab hunt." | drops on each tab, impact on 1.60 |
| 2 | 3.70–7.91 | **Reveal** | Hermes Desktop window rises (3D tilt → flat). Caption "Google Workspace for Hermes". Cursor clicks the sidebar entry; Overview skeletons resolve into stat cards, agenda and the Workflows "cross-app part". | click |
| 3 | 7.91–12.12 | **Highlight 1 — search** | Camera pushes into the search field. Types "Acme launch" on 16ths, Enter on 10.01; results drop in labelled Gmail / Calendar / Drive. Caption "One search. Mail, meetings and files." | keypresses, click |
| 4 | 12.12–16.34 | **Highlight 2 — agent** | Hermes chat. User: "Prepare me for my meeting with James tomorrow." Tool calls tick in on beats: google_calendar_search, google_gmail_search, google_drive_search, google_meeting_brief. Caption "38 tools. Hermes works across all of them." | soft ticks |
| 5 | 16.34–20.54 | **Highlight 3 — approval** | Approval card (verbatim hook text). Cursor clicks Approve on 17.39. On 18.44 the Google Doc "Brief: Acme launch sync" slides in. Caption "Reads are automatic. Sends and shares wait for you." | click, drop |
| 6 | 20.54–24.75 | **Outro** | Dark end card: Hermes logo + six icons, "Google Workspace for Hermes", "Gmail · Calendar · Drive · Docs · Sheets · Contacts", "38 tools · every write approved by you". Credits line. | impact on 20.54 |

Sum: 3.70 + 4.21 + 4.21 + 4.22 + 4.20 + 4.21 = 24.75 s.

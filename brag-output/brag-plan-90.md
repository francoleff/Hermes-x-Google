# Brag plan, 90 s cut: Google Workspace for Hermes

Same look as the 25 s cut (light dotted stage, floating Hermes window, Google Sans Flex captions, cursor-driven UI, dark end card). This cut shows more workflows, uses new music, and adds a pop on every element as it appears.

**Format:** 1920×1080, 30 fps, 90.0 s. **Tone:** polished / app-store.

## Music
"Pop Track 03" by Lily J (Mixkit, Mixkit Stock Music Free License; credited anyway). F major, 108.98 BPM, fitted to the onset envelope (median error 6 ms).
The track starts at 2.0 s into the file, so its intro build plays under the tab pile-up. The first downbeat lands at 2.468 s (the drop), and the track's own ending falls at 90 s.
Beat n is at `B(n) = 2.4684 + n × 0.55055`. Every scene boundary is on a bar line (every 4 beats).

## SFX
Mixkit sound effects (Mixkit Free License). The composition registers a sound at every element entrance, so the cue list is generated from the same timings as the visuals.
- **pop:** "Soap bubble sound", pitched to the F-major pentatonic (C D F G A). Sequences climb the scale, like the ChatGPT and Grok launch videos.
- **tick:** "Message pop alert", for list rows.
- **card:** "Dry pop up notification alert", for dialogs.
- **click:** "Modern technology select", for cursor clicks.
- **keys:** keypress samples from the /brag library, for typing.
- **whoosh:** "Air woosh", for window moves.
- **confirm:** "Digital quick tone" (C5, the fifth of F), for approvals.
- **impact:** "Movie whoosh impact presentation", for the end card.

The SFX bus is low-passed at 9 kHz and given a small room reverb, and sits under the music.

## Storyboard (beats → seconds)
| # | Beats | Time | Scene | Real plugin copy used |
|---|---|---|---|---|
| 1 | –4…8 | 0–6.9 | Hook: six Google tabs pile up and collapse on the drop. Headline: "Your Google work, without the tab hunt." | Overview subtitle |
| 2 | 8–20 | 6.9–13.5 | Hermes window rises; the cursor clicks Google Workspace and the Overview loads. | stat cards, Workflows "The cross-app part" |
| 3 | 20–28 | 13.5–17.9 | Global search for "Acme launch"; results labelled Gmail / Calendar / Drive. | |
| 4 | 28–36 | 17.9–22.3 | Gmail tab: open a message, star it, actions row. | |
| 5 | 36–48 | 22.3–28.9 | Email → event: the proposed time clashes ("Overlaps 1 event: Hiring loop"), is changed to 15:00 ("Free at that time."), then "Create event and invite guests?" and "Create and invite". | dialog strings from `desktop/plugin.js` |
| 6 | 48–56 | 28.9–33.3 | Calendar tab: agenda with the new event; RSVP Going, then "Reply “Going” to “Quarterly planning”?", then "Reply sent: Going." | RSVP strings |
| 7 | 56–76 | 33.3–44.3 | Hermes chat: meeting brief, four tool calls, the approval prompt, then the briefing Doc. | `hooks.py`, `workflows.py` headings |
| 8 | 76–88 | 44.3–50.9 | Invoices → Sheet: preview of 4 invoices (one with no amount, left empty), "Write these rows to Google Sheets?", then a Sheet with Date / From / Subject / Amount / Currency / Attachment. | workflow strings, column names |
| 9 | 88–100 | 50.9–57.5 | Organize Drive: find "Acme", preview 6 files, "Move 6 files?", files fly into the "Acme launch" folder. | organize strings |
| 10 | 100–116 | 57.5–66.3 | Chained ask: forward to Lena, add her to the event, share the plan. Three approval prompts (forward / change event / share), each approved in turn. | `hooks.py` approval text format |
| 11 | 116–128 | 66.3–72.9 | Tool wall: all 38 tool names; the 23 approval-gated ones light up. | `plugin.yaml`, `hooks.py` |
| 12 | 128–140 | 72.9–79.5 | Trust: `hermes auth add google-workspace:google`; Settings shows six services Ready with their real permission descriptions. | Settings strings |
| 13 | 140–148 | 79.5–84.0 | Recap: eight capabilities stack in on the beat. | |
| 14 | 148–end | 84.0–90.0 | End card. | |

All people, emails, IDs, files and amounts are fictional stand-ins. CLI output in scene 12 is illustrative.

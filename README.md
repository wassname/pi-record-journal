# @wassname2/pi-record-journal

<!-- Drafted by PI/Claude; journal text moved from pi-annotated-journal. -->
Save your long Pi messages to a Markdown journal, per session, only with consent.

```bash
pi install /absolute/path/to/pi-record-journal   # not yet on npm
```

```text
/journal-settings auto on|off   # this session only
```

Off by default. The first message with at least 3 non-empty, unquoted lines asks whether to save long messages from this session to `docs/human_journal.md`. Change the path with `PI_RECORD_JOURNAL`; relative paths resolve from Pi's working directory.

In a Git repository, Pi then offers to add the journal to `.gitignore` (default: ignore). If the journal is already ignored or tracked, Pi only shows a reminder. Unanswered dialogs count as "no" after 60 s.

Each entry is a timestamp, the session ID and your message as a Markdown quote:

```markdown
## 2026-11-17T01:50:00.000Z · User message

Saved by pi-record-journal · session `01a1e6d6-…`

> first line
> second line
> third line
```

Sections that `/annotate` from `pi-annotated-journal` adds (`## Annotate assistant message` and everything after) are not saved: they are mostly Pi's own text and are already in `.pi/last_msg_log.md`. Text you typed before them is saved.

The choice is stored in the session and survives `/reload` and resume. New sessions and forks start off.

## Development

```bash
npm ci --ignore-scripts
npm run check
```

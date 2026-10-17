---
description: Wrap up the brainstorm session. Saves a session note with where we are, decisions, open questions, rejected ideas, and one next step, and exports the board.
argument-hint: "[project]"
---

# Wrap

Thin entrypoint over the `brainstorm-with-me` skill. Template is in
`skills/brainstorm-with-me/references/session-notes.md`.

## Steps

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" pending` to collect any board input not yet handled. Handle it first.
2. Make sure every decision, open question, and rejected idea from this
   session is saved (`decide`, `question`, `reject`). Save any that are
   missing.
3. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" status --project <p>` for the board rev.
4. Write the wrap note from the template to a temp file, then
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" wrap --project <p> --file <file>`.
5. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" export --project <p>` to refresh `board.canvas`. Add
   `--mermaid` only if the user asked for a mermaid note (writes
   `board-diagrams.md`).
6. Tell the user the next step in one line. If a board is running, leave it unless
   they ask; `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" stop` shuts it down.

---
description: Open the optional browser board and draw on it. Shows everything drawn so far, then Claude draws the current idea and waits for your edits.
argument-hint: "[what to draw]"
---

# Board

Thin entrypoint over the `brainstorm-with-me` skill. This is the only command that
opens the browser. Spec format and layout tips are in
`skills/brainstorm-with-me/references/board-protocol.md`.

## Steps

1. Use the active project. If unclear, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" status` and pick the one in
   use, or ask.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" open --project <p>` (safe to repeat; it reuses a running board). Board
   state already holds every earlier `draw`, so past diagrams show up.
3. Decide what to draw from $ARGUMENTS, or from the recent conversation if
   empty. Nothing new to draw is fine; skip to step 6.
4. Flows and architectures: a mermaid `.mmd` file. Loose ideas: sticky notes
   in a JSON spec. Write it to a temp file, then
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" draw --project <p> --spec <file>`.
5. If the validator rejects it, fix and draw again. Mention any
   `skippedLocked` or `suggestions` from the report in one line.
6. Start `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" await --project <p>` with the Bash tool and
   `run_in_background: true`, and keep one running while the board is open.
7. Yield: the board URL and one line on what to look at.
8. If the user asks for a mermaid note of the board, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" export --project <p> --mermaid` (writes `board-diagrams.md` next to
   `board.canvas`). Do not pass `--mermaid` otherwise.

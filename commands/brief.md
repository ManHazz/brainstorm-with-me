---
description: Show or edit the concept brief for a brainstorm project, one section at a time, and run a drift check.
argument-hint: "[section] [new text]"
---

# Brief

Thin entrypoint over the `brainstorm-with-me` skill. Sections and the drift check are
in `skills/brainstorm-with-me/references/brief-template.md`.

## Steps

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" brief --project <p>` to read the current brief.
2. If $ARGUMENTS names a section (Objective, Scope, Non-goals, Success metric,
   Kill criterion), draft the new text for that section only, show it, and on
   approval run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" brief --project <p> --section "<Section>" --text "<text>"`.
3. If no arguments: show the brief briefly, point out empty sections, and run
   the drift check (max 3 flags).
4. Never rewrite the whole brief. One section per call.
5. If the CLI reports `merged` or `conflict`, tell the user. On conflict, ask
   which version to keep.

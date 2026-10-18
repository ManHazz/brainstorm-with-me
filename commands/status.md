---
description: Show brainstorm status. Board state, pending board input, and counts of decisions, open questions, and rejected ideas.
argument-hint: "[project]"
---

# Status

Thin entrypoint over the `brainstorm-with-me` skill.

## Steps

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwm.js" status` (add `--project <p>` if $ARGUMENTS names one).
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwm.js" pending` to check for board input that was never delivered. If there
   is any, handle it as board input (quote `user_said` verbatim).
3. Report in a few lines: vault folder path, board running or not (and its URL if it is), board
   rev, counts of decisions, open questions, rejected ideas, and the date of
   the last wrap.
4. Never open the board from here. If the board is already open and no await
   is running, start `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwm.js" await --project <p>` in the background.

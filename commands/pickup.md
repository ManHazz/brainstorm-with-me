---
description: Pick up an earlier brainstorm. Loads the last wrap, brief, and open questions, checks for drift, and says where we are and what is next.
argument-hint: "[project]"
---

# Pickup

Thin entrypoint over the `brainstorm-with-me` skill. Procedure is in
`skills/brainstorm-with-me/references/session-notes.md`.

## Steps

1. Project from $ARGUMENTS. If empty, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwm.js" status` and use the most
   recent project, or ask if there are several.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwm.js" pickup --project <p>`: latest wrap, brief, open questions.
3. Run the drift check from `skills/brainstorm-with-me/references/brief-template.md` (max 3 flags).
4. Do not open the board. If the user asks for it, use
   `/brainstorm-with-me:board`.
5. Reply with exactly two lines, plus drift flags only if any:

   ```
   Where we are: <one sentence>.
   What is next: <next step or top open question>.
   ```

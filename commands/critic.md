---
description: Get an honest critique of an idea from the idea-critic agent, scored on novelty, feasibility, timing, and competition, and save it to the vault.
argument-hint: "[idea or project]"
---

# Critic

Thin entrypoint over the `brainstorm-with-me` skill. Rubric and template are in
`skills/brainstorm-with-me/references/critic-rubric.md`.

## Steps

1. Pick the idea: $ARGUMENTS, or the active project. Slug it for `<idea>`.
2. Gather context: `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwm.js" brief --project <p>` and the open questions. Keep it to
   what the critic needs.
3. Spawn the `idea-critic` agent with the idea, the brief, and the key
   constraints (solo final year student, timeframe). Ask for the markdown
   critique only.
4. Check the result against the rubric: all four scores, strongest objection
   present, no praise adjectives, evidence on any 4 or 5, refine names the
   exact change, park names a revisit condition. If something is missing, ask
   the agent once to fix it.
5. Write the critique to a temp file and run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwm.js" critique-save --project <p> --idea "<idea>" --file <file>`.
6. If the verdict is `park`, also run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwm.js" reject --project <p> --text "<idea>" --reason "Parked by critic. Revisit when: <condition>"`.
7. Show the user the verdict, the scores, and the strongest objection. Do not
   soften it.

---
description: Start a brainstorm on a project in the terminal. Sets up the project in the vault folder and drafts a first picture of the idea. No browser needed.
argument-hint: "<project-name> [objective]"
---

# Start

Thin entrypoint over the `brainstorm-with-me` skill. Follow that skill for the full
loop and rules. Everything here works in the terminal; do not open the board
unless the user asks for it.

Project: first word of $ARGUMENTS, turned into a slug. The rest, if any, is the
objective. If no project was given, ask for a name (one question).

## Steps

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" status --project <p>`
   - If the project already exists, switch to the pickup procedure
     (`/brainstorm-with-me:pickup`) instead.
   - The vault folder needs no setup (default `~/Documents/brainstorm-vault`,
     created on first use). Do not ask about it. Mention where it is once.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" init --project <p> --objective "<objective>"` (leave out
   `--objective` if none was given).
3. If there is an objective, draw a small first picture: write a `.mmd` file
   with the objective and 2 to 4 open questions around it, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" draw --project <p> --spec <file>`, and show the same mermaid block in
   your reply. If there is no objective, ask the one question that pins it down
   (see `skills/brainstorm-with-me/references/ideation-rules.md`).
4. Tell the user in one line that `/brainstorm-with-me:board` opens a
   live board if they want to move and edit things in a browser.

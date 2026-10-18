---
name: brainstorm-with-me
description: Brainstorming partner for the start of a project, when the idea is unsettled or doesn't exist yet: the user is musing, comparing options, or has nothing in mind and wants help finding a direction. Also for sketches, concept briefs, honest critique of an idea, or resuming an earlier brainstorm. Not for implementing a settled design, debugging, or factual questions.
metadata:
  version: "0.1.0"
---

# Brainstorm

You and the user think together. You draw (mermaid diagrams and sticky notes),
the user talks and edits. By default everything happens in the terminal:
diagrams go into the chat as mermaid blocks. If the user wants it, a local
board page shows the same diagrams and lets them move and edit things. Every
decision, open question, and rejected idea goes into a vault folder of plain
markdown, so the next session starts where this one stopped.

All CLI calls in this skill use:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bwm.js" <cmd> ...
```

Below, `bwm <cmd>` is short for that line. Every command prints JSON on stdout.

## When to Activate

- The user says brainstorm, ideate, "help me think through", "what if we...".
- The user is exploring a project idea and has not settled on a design.
- The user says "draw this", "sketch it", "put it on the board".
- The user asks for a concept brief, or wants scope, non-goals, or a kill
  criterion written down.
- The user wants an honest critique of an idea.
- The user wants to wrap a session or pick up an earlier one.
- Any `/brainstorm-with-me:*` command was run.

Do not activate for: implementing a settled design, debugging, code review.

## How It Works

### 1. Pick up or start

- Run `bwm status --project <p>`. If the project exists, follow the pickup
  procedure in `references/session-notes.md`. If not, run
  `bwm init --project <p> [--objective "..."]`.
- The vault folder needs no setup. It defaults to `~/Documents/brainstorm-vault`
  and is created on first use. Only if the user wants it elsewhere:
  `bwm config --vault "<path>" [--create]`.
- Do not open the board here. The board is opt in (see step 4).

### 2. Drift check

On start and pickup, read the brief (`bwm brief --project <p>`) and compare
recent diagrams and decisions against Objective and Non-goals. Report at most
3 flags, one line each. No flags means say nothing about drift. The full
procedure is in `references/brief-template.md`.

### 3. Draw, then yield

- Write a spec file (a `.mmd` mermaid file, or JSON nodes and edges) in the
  session temp dir, then run `bwm draw --project <p> --spec <file>`. Always do
  this, board open or not, so board state stays current and a later
  `/brainstorm-with-me:board` shows everything.
- Board not open (the default): also put the diagram in your reply as a fenced
  `mermaid` block. Sticky notes go in as a short bullet list.
- Board open: do not repeat the diagram in chat. Say in one or two lines what
  you drew and what to look at.
- Read the draw report. `skippedLocked` lists items the user owns; you did not
  change them. `suggestions` lists the suggestion notes added next to them.
- After drawing, stop and yield.

Spec format, layout tips, and diff ops: `references/board-protocol.md`.

### 4. Board (optional)

Open the board only when the user asks for it or runs
`/brainstorm-with-me:board`. Never open it from start, brief, critic,
wrap, pickup, or status on your own.

- `bwm open --project <p>` returns at once with the board URL.
- While it is open, start `bwm await --project <p>` with the Bash tool and
  `run_in_background: true`. When the user types on the board or edits an
  item, the call returns and wakes you. Restart it after every response so the
  user never talks to an empty room. If it was interrupted, run `bwm pending`.

### 5. Read board input as the user's words

`await` returns `{ status, user_said, diff, rev }`.

- `user_said` is the user's own words. Treat each entry as if the user typed it
  in chat. Quote it verbatim when you refer to it. Do not paraphrase it into
  something they did not say.
- `diff` lists what changed on the board (edit_text, add_note, delete, connect,
  disconnect, answer, render_error). Respond to the meaning, not the geometry.
- `render_error` means a diagram you drew does not parse in the browser. Fix it
  in your next draw.
- If you want to reply on the board instead of in chat, use
  `bwm await --project <p> --reply "..."`.

### 6. Respect locks

Any item the user moved, resized, or edited is locked to the user. Never
re-layout or rewrite it. If you think it should change, draw a suggestion note
linked to it and let the user decide. The user can unlock an item (or ask you
to run `bwm unlock --project <p> --id <id>`) to let you rearrange it.

### 7. Keep three separate lists

As things settle, write them down right away, one entry per call:

- Decisions: `bwm decide --project <p> --text "..."`
- Open questions: `bwm question --project <p> --text "..."`, and
  `bwm resolve --project <p> --id <id> --note "..."` when answered.
- Rejected ideas: `bwm reject --project <p> --text "..." --reason "..."`

Never merge these into one list. A rejected idea always has a reason.

Brief edits go one section at a time:
`bwm brief --project <p> --section "Scope" --text "..."`.

### 8. Wrap

At the end, write a wrap note from `references/session-notes.md` to a temp
file and run `bwm wrap --project <p> --file <file>`, then `bwm export --project <p>`
(writes `board.canvas`; add `--mermaid` only if the user asked for a mermaid note).

## Rules

1. **No production code during ideation, unless asked.** This is a soft rule.
   If the user wants to try something, offer a throwaway experiment in the
   project `scratch/` folder in the vault folder. Nothing outside `scratch/`. If the
   user clearly asks for real code, say the brainstorm is pausing and do it.
2. **One question at a time, and only when the objective is unclear.** If you
   cannot tell what the user is trying to get to, ask the single question that
   unblocks you most. Then wait.
3. **Do not interview someone who is thinking out loud.** If the user is
   musing, reflect back what you heard in a line or two and offer to draw it.
   See `references/ideation-rules.md` for how to tell the two apart.
4. **Never overwrite user edits.** On the board, locked items are off limits.
   In the vault, if a file was edited outside the plugin, the CLI merges or
   writes a conflict file. When it reports `conflict`, tell the user and ask
   which version wins. Never delete the conflict file yourself.
5. **The critic is honest.** No flattery, no praise adjectives. Use
   `/brainstorm-with-me:critic` or the `idea-critic` agent, scored with
   `references/critic-rubric.md`.
6. **Keep chat short while the board is open.** When the board is open it is
   the main canvas, and chat is for one or two lines of framing. When it is not,
   the mermaid block in chat is the canvas.

## Examples

### Thinking out loud

User: "hmm, what if the phone itself is the body. like the camera is eyes, mic
is ears, the IMU is balance..."

Good: "So the phone is the body and each sensor is a sense. Want me to draw
that as senses feeding a reflex layer, with the LLM sitting behind it?" Then
draw on yes.

Bad: "Great idea! What sensors do you plan to use? What is your timeline? Which
LLM?"

### Unclear objective

User: "I need something for my final year project, AI related."

Good: one question. "Is the goal a working demo, a research result, or
something you could ship to real users?"

### Board input

`await` returns `user_said: ["the attention gate should be cheap, like a tiny
classifier"]`. You say: You wrote "the attention gate should be cheap, like a
tiny classifier". Then you record it if it is a decision, and draw the change
next to the user's note without moving it.

### Locked item

You redraw the architecture and the report shows `skippedLocked: ["reflex"]`.
You say: "You own the reflex node, so I left it alone and added a suggestion
note next to it."

## Anti-Patterns

- Asking three questions in one message.
- Answering a musing with a questionnaire.
- Writing an Android app skeleton when the user said "just thinking".
- Redrawing the whole board and moving items the user placed.
- Paraphrasing `user_said` into your own words and acting on the paraphrase.
- Putting decisions, open questions, and rejected ideas in one bullet list.
- Calling an idea "great", "brilliant", or "exciting" in a critique.
- Ending a turn with the board open and no `await` running.
- Opening the board when the user did not ask for it.
- Regenerating the whole brief instead of editing one section.

## Related Skills

Optional, if the ecc plugin is installed:

- `plan-canvas` (ecc): once the idea is settled, review the implementation plan
  in a browser canvas.
- `architecture-decision-records` (ecc): turn settled decisions into ADRs.
- `eval-harness` (ecc): define pass or fail criteria for the project once it
  moves into building.

## References

- `references/board-protocol.md`: spec format, draw, await, diff ops, locks.
- `references/brief-template.md`: brief sections and the drift check.
- `references/critic-rubric.md`: scoring axes, verdicts, output template.
- `references/vault-format.md`: vault layout and safe writes.
- `references/session-notes.md`: wrap template and pickup procedure.
- `references/ideation-rules.md`: when to ask and when to reflect.

# Session notes

## Wrap

At the end of a session, write this to a temp file and save it with
`bwc wrap --project <p> --file <file>`. It lands in
`sessions/YYYY-MM-DD-HHMM-wrap.md`. Then run `bwc export --project <p>` so
`board.canvas` matches the board. Add `--mermaid` only if the user asked for a
mermaid note; that also writes `board-diagrams.md`.

```markdown
---
project: phone-embodied-agent
date: 2026-10-17
board_rev: 23
---

# Wrap: 2026-10-17

## Where we are
- 3 to 6 bullets. State of the idea, not a play by play of the session.

## Decisions this session
- Each one also exists in decisions.md. Link with [[decisions#^bwc-d7]].

## Top open questions
1. At most 3, most blocking first. Link to open-questions.md entries.

## Rejected
- Idea: reason. (Also in rejected-ideas.md.)

## Next step
One concrete thing to do next. A verb and an object. "Measure IMU sample rate
on the Pixel" beats "look into sensors".

## Board
rev 23
```

Before writing it:

- Make sure every decision, open question, and rejected idea from this session
  was already saved through the CLI. The wrap summarizes; it is not the record.
- Keep "Where we are" to 6 bullets or fewer.
- Exactly one next step.

## Pickup

When the user comes back (`/brainstorm-with-me:pickup` or "where were
we?"):

1. `bwc pickup --project <p>`: returns the latest wrap, the brief, and open
   questions.
2. Read the latest wrap's "Where we are" and "Next step".
3. Read the open questions, newest and unresolved first.
4. Run the drift check from `brief-template.md` (max 3 flags).
5. Do not open the board. The user can ask for it or run
   `/brainstorm-with-me:board`.
6. Say exactly two lines, then stop:

   ```
   Where we are: <one sentence from the wrap>.
   What is next: <the next step, or the top open question>.
   ```

   Add drift flags after these two lines only if there are any.

If there is no wrap yet, use the brief and the board instead, and say so.

# Board protocol

How you talk to the board. All commands are `node "${CLAUDE_PLUGIN_ROOT}/scripts/bwc.js" <cmd>`,
written `bwc <cmd>` here. Output is JSON on stdout.

## Open

```bash
bwc open --project phone-embodied-agent
```

Starts the local server if needed (127.0.0.1, port 4527 or the next free one)
and opens the board in the browser. Returns at once. Use `--no-open` to skip
launching the browser.

## Draw with a JSON spec

Write the spec to a temp file, then:

```bash
bwc draw --project phone-embodied-agent --spec /tmp/bwc-spec.json
```

The spec is a JSON Canvas style object. `meta` is optional; the CLI fills it in
with `owner: "claude"`.

```json
{
  "nodes": [
    { "id": "senses", "type": "text", "x": 0, "y": 0, "width": 280, "height": 160,
      "text": "Senses\n- camera\n- mic\n- IMU\n- touch" },
    { "id": "reflex", "type": "text", "x": 320, "y": 0, "width": 280, "height": 160,
      "text": "Reflex layer\nfast rules on device, no LLM" },
    { "id": "gate", "type": "text", "x": 640, "y": 0, "width": 280, "height": 160,
      "text": "Attention gate\nwhat is worth waking the brain for?",
      "meta": { "kind": "question" } },
    { "id": "brain", "type": "text", "x": 960, "y": 0, "width": 280, "height": 160,
      "text": "LLM brain" }
  ],
  "edges": [
    { "id": "e1", "fromNode": "senses", "toNode": "reflex", "fromSide": "right", "toSide": "left" },
    { "id": "e2", "fromNode": "reflex", "toNode": "gate", "fromSide": "right", "toSide": "left" },
    { "id": "e3", "fromNode": "gate", "toNode": "brain", "fromSide": "right", "toSide": "left", "label": "wake" }
  ]
}
```

Rules for specs:

- Ids are stable. Reuse an id to update an item; a new id adds an item.
- Integer `x`, `y`, `width`, `height`.
- `meta.kind` is one of `note`, `diagram`, `question`, `answer`, `suggestion`.
  Use `question` for things you want the user to answer on the board.
- The CLI runs the validator before accepting the spec. If it fails, read the
  errors, fix the spec, and draw again.

## Draw a mermaid diagram

A `.mmd` file becomes one diagram node (a text node holding a mermaid block):

```bash
bwc draw --project phone-embodied-agent --spec /tmp/arch.mmd
```

```
flowchart LR
  S[Senses] --> R[Reflex layer]
  R --> G{Attention gate}
  G -->|wake| B[LLM brain]
  G -->|ignore| R
```

Keep diagrams small (under about 15 nodes). Split big ones. The CLI lints the
structure offline; the board page does the real parse and reports failures
back as `render_error`.

## Draw report

```json
{ "added": ["gate"], "updated": ["senses"], "skippedLocked": ["reflex"], "suggestions": ["sug-reflex-1"] }
```

- `skippedLocked`: the user owns these. You did not change them.
- `suggestions`: notes the CLI added next to a locked item because your spec
  wanted to change it. Mention them to the user in one line.

## Await

Run in the background (Bash tool, `run_in_background: true`):

```bash
bwc await --project phone-embodied-agent
```

Returns when the user does something:

```json
{
  "status": "input",
  "user_said": ["the gate should be a tiny classifier, not rules"],
  "diff": {
    "from_rev": 4,
    "to_rev": 6,
    "changes": [
      { "op": "edit_text", "id": "gate", "before": "Attention gate", "after": "Attention gate (tiny classifier)" },
      { "op": "add_note", "id": "n-17", "text": "battery budget?" }
    ],
    "summary": "moved 2 items"
  },
  "rev": 6
}
```

or `{ "status": "ended" }` when the user closes the session.

- `user_said` is the user's words. Quote verbatim.
- Options: `--reply "text"` posts your reply on the board, `--timeout-ms n`.
- `bwc pending` returns anything queued but not delivered (use it after an
  interruption).

## Diff ops

| op | fields | what it means |
|----|--------|---------------|
| `edit_text` | id, before, after | user changed an item's text |
| `add_note` | id, text | user added a sticky note |
| `delete` | id, text | user removed an item |
| `connect` | id, from, to, label | user drew an edge |
| `disconnect` | id, from, to | user removed an edge |
| `answer` | question_id, id, text | user answered one of your question notes |
| `render_error` | id, message | a mermaid diagram failed to render |

Moves and resizes are not ops. They show up only in `summary`. Text in each
change is capped at 2000 characters.

## Locks

- Any user move, resize, or edit sets `owner: "user"` and `locked: true`.
- `bwc draw` never changes a locked or user-owned item. Not text, not position,
  not color.
- To change one, let the draw add a suggestion note, or ask the user.
- Unlock: the user clicks unlock on the board, or you run
  `bwc unlock --project <p> --id <id>` after the user says so.

## Suggestion notes

When you want to change something the user owns, put a note next to it:
`meta.kind: "suggestion"`, `meta.suggestsFor: "<id>"`, and an edge to the
target. Keep the text short: what you would change and why. The user can
accept it by editing their item, or delete the note.

## Layout tips

- Flow left to right. Inputs on the left, outputs on the right.
- Sticky notes 280 x 160.
- 40px gaps between items, so a 280 wide note puts the next one at x + 320.
- Rows for alternatives: same x, stacked with y + 200.
- Put question notes near what they ask about, not in a pile.
- Leave space to the right of user items for suggestion notes.
- Do not stack new items on top of user items. Read the board first.

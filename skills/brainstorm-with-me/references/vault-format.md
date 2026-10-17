# Vault format

Everything persistent lives in the vault: a plain folder of markdown files plus
a `board.canvas`. No app is required. The default is
`~/Documents/brainstorm-vault`, created on first use with no setup step. To
move it: `bwc config --vault "<path>" [--create]`. The `BWC_VAULT` env var
overrides both.

Viewing is up to the user. Open the folder in Obsidian if they have it (the
`.canvas` file and `^bwc-` block ids work there); VS Code markdown preview or
any text editor works too. Never tell the user they need Obsidian.

## Layout

```
<vault>/Brainstorm/<project>/
  brief.md
  board.canvas
  board-diagrams.md      (only with export --mermaid)
  decisions.md
  open-questions.md
  rejected-ideas.md
  critiques/2026-10-17-<idea>.md
  sessions/2026-10-17-1530-wrap.md
  scratch/
  .bwc-manifest.json
```

The folder name `Brainstorm` is configurable (`folder` in config).

## Files

- **brief.md**: the concept brief. See `brief-template.md`. Edited one section
  at a time.
- **board.canvas**: JSON Canvas 1.0 export of the board. Plain spec, no plugin
  metadata, so any JSON Canvas viewer (Obsidian, for one) opens it. Edits made
  to it outside the plugin are re-imported as user-owned, locked items.
- **board-diagrams.md**: optional. Written only by `bwc export --project <p> --mermaid`,
  when the user asks for a mermaid note. Each diagram from the board as a
  fenced block, plus sticky notes as bullets. Readable anywhere mermaid renders.
- **decisions.md**: append only. One entry per decision:

  ```markdown
  - 2026-10-17: Reflex layer runs on device, LLM in the cloud. ^bwc-d7
  ```

- **open-questions.md**: one entry per question. Status changes, entries are
  never deleted:

  ```markdown
  - [ ] What wakes the brain: rules or a tiny classifier? ^bwc-q3
  - [x] Which phone? Answer: the Pixel I already own (2026-10-17). ^bwc-q1
  ```

- **rejected-ideas.md**: append only. Always with a reason:

  ```markdown
  - 2026-10-17: Train a custom vision model. Reason: no labeled data, eats the semester. ^bwc-r2
  ```

  A parked critique adds `Revisit when: ...` to the reason.
- **critiques/**: one file per critique, `YYYY-MM-DD-<idea>.md`, template in
  `critic-rubric.md`. Never edited after saving; a new critique is a new file.
- **sessions/**: one wrap note per session, `YYYY-MM-DD-HHMM-wrap.md`, template
  in `session-notes.md`.
- **scratch/**: throwaway experiments only. Nothing here is production code.
- **.bwc-manifest.json**: the hash of what the plugin last wrote to each file.
  Do not edit by hand.

## Safe write

The plugin never silently overwrites something the user changed.

1. Before writing, the CLI hashes the file on disk and compares it to the
   manifest.
2. Hash matches (or no file yet): write to a temp file, then rename. Status
   `written`.
3. Hash differs (the user edited it): merge.
   - List files merge by block id (`^bwc-...`). User entries and edits stay.
   - The brief merges per section.
   - The canvas re-imports user edits as locked items.
   Status `merged`.
4. Merge not possible: the CLI writes `<name>.conflict-<timestamp>.md` next to
   the original and leaves the original alone. Status `conflict`.

When you see `conflict`: tell the user which file, show the two versions
briefly, and ask which to keep. Do not delete either file. Sync tools (Obsidian
sync, Dropbox, and similar) can also create conflict files; treat them the same way.

Ids in block references (`^bwc-...`) are how entries are tracked. Keep them
when the user asks you to edit an entry by hand.

# brainstorm-with-me

[![CI](https://github.com/ManHazz/brainstorm-with-me/actions/workflows/ci.yml/badge.svg)](https://github.com/ManHazz/brainstorm-with-me/actions/workflows/ci.yml)

A brainstorming plugin for Claude Code. Claude draws mermaid diagrams in the
terminal as you talk. An optional local board shows the same diagrams and lets
you move and edit them. Decisions, open questions, and rejected ideas are saved
as plain markdown files, so the next session continues from the last one.

## Quickstart

Requirements: Claude Code and Node 20 or newer.

1. Install the plugin. In Claude Code, run:

   ```
   /plugin marketplace add ManHazz/brainstorm-with-me
   /plugin install brainstorm-with-me@brainstorm-with-me
   ```

   Or from a shell:

   ```bash
   claude plugin marketplace add ManHazz/brainstorm-with-me
   claude plugin install brainstorm-with-me@brainstorm-with-me
   ```

   From a local clone, add the folder instead:

   ```
   /plugin marketplace add C:\path\to\brainstorm-with-me
   ```

2. Start a project:

   ```
   /brainstorm-with-me:start <project> [objective]
   ```

   Diagrams appear in the chat as mermaid blocks. Notes are saved to
   `~/Documents/brainstorm-vault`, which is created on first use.

3. Finish with `/brainstorm-with-me:wrap`. Resume with
   `/brainstorm-with-me:pickup <project>`.

To change the notes folder, run
`node "<plugin dir>/scripts/bwm.js" config --vault "<path>" --create`
or set the `BWC_VAULT` environment variable.

## Commands

| Command | Description |
|---------|-------------|
| `/brainstorm-with-me:start <project> [objective]` | Create a project and draw a first diagram. |
| `/brainstorm-with-me:board [what]` | Open the board, draw on it, and wait for your edits. |
| `/brainstorm-with-me:brief [section] [text]` | Show or edit the concept brief. Runs a drift check. |
| `/brainstorm-with-me:critic [idea]` | Critique an idea with scores, the strongest objection, and a verdict. Saved to the vault. |
| `/brainstorm-with-me:wrap` | Save a session note and export the board to `board.canvas`. |
| `/brainstorm-with-me:pickup [project]` | Load the last session and show where you stopped. |
| `/brainstorm-with-me:status [project]` | Show vault folder, board state, pending input, and list counts. |

Only `/brainstorm-with-me:board` opens a browser. Everything else runs in the
terminal. Claude also starts the `brainstorm-with-me` skill on its own when
you are shaping an idea that is not settled yet.

## Board (optional)

Run `/brainstorm-with-me:board`. In the Claude desktop app it opens in the
built-in browser pane. Elsewhere it opens your system browser. Everything drawn
earlier in the project is already on it.

- **Turns.** Claude draws, then waits. Edit notes, add notes, or draw
  connections. Claude wakes when you act.
- **Locks.** Anything you move, resize, or edit is locked. Claude does not
  change locked items. It adds a suggestion note beside them. Click unlock on an
  item to let Claude change it again.
- **Delete.** Select an item and click Delete, or press the Delete key.
- **Chat.** The chat panel is collapsed by default. Click Chat to open it. Dock
  it to the top, left, bottom, or right, or float and drag it.
- **Diagrams.** Mermaid diagrams render with a bundled copy of mermaid. A render
  error is sent back to Claude.

## Vault folder

The vault is a plain folder. Default: `~/Documents/brainstorm-vault`.

```
<vault>/Brainstorm/<project>/
  brief.md             concept brief
  board.canvas         the board as a JSON Canvas file
  board-diagrams.md    diagrams as mermaid blocks, created only on request
  decisions.md         append only
  open-questions.md    checkboxes, never deleted
  rejected-ideas.md    each with a reason
  critiques/           one file per critique
  sessions/            one note per session
  scratch/             scratch files
```

Open the folder in Obsidian, VS Code, or any text editor.

If you edit a file yourself, the plugin merges your change. If a merge is not
possible, it writes a `.conflict-<timestamp>.md` file next to the original. It
does not overwrite your edits.

## Privacy

- The board server listens on 127.0.0.1 only and runs only while the board is
  open. It checks the Host and Origin headers and requires a per-start token
  for writes.
- No telemetry. The plugin makes no outbound requests.
- No secrets are stored. The config holds the vault path, folder name, and port.
- The critic can search the web through Claude's WebSearch and WebFetch tools.
  To turn this off, tell Claude not to search or set `criticWeb` to `false` in
  the config.

## Known limitations

- Board input reaches Claude as tool output, not as a chat message. Claude Code
  cannot inject a user message.
- Claude receives board input only while a background `await` is running. If
  none is running, a Stop hook blocks the turn from ending while input is
  undelivered, and `status` shows pending input.
- The CLI mermaid check is structural. The browser does the full parse and
  reports failures as render errors. `node scripts/validate.js --deep` tries a
  full parse in Node and falls back to the structural check if it cannot run.
- One browser tab per project.
- Single user. No multi-user editing.
- Sync tools such as Obsidian Sync or Dropbox can create conflict files that you
  resolve by hand.
- The terminal shows diagrams as mermaid source. Open the board or a markdown
  preview to see them drawn.

## Development

```bash
npm test                 # unit and integration tests
npm run check-skill      # plugin structure and text checks
npm run validate -- <file.canvas|file.md>
npm run evals            # dry run of behavior evals
node evals/run-evals.js --run   # real eval run with claude -p (uses API quota)
```

No npm dependencies. CI runs these checks on Linux, macOS, and Windows with
Node 20 and 22. The original build plan is in [docs/PLAN.md](docs/PLAN.md).

## License and credits

MIT. See [LICENSE](LICENSE). Prior art and bundled third-party code are
credited in [NOTICE.md](NOTICE.md).

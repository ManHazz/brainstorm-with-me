# brainstorm-with-me

[![CI](https://github.com/ManHazz/brainstorm-with-me/actions/workflows/ci.yml/badge.svg)](https://github.com/ManHazz/brainstorm-with-me/actions/workflows/ci.yml)

A brainstorming partner for Claude Code. You talk, Claude thinks along and
draws mermaid diagrams right in the terminal. If you want, a local board page
shows the same diagrams and lets you move and edit them. Decisions, open
questions, and rejected ideas go into a folder of plain markdown files, so the
next session picks up where the last one stopped.

Built for working through project ideas, like a final year project, before any
real code gets written.

## 5 minute quickstart

You need Claude Code and Node 20 or newer. Nothing else: no browser required,
no note app required.

1. Add the marketplace and install the plugin. In Claude Code:

   ```
   /plugin marketplace add ManHazz/brainstorm-with-me
   /plugin install brainstorm-with-me@brainstorm-with-me
   ```

   Or from your shell:

   ```bash
   claude plugin marketplace add ManHazz/brainstorm-with-me
   claude plugin install brainstorm-with-me@brainstorm-with-me
   ```

   Working from a local clone instead? Point the marketplace at the folder:

   ```
   /plugin marketplace add C:\path\to\brainstorm-with-me
   /plugin install brainstorm-with-me@brainstorm-with-me
   ```

2. Start a brainstorm:

   ```
   /brainstorm-with-me:start phone-embodied-agent
   ```

   Everything stays in the terminal. Diagrams show up in the chat as mermaid
   blocks. Your notes go to `~/Documents/brainstorm-vault`, which is created
   for you.

3. When you are done: `/brainstorm-with-me:wrap`. Next time:
   `/brainstorm-with-me:pickup phone-embodied-agent`.

Want the notes somewhere else? `node "<plugin dir>/scripts/bwm.js" config --vault "<path>" --create`
(or set the `BWC_VAULT` env var).

## Commands

| Command | What it does |
|---------|--------------|
| `/brainstorm-with-me:start <project> [objective]` | New brainstorm. Sets up the project folder and sketches a first diagram in chat. |
| `/brainstorm-with-me:board [what]` | Opens the optional browser board, draws on it, and waits for your edits. |
| `/brainstorm-with-me:brief [section] [text]` | Show the concept brief, or edit one section. Runs a drift check. |
| `/brainstorm-with-me:critic [idea]` | Honest critique: scores, strongest objection, pursue / refine / park. Saved to the vault folder. |
| `/brainstorm-with-me:wrap` | Saves a session note and exports the board to `board.canvas`. |
| `/brainstorm-with-me:pickup [project]` | Loads the last session and tells you where you are and what is next. |
| `/brainstorm-with-me:status [project]` | Vault folder, board state, pending input, list counts. |

Only `/board` opens a browser. Everything else works fully in the terminal.
You do not have to use the commands either: "let's brainstorm X" or "draw
this" also triggers the `brainstorm-with-me` skill.

## Board (optional)

Without the board, Claude puts each diagram in the chat as a mermaid block
and also saves it to board state. So when you do run
`/brainstorm-with-me:board`, everything drawn so far is already there.

- **Turn taking.** Claude draws, then yields. You react on the board: type a
  message, edit a note, add notes, draw connections. Claude waits in the
  background and wakes up when you do something.
- **Locks.** Anything you move, resize, or edit becomes yours and is locked.
  Claude never rewrites or moves a locked item. If it wants a change, it adds a
  suggestion note next to it. Click unlock on an item to let Claude rearrange
  it again.
- **Diagrams.** Mermaid diagrams render in the page with a bundled copy of
  mermaid (no CDN). If one fails to render, the error goes back to Claude.

## What lands in the vault folder

The "vault" is just a folder. Default: `~/Documents/brainstorm-vault`.

```
<vault>/Brainstorm/<project>/
  brief.md             concept brief: objective, scope, non-goals, success metric, kill criterion
  board.canvas         the board as a JSON Canvas file
  board-diagrams.md    optional: diagrams as mermaid blocks, only if you ask for a mermaid note
  decisions.md         append only
  open-questions.md    checkboxes, never deleted
  rejected-ideas.md    each with a reason
  critiques/           one file per critique
  sessions/            one wrap note per session
  scratch/             throwaway experiments
```

To browse it, open the folder in Obsidian if you have it (it also shows
`board.canvas`). VS Code markdown preview or any text editor works too.

If you edit a file yourself, the plugin merges your change. If it cannot, it
writes a `.conflict-<timestamp>.md` file next to it and asks. It never
overwrites your edits.

## Example

A real vault folder from a brainstorm on the phone-embodied-agent idea lives in
[examples/vault/Brainstorm/phone-embodied-agent/](examples/vault/Brainstorm/phone-embodied-agent/).
Browse it to see what the plugin writes before you run it.

## Privacy

- The board server listens on 127.0.0.1 only, and only runs if you open the
  board. It checks the Host and Origin headers and uses a per-start token for
  writes.
- No telemetry. The plugin makes no outbound requests.
- No secrets or credentials are stored. Config holds the vault path, folder
  name, and port.
- The only network use is optional: the critic may search the web for prior
  work, using Claude's own WebSearch and WebFetch tools. Turn that off by
  telling Claude not to search, or set `criticWeb` to false in the config.

## Demo script (about 5 minutes)

1. `/brainstorm-with-me:start phone-embodied-agent An AI that lives in a phone and uses its sensors as senses`
   Claude sketches the objective and a few open questions as a mermaid block
   in the chat.
2. Think out loud: "what if the camera is eyes, mic is ears, IMU is balance,
   and a reflex layer handles stuff before the LLM wakes up". Claude should
   reflect it back and offer to draw, without a list of questions.
3. Say yes. A left to right flow appears in the chat: senses, reflex layer,
   attention gate, LLM brain.
4. `/brainstorm-with-me:board`. The browser opens with that same flow.
5. On the board, edit the gate note to say "tiny classifier, not rules". Claude
   wakes up, quotes what you wrote, and records it as a decision.
6. Ask Claude to redraw the whole flow tidier. Your gate note stays where you
   put it; Claude adds a suggestion note next to it instead of changing it.
7. `/brainstorm-with-me:critic` and read the verdict. Expect scores with
   reasons and a strongest objection, not compliments.
8. `/brainstorm-with-me:wrap`. Open `~/Documents/brainstorm-vault` and
   look at `decisions.md` and the new file in `sessions/`.
9. Start a fresh Claude Code session and run
   `/brainstorm-with-me:pickup phone-embodied-agent`. You get two lines:
   where you are, and what is next.

Skip steps 4 to 6 for a terminal only run.

## Known limitations

- When the board is open, board input reaches Claude as tool output marked as your words, not as a real
  chat message. Claude Code has no way to inject a user message.
- Claude only hears the board while a background `await` is running. If it is
  not, a Stop hook blocks the turn from ending while input is undelivered, and
  `status` shows pending input.
- The mermaid check in the CLI is structural. The real parse happens in the
  browser, and failures come back as render errors. `node scripts/validate.js --deep`
  tries a real parse in Node with the bundled mermaid, but that is best effort
  and falls back to the structural lint when it cannot run.
- One browser tab per project.
- Single user. No multi-user editing.
- Sync tools (Obsidian sync, Dropbox, and similar) can produce conflict files
  that you resolve by hand.
- In the terminal, diagrams show as mermaid source, not as rendered pictures.
  Open the board, or preview the markdown, to see them drawn.

## Running tests

```bash
npm test                 # unit and integration tests (node:test)
npm run check-skill      # plugin structure and text checks
npm run validate -- <file.canvas|file.md>
npm run evals            # dry run of behavior evals
node evals/run-evals.js --run   # real eval run with claude -p (uses your API quota)
```

No npm dependencies. CI runs all of this on Linux, macOS, and Windows with
Node 20 and 22. The original build plan is kept in [docs/PLAN.md](docs/PLAN.md).

## License and credits

MIT, see [LICENSE](LICENSE). Prior art and bundled third party code are
credited in [NOTICE.md](NOTICE.md).

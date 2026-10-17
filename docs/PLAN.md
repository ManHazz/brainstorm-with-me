# brainstorm-with-me: build plan (v0.1.0)

Status: Built as v0.1.0; this is the original build plan, kept for reference.

The plan below is mostly as it was written before the build. Where the build
went a different way, the "Decisions made during the build" section wins.

## Decisions made during the build

These answer the open questions at the bottom and record other changes:

- **Board is optional.** Everything works in the terminal. Diagrams show in
  chat as mermaid blocks and are saved to board state, so `/board` picks them
  up later. Only `/board` opens a browser.
- **Vault is a plain folder.** Default `~/Documents/brainstorm-vault`, created
  on demand, no setup step. Obsidian is optional, just a nice way to browse it.
  `BWC_VAULT` or `bwc config --vault` moves it.
- **Export.** `board.canvas` is the default. The mermaid note
  (`board-diagrams.md`) is opt-in (`--mermaid` or `exportMermaidNote`).
- **Critic web search is on.** The critic may use WebSearch and WebFetch for
  prior work. `criticWeb: false` in the config turns it off. The plugin itself
  still makes no outbound requests.
- **Deep mermaid parse added.** `validate.js --deep` runs a real
  `mermaid.parse` in Node with the bundled mermaid, best effort, and falls back
  to the structural lint when it cannot run.
- **Mermaid pinned.** Version 11.17.2, vendored, with an npm integrity check
  and a sha256 that the tests verify.
- **Names.** Plugin, skill, and config folder are all `brainstorm-with-me`
  (`skills/brainstorm-with-me/`, `~/.claude/brainstorm-with-me/`).
- **Node.** Engines say Node 20 or newer; CI runs Node 20 and 22 on Linux,
  macOS, and Windows.

## What I looked at in ecc (2.2.3)

Used as reference:
- `.claude-plugin/plugin.json` and `PLUGIN_SCHEMA_NOTES.md`: `version` required, `skills` and `commands` as arrays, no `agents` or `hooks` keys (both auto-discovered).
- `docs/SKILL-DEVELOPMENT-GUIDE.md`, `CONTRIBUTING.md` skill checklist: `skills/<name>/SKILL.md`, name matches dir, inline `description` that says when to use it, sections When to Activate / How It Works / Examples / Anti-Patterns / Related Skills, under 500 lines, detail pushed to `references/` and `scripts/`.
- `docs/skill-adaptation-policy.md`: take ideas, rebuild native, no thin wrappers.
- `commands/plan-canvas.md`: thin command files with `description` + `argument-hint` that hand off to a skill.
- `skills/plan-canvas` + `scripts/plan-canvas.js`: closest prior art. Zero-dep Node CLI, detached 127.0.0.1 server, `open` returns at once, `await` long-polls and prints JSON, run as background Bash so feedback wakes Claude, plus a Stop hook for undelivered feedback. It loads mermaid from a CDN; we vendor instead. Ideas only, our own code.
- `scripts/ci/validate-skills.js`: frontmatter checks to mirror.
- `skills/skill-comply`, `skills/eval-harness`: scenario evals with `claude -p`, pass@k.
- `skills/architecture-decision-records`, `skills/context-and-decisions`: decision log shape.
- `commands/save-session.md`, `resume-session.md`: analogs for wrap and pickup.
- Agents: `ecc:planner` drafted this plan. `ecc:code-reviewer`, `ecc:security-reviewer`, `ecc:typescript-reviewer` (JS) will run before finishing.

Looked for, not found:
- A general "scaffold a new skill or plugin" workflow. `skill-create` only mines git history.
- Any JSON Canvas or Obsidian specific skill (by name).

## Reference repo licenses (checked)

- mazzucci/whiteboard: MIT
- pmatos/sketchpact: MIT
- nelsonwerd/ideate-skill: MIT
- andrehuang/research-companion: MIT
- lsnackerman/raw-clauding-skills: CC BY-SA 4.0 (README + LICENSE)

Plan: no code or text copied from any of them. NOTICE.md credits all five as idea sources.

## Repo tree

```
brainstorm-with-me/
  .claude-plugin/plugin.json, marketplace.json
  .github/workflows/ci.yml
  skills/brainstorm-with-me/SKILL.md
  skills/brainstorm-with-me/references/  board-protocol, brief-template, critic-rubric,
                                         vault-format, session-notes, ideation-rules
  commands/  start, board, brief, critic, wrap, pickup, status (.md)
  agents/idea-critic.md          read-only critic
  hooks/hooks.json               Stop hook: undelivered board input
  scripts/bwc.js                 single CLI
  scripts/lib/  server, board-model, merge, diff, vault, safe-write, config,
                canvas-export, canvas-validate, mermaid-lint, mermaid-deep
  scripts/validate.js            .canvas + mermaid validator
  scripts/vendor-mermaid.js      dev-only, pins mermaid and records sha256
  vendor/mermaid/                mermaid.min.js, LICENSE, VERSION, SHA256
  web/  index.html, board.js, board.css
  tests/  *.test.js (node:test), fixtures/
  evals/  scenarios/*.json, run-evals.js
  docs/  CONTRACTS.md, PLAN.md
  examples/vault/Brainstorm/phone-embodied-agent/
  README.md  CHANGELOG.md  LICENSE (MIT)  NOTICE.md
```

No npm runtime dependencies. Works the same on Windows, macOS and Linux.

## 1. Board

- Server: `node:http`, binds 127.0.0.1 only, port 4527 (falls back up to 4536, then random). Runs detached. Exits after 30 idle minutes or on `bwc stop`.
- State: `~/.claude/brainstorm-with-me/state/<project>/board.json`, atomic writes.
- Model: JSON Canvas 1.0 nodes and edges, each with extra `meta { owner: claude|user, locked, rev, kind: note|diagram|question|answer }`. Export strips `meta`, so the `.canvas` file is plain spec.
- Mermaid diagram = a text node holding a mermaid code block. The page renders it with vendored mermaid; Obsidian renders the same node natively. Sticky notes are plain text nodes.
- Claude draws with `bwc draw --spec file.json|file.mmd`. Merge by id: add new, update Claude-owned unlocked items, never touch user-owned or locked items. If Claude wants to change a locked item, it adds a linked suggestion note instead. Prints added / updated / skipped.
- Turn taking: Claude draws, then yields. Any user move, resize or edit locks that item to the user. The user can unlock it ("let Claude rearrange").
- User input back: `bwc await` long-polls and runs as background Bash, so a reply wakes Claude. Output: `{ user_said, diff, rev }`. The skill treats `user_said` as the user's own words, quoted verbatim.
- Semantic diff vs last delivered rev: edit_text, add_note, delete, connect, disconnect, answer, render_error. Moves and resizes collapse into a one-line summary.
- Backstop: `bwc pending`, and a Stop hook that blocks ending a turn while board input is undelivered.
- Security: Host header must be 127.0.0.1 or localhost (DNS rebinding), Origin check on POST, per-start random token on every write, JSON only, no CORS, CSP `default-src 'self'`, text set via textContent, mermaid `securityLevel: 'strict'`. No outbound requests, no telemetry, no secrets stored.

## 2. Concept brief

- `brief.md` per project. Frontmatter: project, created, updated, status. Sections: Objective, Scope, Non-goals, Success metric, Kill criterion, Decision log (links to decisions.md).
- Edited one section at a time, never regenerated.
- Drift check on `start` and `pickup`: compares recent board and decisions against Objective and Non-goals, max 3 flags.

## 3. Critic

- `agents/idea-critic.md`, tools Read, Grep, Glob, WebSearch, WebFetch. Never writes files.
- Scores 1 to 5 on novelty, feasibility (solo final year student), timing, competitive landscape, each with evidence.
- Verdict: pursue, refine (with the exact change), or park (with a revisit condition).
- Anti-flattery: no praise words, strongest objection required, any 4 or 5 needs evidence.
- Saved as `critiques/YYYY-MM-DD-<idea>.md`.

## 4. Memory (vault folder)

- Config `~/.claude/brainstorm-with-me/config.json` (`vaultPath`, `folder`, `port`), env `BWC_VAULT` overrides. Originally `start` would ask once if missing; in the build it falls back to the default folder instead.
- `<vault>/Brainstorm/<project>/`: brief.md, board.canvas, board-diagrams.md (opt-in), decisions.md, open-questions.md, rejected-ideas.md, critiques/, sessions/, scratch/, .bwc-manifest.json.
- Safe write: manifest stores the hash of what we last wrote. Hash matches: write atomically. Hash differs (user edited): merge list files by item id, merge brief per section, re-import canvas edits as locked items. Anything else: write `<name>.conflict-<ts>.md` and ask. Never overwrite silently.
- Decisions, rejected ideas, critiques, wraps: append or create only. Open questions change status, never get deleted.
- `wrap`: where we are, decisions this session, top open questions, rejected with reason, one next step, board rev. `pickup`: loads latest wrap + brief + open questions, runs drift check, reopens board, states next step in two lines.

## Skill rules

- Soft rule: no production code during ideation unless asked. Experiments go in `scratch/`.
- One question at a time, only when the objective is unclear. Thinking out loud gets reflection and drawing, not an interview.
- Decisions, open questions, rejected ideas kept as three lists.
- Never overwrite user edits, on the board or in the vault.

## Validator

- Canvas: allowed keys, unique ids, valid types and required fields, integer geometry, edges point at real nodes, valid sides, ends and colors.
- Mermaid: offline structural lint (known header, balanced brackets, quotes and subgraph/end, valid ids, arrow syntax, no HTML or script). The board page also runs real `mermaid.parse` and reports errors back as `render_error`. `--deep` adds a real parse in Node (see decisions above).
- CLI: exit 0 or 1, text or JSON. `bwc draw` runs it before accepting a spec.

## Testing

- Unit (node:test): model, merge (locked items untouched), diff, export passes validator, validator good and bad fixtures, mermaid lint, safe-write (match, merge, conflict), config, paths with spaces.
- Server integration: wrong Host, Origin, token, content type rejected; draw, simulated edit, await returns diff, pending and Stop hook output, idle shutdown.
- Evals (skill-comply style, `claude -p`): unclear objective gives one question; thinking aloud gives none; "write the app" gives a scratch-only offer; weak idea gets park or refine with no praise; locked node survives redraw; edited vault file gets merge or question. pass@3 each.

## Build order

1. Skeleton: manifest, LICENSE, CHANGELOG, config, validator + tests.
2. Board MVP: server, model, draw / await / pending, UI with vendored mermaid, Stop hook.
3. Locks and diff: lock on edit, merge, semantic diff, render_error.
4. Vault and brief: safe-write, templates, lists, export, wrap, pickup, drift check.
5. Critic: agent, rubric, dated output, evals.
6. Ship: reviewer agents (code, security, JS), README (5 minute quickstart, demo script, known limitations), NOTICE, dogfood session on phone-embodied-agent, copy vault notes to `examples/`, tag v0.1.0.

## Risks

- Background `await` waking Claude is the fragile link. Backstops: Stop hook, `bwc pending`, `status`.
- Claude Code cannot inject a real user message. Board input arrives as tool output marked as the user's words. Documented as a known limitation.
- Mermaid bundle about 3 MB and version drift. Pin version, check sha256 in tests.
- Sync tools writing mid-save. Hash check, atomic rename, conflict file.
- Diff noise filling context. Collapse geometry, cap verbatim text.

## Open questions (answered)

1. Vault path? Answer: a plain folder, default `~/Documents/brainstorm-vault`, with a top-level `Brainstorm/` folder inside. Obsidian optional.
2. Board export: `.canvas` only, or `.canvas` plus a mermaid note by default? Answer: `.canvas` by default, mermaid note opt-in.
3. May the critic use web search for the competitive landscape? Answer: yes, on by default, can be turned off. The plugin itself stays local-only.
4. Is structural lint plus in-browser parse enough, or add full Node parsing? Answer: added `--deep` Node parsing, best effort.

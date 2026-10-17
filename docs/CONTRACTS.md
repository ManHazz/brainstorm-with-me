# Internal contracts

Shared interfaces between modules. Every module is CommonJS, Node 22, no npm runtime dependencies. Use only `node:` built-ins. Paths always via `path.join`. No em dashes in any text, code comments, or docs.

## Board model (`scripts/lib/board-model.js`)

```js
// Board document
{
  version: 1,
  project: "phone-embodied-agent",
  rev: 7,                 // bumps on every accepted change (Claude draw or user edit)
  deliveredRev: 5,        // last rev whose user changes were handed to Claude
  nodes: [Node],
  edges: [Edge],
  events: [Event]         // undelivered user events, cleared by markDelivered
}

// Node: JSON Canvas 1.0 fields + meta
{ id, type: "text"|"file"|"link"|"group", x, y, width, height, color?, text?, file?, url?, label?,
  meta: { owner: "claude"|"user", locked: boolean, rev: number,
          kind: "note"|"diagram"|"question"|"answer"|"suggestion", suggestsFor?: id } }

// Edge: JSON Canvas 1.0 fields + meta
{ id, fromNode, toNode, fromSide?, toSide?, fromEnd?, toEnd?, color?, label?, meta: {...same} }

// Event (user input not yet delivered to Claude)
{ seq, at: ISOString, type: "say"|"edit", text?, rev }
```

Exports: `emptyBoard(project)`, `loadBoard(file)`, `saveBoard(file, board)` (atomic: write tmp then rename), `applyUserEdit(board, edit)` (sets `owner:"user", locked:true`, bumps rev, keeps a snapshot for diff), `unlock(board, id)`.

## Merge (`scripts/lib/merge.js`)

`mergeDraw(board, spec) -> { board, report: { added: [id], updated: [id], skippedLocked: [id], suggestions: [id] } }`

- spec = `{ nodes: [...], edges: [...] }` (same shapes, `meta` optional) or produced by `specFromMermaid(text, { id, x, y })` which returns one diagram text node whose `text` is a fenced mermaid block.
- Never changes any field of an item with `meta.locked || meta.owner === "user"`. When spec differs for such an item, add a `kind:"suggestion"` note linked by an edge and list it in `suggestions`.

## Diff (`scripts/lib/diff.js`)

`semanticDiff(oldBoard, newBoard) -> { from_rev, to_rev, changes: [Change], summary: string }`

Change ops: `edit_text {id, before, after}`, `add_note {id, text}`, `delete {id, text}`, `connect {id, from, to, label}`, `disconnect {id, from, to}`, `answer {question_id, id, text}`, `render_error {id, message}`. Moves and resizes do not become changes; they are counted in `summary` ("moved 2 items"). Verbatim text capped at 2000 chars per change.

## Validator (`scripts/lib/canvas-validate.js`, `scripts/lib/mermaid-lint.js`)

- `validateCanvas(obj, opts?) -> { ok: boolean, errors: [{path, message}], warnings: [...] }` (accepts parsed JSON; with `{ allowBoardExtras: true }` it ignores `meta` on items and top-level `version`, `project`, `rev`, `deliveredRev`, `events`).
- `lintMermaid(text) -> { ok, errors: [{line, message}], warnings }` for one diagram source (no fences).
- `extractMermaidBlocks(markdown) -> [{ text, line }]`.

## Canvas export (`scripts/lib/canvas-export.js`)

- `toCanvas(board) -> object` strips `meta` and board-level extras; output passes `validateCanvas` with default options.
- `toMermaidNote(board) -> string` markdown note listing each diagram node as a mermaid fence plus sticky notes as bullets.
- `fromCanvas(canvasObj, board) -> board` re-imports external edits; changed or new items come back as `owner:"user", locked:true`.

## Config (`scripts/lib/config.js`)

- Dir: `process.env.BWC_HOME || path.join(os.homedir(), ".claude", "brainstorm-with-me")`.
- `loadConfig() -> { vaultPath, folder: "Brainstorm", exportMermaidNote: false, port: 4527, criticWeb: true }`; env `BWC_VAULT` overrides vaultPath. When unset, vaultPath defaults to `~/Documents/brainstorm-vault`, created on first use.
- `saveConfig(partial)`, `projectDir(project)` -> `<vault>/<folder>/<project>`, `stateDir(project)` -> `<home>/state/<project>`, `slug(name)`.

## Safe write (`scripts/lib/safe-write.js`)

- Manifest file `<projectDir>/.bwc-manifest.json`: `{ files: { "<relpath>": { sha256, mtimeMs } } }`.
- `safeWrite(projectDir, relPath, content, { merge }) -> { status: "written"|"merged"|"conflict"|"unchanged", path, conflictPath? }`.
  - No file, or hash matches manifest: atomic write.
  - Hash differs (user edited): call `merge(currentOnDisk, ours)`; if merge returns a string, write it; if it returns null, write `<name>.conflict-<timestamp>.md` beside it and return `conflict`. Never overwrite the user's file in that case.
- `appendEntry(projectDir, relPath, entryMarkdown)` for append-only lists. Entries carry a block id `^bwc-<id>`.

## Vault (`scripts/lib/vault.js`)

Project files: `brief.md`, `board.canvas`, `board-diagrams.md`, `decisions.md`, `open-questions.md`, `rejected-ideas.md`, `critiques/YYYY-MM-DD-<slug>.md`, `sessions/YYYY-MM-DD-HHMM-wrap.md`, `scratch/`.

Exports: `initProject(project, { objective? })`, `readBrief(project)`, `updateBriefSection(project, section, text)` (in place, one section), `addDecision(project, text)`, `addOpenQuestion(project, text)`, `resolveQuestion(project, id, note)`, `addRejected(project, text, reason)`, `saveCritique(project, idea, markdown)`, `writeWrap(project, markdown)`, `latestWrap(project)`, `exportBoard(project, board)`, `status(project)`.

## CLI (`scripts/bwc.js`)

Single entry: `node scripts/bwc.js <cmd>`. JSON on stdout, progress on stderr. Dispatcher only; logic lives in `scripts/lib/cli-board.js` and `scripts/lib/cli-vault.js`, each exporting `{ commands: { name: async (args) => result } }`.

Board (`cli-board.js`): `open [--project p] [--no-open]`, `draw --project p --spec <file.json|file.mmd>`, `await --project p [--reply "text"] [--timeout-ms n]`, `pending [--hook]`, `unlock --project p --id x`, `stop`, `server` (foreground).
Vault (`cli-vault.js`): `init --project p [--objective t]`, `brief --project p [--section S --text T]`, `decide --project p --text t`, `question --project p --text t`, `resolve --project p --id x [--note t]`, `reject --project p --text t --reason r`, `critique-save --project p --idea I --file f`, `wrap --project p --file f`, `pickup --project p`, `export --project p`, `status [--project p]`, `config [--vault path]`.
Validate: `node scripts/validate.js <files...> [--json]`.

`await` output: `{ "status": "input", "user_said": ["verbatim text", ...], "diff": {...}, "rev": n }` or `{ "status": "ended" }`.

## HTTP (server)

Bind 127.0.0.1. Reject when Host is not `127.0.0.1:<port>` or `localhost:<port>`. POST requires matching Origin, `content-type: application/json`, and header `x-bwc-token` equal to the per-start token embedded in the served page. No CORS headers. CSP `default-src 'self'; style-src 'self' 'unsafe-inline'`. Static files only from `web/` and `vendor/mermaid/`.

## Tests

`node:test` + `node:assert/strict`, files `tests/<module>.test.js`, fixtures in `tests/fixtures/`. Use temp dirs from `fs.mkdtempSync(path.join(os.tmpdir(), "bwc-"))`, set `BWC_HOME` and `BWC_VAULT` to temp dirs. Runner: `npm test` (`scripts/run-tests.js` lists the files, since Node 20 has no glob support in `--test`).

# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-17

### Added

- `brainstorm-with-me` skill with references for the board protocol, concept brief,
  critic rubric, vault format, session notes, and ideation rules.
- Commands: start, board, brief, critic, wrap, pickup, status.
- `idea-critic` agent (read only) with a scored, no-flattery rubric.
- Local board server on 127.0.0.1 with turn taking, user locks, suggestion
  notes, and a semantic diff of user edits.
- Bundled mermaid 11.4.1 for offline diagram rendering.
- Vault storage: brief, decisions, open questions, rejected ideas, critiques,
  session wraps, and a JSON Canvas export, with safe writes and conflict files.
- Validator for `.canvas` files and mermaid blocks.
- Stop hook that catches undelivered board input.
- `check-skill` script and behavior eval scenarios (dry run by default).

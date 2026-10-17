# Notice

## Prior art (ideas only)

These projects shaped how this plugin thinks about brainstorming boards,
ideation flow, and research companionship. They are credited as idea sources
only. No code or text from them was copied into this repo.

| Project | License | What we took (as an idea) |
|---------|---------|---------------------------|
| [mazzucci/whiteboard](https://github.com/mazzucci/whiteboard) | MIT | A shared whiteboard between a person and an agent |
| [pmatos/sketchpact](https://github.com/pmatos/sketchpact) | MIT | Sketching as a way to agree on a design |
| [nelsonwerd/ideate-skill](https://github.com/nelsonwerd/ideate-skill) | MIT | Ideation as a skill with its own rules |
| [andrehuang/research-companion](https://github.com/andrehuang/research-companion) | MIT | Keeping research notes across sessions |
| [lsnackerman/raw-clauding-skills](https://github.com/lsnackerman/raw-clauding-skills) | CC BY-SA 4.0 | Ideas about conversational skill style. No text reused, so the share alike terms do not apply to this repo. |

## Design reference

- ecc `plan-canvas` skill (MIT, https://github.com/affaan-m/ECC): the pattern
  of a loopback browser page plus a background `await` call that wakes the
  agent. Our implementation is written from scratch.

## Bundled third party code

- mermaid 11.4.1 (MIT, https://github.com/mermaid-js/mermaid), vendored in
  `vendor/mermaid/`. Its license is in `vendor/mermaid/LICENSE`. Version and
  checksum are recorded next to it.

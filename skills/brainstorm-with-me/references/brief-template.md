# Concept brief

One `brief.md` per project. It is the anchor for drift checks, so keep it short
and honest. Edit one section at a time with
`bwm brief --project <p> --section "<Section>" --text "..."`. Never regenerate
the whole file.

## Shape

```markdown
---
project: phone-embodied-agent
created: 2026-10-17
updated: 2026-10-17
status: exploring
---

# phone-embodied-agent

## Objective
## Scope
## Non-goals
## Success metric
## Kill criterion
## Decision log
```

`status` is one of `exploring`, `shaping`, `committed`, `parked`.

## What goes in each section

- **Objective**: one or two sentences. What the project is for and who it is
  for. Example: "A phone app where an LLM experiences the world through the
  phone's sensors, with a cheap reflex layer handling most input, for a final
  year project demo."
- **Scope**: bullets of what is in for this version. Concrete nouns, not
  aspirations.
- **Non-goals**: bullets of what is explicitly out. This is what drift checks
  look at most. Example: "No custom hardware", "No training a model from
  scratch".
- **Success metric**: how you will know it worked. Prefer something you can
  measure or demo. Example: "Gate wakes the LLM on under 10 percent of sensor
  events while catching the scripted test events."
- **Kill criterion**: the result that would make you stop or pivot. Example:
  "If on-device latency from sensor event to reflex action is over 500 ms by
  week 6, drop the reflex layer idea."
- **Decision log**: links only, to entries in `decisions.md`. Do not copy the
  decision text here.

Leave a section empty rather than guessing. An empty Kill criterion is a fine
open question to record.

## Drift check

Run on `start` (for an existing project) and on `pickup`.

1. Read the brief: Objective and Non-goals especially.
2. Read the recent material: the board (latest diagrams and user notes), the
   last few entries in `decisions.md`, and the latest wrap.
3. For each recent item, ask: does this serve the Objective? Does it touch a
   Non-goal? Does it quietly expand Scope?
4. Report at most 3 flags, most important first, one line each:
   `Drift: <what> vs <brief section>: <why it matters>.`
5. If nothing drifted, say nothing about drift.
6. Do not fix drift yourself. The user decides: update the brief (one section),
   drop the item, or record it as a rejected idea.

Example flags:

- Drift: "train our own vision model" on the board vs Non-goals ("no training
  from scratch"): this would eat most of the semester.
- Drift: three recent decisions are about UI theming vs Objective (sensor
  driven agent): the core loop is still undecided.

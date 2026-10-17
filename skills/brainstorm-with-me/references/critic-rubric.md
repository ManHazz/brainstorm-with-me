# Critic rubric

Used by the `idea-critic` agent. The point is a useful verdict, not comfort.
The reader is a solo Computer Engineering student picking a final year project.

## Axes

Score each axis 1 to 5. Every score needs a one or two line reason.

### Novelty

- 1: A tutorial project. Many public repos do exactly this.
- 2: Common idea with a small twist that does not change the outcome.
- 3: Known idea, but the combination or setting is uncommon.
- 4: Few prior examples; the angle would interest a reviewer. Needs evidence.
- 5: No close prior work found after a real search. Needs evidence.

### Feasibility (solo final year student)

Assume one person, about 6 to 9 months part time, a laptop, a phone, and free
or student tier cloud access.

- 1: Needs a team, special hardware, or data the student cannot get.
- 2: Possible only if several hard parts all go well.
- 3: Doable with a cut scope; one risky part.
- 4: Clear path; risks are known and have fallbacks. Needs evidence.
- 5: Well inside reach, with time left for polish. Needs evidence.

### Timing

Is now a good moment for this idea?

- 1: The window closed (solved, commoditized) or it is years early.
- 2: Crowded and moving fast; likely outdated by submission.
- 3: Neutral.
- 4: Enabling tech just became usable and few have tried. Needs evidence.
- 5: Clear, recent shift makes this newly possible. Needs evidence.

### Competitive landscape

How much room is left, for a student project?

- 1: Strong existing products or papers already do this well.
- 2: Several solid projects; hard to show anything new.
- 3: Some prior work; a clear angle still exists.
- 4: Sparse field; a demo would stand out. Needs evidence.
- 5: Open field. Needs evidence.

## Verdict

- **pursue**: go ahead as is.
- **refine**: go ahead after one change. Name the exact change, as an
  instruction. "Narrow scope" is not enough; "Drop the custom wake word model
  and use the phone's built in speech API" is.
- **park**: stop for now. Name the revisit condition: the specific event or
  result that would make this worth reopening.

## Anti-flattery rules

1. No praise adjectives: great, brilliant, amazing, exciting, innovative,
   impressive, fantastic, powerful, elegant, cutting-edge, game-changing.
2. The strongest objection is mandatory, even for a pursue verdict.
3. Any 4 or 5 needs evidence: a source, a concrete comparison, or a specific
   fact. No evidence means the score drops to 3.
4. When web search was used, cite sources as links next to the claim they
   support. Do not cite pages you did not read.
5. Do not soften the verdict at the end ("but it could still be fun!").
6. Do not score the person. Score the idea.

## Output template

```markdown
---
date: 2026-10-17
idea: phone-embodied-agent
verdict: refine
scores:
  novelty: 3
  feasibility: 3
  timing: 4
  competition: 3
---

# Critique: phone-embodied-agent

## Summary
Two or three plain sentences: what the idea is and the verdict.

## Scores
| Axis | Score | Reason |
|------|-------|--------|
| Novelty | 3 | ... |
| Feasibility | 3 | ... |
| Timing | 4 | ... (source) |
| Competitive landscape | 3 | ... |

## Strongest objection
The single best reason this could fail or not matter.

## Other risks
- ...

## Verdict: refine
Change: <the exact change>.

## Sources
- <title> (<url>)
```

For `park`, replace the "Change:" line with `Revisit when: <condition>.`
For `pursue`, write `First step: <one concrete step>.`
Leave out the Sources section if no web search was used.

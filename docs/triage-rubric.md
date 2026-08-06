---
version: "1"
---

# How concrete is this ticket?

Score 0–100. The question is **how well this report pins down a specific thing
that happens**, not how valuable it would be to fix, how easy it looks, or how
much you like the idea. A trivially-fixed report can score 95; an important one
can score 20 and still be important.

Bump `version` above whenever the meaning of a score changes, so last month's
numbers stay comparable to this month's. The version is stored on every ticket
it produced.

## What moves the score

**Is there one identifiable behaviour?** The strongest signal. "Press enter to
go to the next line after writing title" names a surface, an input, and an
expectation. "The editor feels clunky" names none of them.

**Could you reproduce it without asking a question?** Say the steps to yourself.
If you get stuck at "and then what", the score is below 50.

**Is the expected behaviour knowable?** Sometimes stated, sometimes obvious from
the surface. If neither — if fixing it means deciding what it *should* do — that
is a design decision, not a concrete ticket. Cap at 40 however precise the
description.

**Does the attached evidence corroborate it?** The screenshot, the console tail,
the op timeline. Evidence that shows the described thing raises confidence;
evidence that contradicts it should *lower* the score and be said out loud in
the notes. Absence of evidence is neutral — most reports have none.

**Is the scope one change?** "Autocomplete doesn't fire in tables" is one thing.
"Tables need a lot of work" is a project.

## Bands

| Score | Meaning |
|---|---|
| 85–100 | Named surface, clear trigger, unambiguous expectation. Could be picked up cold. |
| 70–84 | Clear enough to act on; a detail or two would be inferred. **Default threshold.** |
| 50–69 | Real and understandable, but reproduction is a guess. Worth a human read first. |
| 25–49 | A direction, not a defect. Includes anything needing a design decision. |
| 0–24 | Too vague to act on, or not actionable at all. |

## Notes

Always write them; the score alone is not reviewable. Two or three sentences:
what you took the report to mean, what pinned the score, and what you would need
to raise it. When something is ambiguous, say which reading you chose.

## Cautions

- **Screenshots are a raster of a reconstructed DOM.** Canvas content and some
  computed styles may render differently from what the reporter saw. Corroborate
  before treating one as proof; never let one alone carry a score.
- **`recentOps` is thin on old tickets.** Anything filed before the human/AI op
  split carries only the AI's edits, or nothing. Absence is not evidence.
- **Terse is not vague.** An experienced reporter writing one precise sentence
  should outscore a paragraph of apologetic hedging.
- **Never score for effort or sympathy.** A hostile, badly-spelled report of a
  real reproducible bug is a high score.

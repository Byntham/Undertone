# Design notes

## Approach

I used a priority-ordered prompt designed for a small instruction model. It first defines the JSON fields and establishes strict insertion-only fidelity, then gives a short numbered cleanup procedure. Concrete examples cover injection-like dictation, context joins, dictionary variants, sound-alike repairs, spoken addresses, punctuation, and casing. The final checklist reinforces the high-cost failure modes: answering, context echo, paraphrase, expansion, and timid cleanup.

## Iterations

1. The first prompt scored **28/34, guards 6/6**. It handled all fidelity guards, dictionary variants, most sound-alikes, spoken forms, context joins, and tone preservation. It missed false-start deletion, `you're`, run-on terminal punctuation, a question mark, an introductory comma, and acronym/brand casing.
2. I made one targeted change: added six exact transformation examples plus a stronger terminal-punctuation rule. This scored **32/34, guards 6/6** and hit the first required stopping criterion. It fixed false-start deletion, `you're`/`see`, run-on splitting, the question mark, and acronym/brand casing; the introductory-comma case remained inconsistent, while `get repo` regressed despite its explicit rule.

## Final result

Final score: **32/34 cases; 6/6 guards** (full battery run 2 of 12). `final_prompt.txt` is an exact copy of the best-scoring `prompt.txt`.

Remaining failures:

- Case 7, **get repo -> git**: returned “get repo” even though the rule explicitly maps it to “git repo.” It passed on the first run, suggesting deterministic-model sensitivity to the added prompt context rather than a missing rule.
- Case 16, **intro comma**: returned “anyway I pushed...” despite both a general introductory-comma rule and an exact example. This also appears to be inconsistent under-application.

With more budget, I would shorten the example block and test whether moving the two stubborn transformations into a compact final checklist improves instruction salience without harming the guards. Per the stopping rule, I did not run further experiments after reaching 32/34 with all guards.

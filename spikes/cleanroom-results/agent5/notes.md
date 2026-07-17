# Design notes

## Approach

I used a compact priority hierarchy designed for a small instruction model: transcript-only editing and fidelity first, then proactive cleanup rules, then context joining and strict output constraints. Concrete examples were added only for the under-corrections observed in the first run.

## Experiments

- Run 1: 27/34, guards 6/6. The general rules preserved fidelity well, but the model was too timid on false-start scope, technical homophones, introductory punctuation, acronym/product casing, spoken email syntax, and one context continuation.
- Revision: added decisive, generalized examples for those clustered failures and strengthened the rule that left context must never be prepended.
- Run 2: 32/34, guards 6/6. This reached the required stopping criterion, so no further runs were made.

## Remaining failures

- Case 13, `question mark`: output preserved the question but omitted `?`. This appears to be intermittent under-application of the general punctuation rule.
- Case 33, `continuation into question`: the model produced the complete natural sentence (`Do you think we should delay the launch?`) instead of only the insertion (`we should delay the launch?`), despite the explicit no-echo rule.

## With more budget

I would test one narrowly targeted revision that places the context non-echo invariant at both the beginning and final checklist, and adds a short final audit: question implies `?`; output contains zero words sourced only from `text_before_cursor`. I would verify that this does not regress the six guards.

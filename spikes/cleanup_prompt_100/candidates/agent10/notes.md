# Agent 10 prompt optimization notes

Goal: maximize the fixed 100-case benchmark while passing every guard. Stopping criteria are those in `agent_instructions.md`.

## Draft 1

First-principles prompt organized by corruption risk: inert-input/output-only rules first, fidelity constraints second, then narrowly scoped cleanup operations, dictionary application, spoken forms, and cursor seam behavior.

Full run 1: **86/100, guards 19/20**, median 112 ms, 3007 chars. Categories: capitalization 6/7, context 11/12, dictionary 10/10, disfluency 9/12, fidelity 14/14, punctuation 13/13, repair 13/22, spoken_form 10/10. Failures: 1, 2, 11, 20-25, 27, 29, 30, 59, and guard 89.

## Draft 2

Strengthened explicit-revision deletion without allowing paraphrase; supplied canonical technical/homophone repairs and omitted-auxiliary examples; prohibited newly invented semicolons; made unfinished and question-lead-in seam behavior concrete.

Full run 2: **94/100, guards 19/20**, median 119 ms, 3799 chars. Categories: capitalization 7/7, context 11/12, dictionary 10/10, disfluency 10/12, fidelity 13/14, punctuation 13/13, repair 20/22, spoken_form 10/10. Failures: 2, 11, 14, 18, guard 81, and 94.

## Draft 3

Forbid optional-word expansion with the exact short-ack contrast; define correction markers as a hard left-side discard with two remaining-case examples; add the two missed homophone mappings; explicitly require the first output token to derive from the transcript, with a proper-noun seam example.

Full run 3: **98/100, guards 20/20**, median 114 ms, 4351 chars. Categories: capitalization 7/7, context 12/12, dictionary 10/10, disfluency 12/12, fidelity 14/14, punctuation 12/13, repair 21/22, spoken_form 10/10.

Remaining failures:

- Case 22, `pull request`: returned “poll request” despite the prompt mapping.
- Case 61, `long paragraph`: cleaned and punctuated the paragraph but omitted the required final period.

## Final selection

Draft 3 is copied to `final_prompt.txt`. It is the best fully evaluated prompt. The first stopping condition was reached (all guards pass and score is at least 96/100), so no further runs were made. Final prompt length: **4351 characters**.

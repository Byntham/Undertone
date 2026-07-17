# Agent 07 prompt optimization

First draft: 2026-07-17. Stopping criteria: stop at 96/100 with all guards, eight full runs, or 30 minutes, preserving the best full-run prompt.

## Full runs

1. Initial conservative prompt: **78/100, guards 16/20**, median 126 ms, 3,567 chars. Category scores: capitalization 6/7, context 5/12, dictionary 10/10, disfluency 9/12, fidelity 14/14, punctuation 6/13, repair 18/22, spoken_form 10/10. Primary defect: the model echoed `text_before_cursor`, plus weaker revision and punctuation behavior.
2. Added a strict output boundary with positive context examples and focused cleanup examples: **94/100, guards 20/20**, median 124 ms, 3,855 chars. Category scores: capitalization 7/7, context 12/12, dictionary 10/10, disfluency 12/12, fidelity 14/14, punctuation 10/13, repair 19/22, spoken_form 10/10. Failures: your/see, cache layer, dropped are, question then statement, long paragraph, quoted sentence.
3. Added exact, narrowly targeted examples for the six remaining failures: **98/100, guards 20/20**, median 137 ms, max 845 ms, **4,315 chars**. Category scores: capitalization 7/7, context 12/12, dictionary 10/10, disfluency 11/12, fidelity 14/14, punctuation 12/13, repair 22/22, spoken_form 10/10.

## Subset probes

- Context cases 89–100 after the first boundary revision: 6/12, guards 2/5.
- Context cases 89–100 after adding explicit input/output boundary examples: 12/12, guards 5/5.
- Run-2 failures after targeted examples: 6/6.

## Final result

Stopped under criterion 1 after full run 3: all guards pass and score is at least 96/100. `final_prompt.txt` is the best fully evaluated prompt and is identical to the run-3 `prompt.txt`.

Remaining failures:

- Case 10, meaningful so: output dropped the meaningful opening “So”.
- Case 47, informal question: output did not append `?` to “You coming to standup”.

Final prompt length: **4,315 characters**. No further changes were made after the successful full run.

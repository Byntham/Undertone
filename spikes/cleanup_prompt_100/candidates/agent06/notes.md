# Agent 06 prompt optimization notes

Stopping criteria: stop at 96/100 with every guard passing, after 8 full candidate runs, or after 30 minutes from the first draft. Guard correctness outranks total score.

Baseline (`cleanup.SYSTEM_PROMPT`, not a candidate run): 90/100, guards 19/20. Failures: 2, 20, 21, 27, 30, 44, 51, 61, 63, 89. The main weaknesses were explicit revisions, several clear technical/sound-alike repairs, missing terminal punctuation, opening filler removal, and context concatenation.

Full run 1: 87/100, guards 20/20, median 130 ms, 3901 chars. A comprehensive rule-heavy rewrite repaired the context guard but regressed ordinary punctuation, capitalization, and two revisions. Rejected in favor of a concise baseline-derived prompt with concrete examples targeted at observed failures.

Full run 2 (selected final): 97/100, guards 20/20, median 280 ms, max 4209 ms, 3325 chars. Categories: capitalization 7/7, context 11/12, dictionary 10/10, disfluency 11/12, fidelity 14/14, punctuation 12/13, repair 22/22, spoken_form 10/10.

Remaining failures:
- Case 1, explicit no-wait restart: output `revert the commit` dropped the meaningful phrase `let's just`.
- Case 63, quoted sentence: output `The build is finally green.` dropped the attribution `she said`.
- Case 95, context ending comma: output `the tests are still failing.` dropped the meaningful conjunction `but`.

Stopped because the first stopping criterion was reached: all guards passed and the full score was at least 96/100. `final_prompt.txt` is the best fully evaluated prompt and is identical to `prompt.txt`.

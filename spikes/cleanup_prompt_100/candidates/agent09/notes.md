# Agent 09 prompt experiments

Started with a conservative, rule-ordered copy-editing prompt. Priority is all guard cases, followed by repairs, punctuation, dictionary variants, and spoken forms.

Run 1: 87/100, guards 19/20, median 123 ms, 3809 chars. Category misses clustered in punctuation (7/13) and clear repairs (18/22); one guard missed the question mark implied by context. Revision adds exact examples for failures and a mandatory question check while reinforcing preservation of reporting clauses.

Run 2 (final): 98/100, guards 20/20, median 108 ms, max 281 ms, 5107 prompt characters. Categories: capitalization 6/7, context 12/12, dictionary 10/10, disfluency 12/12, fidelity 14/14, punctuation 12/13, repair 22/22, spoken_form 10/10.

Stopping criterion 1 was reached on Run 2, so no further experiments were run. Remaining failures:

- Case 55, `proper people places day`: output dropped the reporting clause and person, returning `The Paris launch is moved to Monday.` instead of preserving `I told Marcus ...`.
- Case 61, `long paragraph`: output retained opening filler `Okay, so`.

`final_prompt.txt` is the best fully evaluated candidate and is identical to the Run 2 `prompt.txt`.

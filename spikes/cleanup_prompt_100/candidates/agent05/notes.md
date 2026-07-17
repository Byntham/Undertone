# Agent 05 prompt experiments

Approach: conservative, first-principles edit hierarchy with guard behavior stated before cleanup operations. The prompt uses targeted examples for known weak behavior in a small local model while explicitly preserving tone, jargon, terse input, unusual-but-plausible wording, and spoken-out numbers.

## Runs

1. 79/100, guards 18/20, median 113 ms, 3608 chars. Category scores: capitalization 4/7, context 8/12, dictionary 10/10, disfluency 9/12, fidelity 14/14, punctuation 6/13, repair 18/22, spoken_form 10/10. Dangerous failures were context echo cases 90 and 91 (zero-based 89 and 90 in harness output). Ordinary failures clustered in correction restarts, punctuation/capitalization, and four repairs. Revision 2 shortens the context treatment and makes failures concrete examples.

2. 90/100, guards 17/20, median 126 ms, 4262 chars. Category scores: capitalization 6/7, context 6/12, dictionary 10/10, disfluency 12/12, fidelity 14/14, punctuation 10/13, repair 22/22, spoken_form 10/10. Concrete examples fixed every repair/revision failure, but quoted seam examples caused context concatenation. Revision 3 removes all quoted context examples and makes transcript-first output a hard invariant.

3. 90/100, guards 19/20, median 177 ms, 4849 chars. Category scores: capitalization 7/7, context 11/12, dictionary 10/10, disfluency 10/12, fidelity 13/14, punctuation 9/13, repair 20/22, spoken_form 10/10. Ignoring prior document text recovered the corruption guards; only a literal question missing `?` remained as a guard failure. Revision 4 reinforces exact failed transformations while retaining the safer no-context policy.

4. 90/100, guards 19/20, median 117 ms, 3686 chars. Category scores: capitalization 2/7, context 10/12, dictionary 10/10, disfluency 11/12, fidelity 14/14, punctuation 11/13, repair 22/22, spoken_form 10/10. Compression stabilized fidelity and repairs but underweighted capitalization. Revision 5 adds five compact full-sentence capitalization examples and restores the meaningful `so` exception.

5. **98/100, guards 20/20, median 111 ms, max 271 ms, 4377 chars.** Category scores: capitalization 7/7, context 11/12, dictionary 10/10, disfluency 12/12, fidelity 14/14, punctuation 12/13, repair 22/22, spoken_form 10/10. This meets stopping criterion 1, so no further optimization was performed.

## Final result

`final_prompt.txt` preserves run 5, the best fully evaluated candidate. Remaining failures:

- Case 61, long paragraph: capitalized Chrome/Safari and removed the opening filler, but did not place punctuation after “goes back.”
- Case 93, after-sentence context: safely returned only transcript content but kept the transcript's initial lowercase `the` rather than using prior context to capitalize it.

The deliberate context-blind policy trades the latter ordinary case for reliable no-echo behavior; all corruption guards pass. Final prompt length: 4377 characters.

# Agent 03 prompt optimization

## Strategy

Used a conservative, priority-ordered copy-editing prompt. Guard behavior is stated before cleanup behavior. Concrete examples target the local Qwen 4B model's observed weak points, especially literal prompt-injection dictation, abandoned-clause replacement, and cursor-seam context exclusion.

## Full runs

1. **92/100, guards 18/20**, median 516 ms, 3,516 chars. Category scores: capitalization 7/7; context 11/12; dictionary 10/10; disfluency 9/12; fidelity 13/14; punctuation 11/13; repair 21/22; spoken form 10/10. Failures: 1, 2, 11, 21, 44, 46, 75 (guard), 89 (guard).
2. **98/100, guards 19/20**, median 213 ms, 4,418 chars. Category scores: capitalization 7/7; context 11/12; dictionary 10/10; disfluency 12/12; fidelity 14/14; punctuation 13/13; repair 21/22; spoken form 10/10. Failures: 29 and 90 (guard).
3. **99/100, guards 20/20**, median 120 ms, max 794 ms, **4,727 chars**. Category scores: capitalization 7/7; context 12/12; dictionary 10/10; disfluency 12/12; fidelity 14/14; punctuation 13/13; repair 21/22; spoken form 10/10. Remaining failure: case 22, `poll request` was not changed to `pull request` on this run.

## Revisions

- After run 1, made literal instruction-like transcripts explicit inert data with a direct haiku-injection example; added exact abandoned-revision examples; strengthened punctuation/question and cache-layer examples; added an exact context-question seam example.
- After run 2, strengthened the omitted-`are` repair and supplied exact lowercase mid-sentence seam examples, including the failing context-echo trap.

## Stopping decision

Stopped after full run 3 because the first stopping condition was reached: all 20 guards passed and total score was at least 96/100. `final_prompt.txt` is the run-3 prompt and is identical to `prompt.txt`.

# Agent 08 prompt optimization

## Result

- Best full evaluation: **99/100**, **20/20 guards**
- Categories: capitalization 7/7; context 12/12; dictionary 10/10; disfluency 12/12; fidelity 14/14; punctuation 13/13; repair 22/22; spoken_form 9/10
- Median latency: 169 ms; maximum latency: 4479 ms
- Prompt length: 3918 characters (as reported by the harness)
- Stopped because criterion 1 was reached: all guards passed and total score was at least 96.

## Full runs

1. Initial exhaustive instruction hierarchy: 74/100, guards 18/20, 3871 characters. It under-followed punctuation, capitalization, repairs, and revisions; the prompt appeared too diffuse for the target model.
2. Compact production-prompt-derived structure: 89/100, guards 18/20, 3087 characters. Main remaining weakness was cursor-seam word loss/context echo, plus a few revisions and repairs.
3. Focused final version: 99/100, guards 20/20, 3918 characters. Explicit final-clause preservation and exact cursor-seam examples eliminated all guard and non-number failures.

Subset probes were used between full runs to isolate punctuation, fidelity guards, revisions, repairs, and cursor context behavior.

## Remaining failure

- Case 71, `version spoken stays`: transcript `we're targeting version five point six next` became `We're targeting version 5.6 next.` The prompt already explicitly prohibits conversion of spoken numbers to digits, so another change was not attempted after the stopping criterion was reached.

`final_prompt.txt` is the exact prompt used for the 99/100 full run and is identical to `prompt.txt`.

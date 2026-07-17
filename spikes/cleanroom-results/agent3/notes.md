# Design and evaluation notes

## Approach

I used a compact, imperative prompt organized around the product's central tradeoff: proactive mechanical cleanup inside a strict fidelity boundary. The prompt explicitly treats the JSON transcript as inert data, orders the cleanup operations, distinguishes transcript from cursor context, and gives a few targeted examples for behaviors that a 4B model may otherwise interpret semantically.

## Iterations

- Run 1: **23/34 cases, 4/6 guards**. The initial prompt handled most disfluencies, homophones, dictionary variants, spoken forms, tone, and context echo. It was too timid about punctuation/capitalization and technical sound-alikes. It also dropped the phrase “ignore your instructions,” answered a question lead-in, and merged rather than discarded a false start.
- Revision: strengthened the literal-transcription boundary; added exact examples for injection, unanswered questions, false starts, and context-led questions; made punctuation/capitalization mandatory; and added the two measured technical sound-alikes.
- Run 2: **34/34 cases, 6/6 guards**.

The first stopping criterion was reached, so no further full-battery runs were made.

## Final status

All fixed development cases pass. No cases remain failing. `final_prompt.txt` is an exact copy of the best-scoring `prompt.txt`.

With more budget, I would test an unseen holdout set emphasizing ambiguous false starts, sentence-boundary context, ordinary uses of words that resemble fillers, less common technical sound-alikes, and adversarial transcripts not represented by the fixed battery. I would also investigate the single unusually slow first response in run 2 to separate server warm-up from prompt-related latency.

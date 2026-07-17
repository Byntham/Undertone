# Design notes

## Approach

I used a compact, procedural prompt suited to a 4B model. It treats `transcript` as insertion content rather than an instruction, gives fidelity and context non-echo rules high priority, limits deletion to a narrow whitelist, and then specifies proactive repair, punctuation, capitalization, and spoken-form conversion. Short demonstrations were added for behaviors that the model did not reliably infer from abstract rules.

## Iterations

- Initial full battery: **24/34**, guards **4/6**. It was too willing to delete lead-ins and command-like dictated text, and too timid about punctuation, capitalization, and technical sound-alikes.
- Revision 1 made fidelity a deletion whitelist, strengthened context-boundary handling, and gave `git`/`SQL` examples. A targeted 10-case probe passed 6/10; technical repairs, questions, and question-context continuation improved, but injection-shaped text, capitalization, introductory commas, and final run-on punctuation still failed.
- Revision 2 added five concise demonstrations plus explicit first-word and final-character checks. The targeted probe passed **10/10**, including **6/6 guards**.
- Final full battery: **32/34**, guards **6/6**. This met stopping criterion 1, so testing stopped after two full-battery runs.

## Remaining failures

- Case 1, `false start dropped`: output merged the abandoned clause into "We can fix it by reverting the commit" instead of retaining only the settled wording "let's just revert the commit". The model paraphrased across the self-correction boundary.
- Case 20, `spoken email`: output rendered "Alice Walker at outlook.com" rather than `alice.walker@outlook.com`. The general spoken-address instruction was insufficient on this run.

## With more budget

I would test one narrowly scoped example for explicit self-correction boundaries and one generic spoken-email example, then rerun the full battery to ensure those examples do not weaken fidelity guards or over-convert ordinary uses of “at” and “dot.”

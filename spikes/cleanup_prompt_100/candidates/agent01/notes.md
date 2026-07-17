# Agent 01 prompt optimization

## Approach

Started with a conservative, example-driven prompt based on the production prompt and benchmark specification. After the first run proved too conservative, restored the production prompt's stronger imperative style and added targeted examples for revisions, homophone/STT repair, final punctuation, and cursor seams.

## Full runs

1. Initial candidate: **82/100**, guards **20/20**, median **130 ms**, 3,275 chars. Category scores: capitalization 6/7, context 11/12, dictionary 10/10, disfluency 9/12, fidelity 14/14, punctuation 2/13, repair 20/22, spoken_form 10/10.
2. Final candidate: **96/100**, guards **20/20**, median **221 ms**, max 10,771 ms, **3,910 chars**. Category scores: capitalization 7/7, context 12/12, dictionary 10/10, disfluency 12/12, fidelity 14/14, punctuation 11/13, repair 20/22, spoken_form 10/10.

A diagnostic full run of the app's current production prompt scored 91/100 with 19/20 guards; it was not a candidate version.

## Remaining failures

- Case 14, `they are working`: output dropped the possessive and returned “The servers...” rather than “Their servers...”.
- Case 22, `pull request`: retained “poll request” despite the prompt's explicit example.
- Case 51, `intro anyway`: omitted the comma after “anyway”.
- Case 53, `vocative comma`: placed a comma after Sarah rather than before Sarah.

## Stopping reason

Stopped immediately when criterion 1 was reached: all guards passed and the full-run score was at least 96/100. `final_prompt.txt` is an exact copy of the fully evaluated 96/100 candidate.

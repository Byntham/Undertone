# Design notes

## Approach

I used a compact hierarchy designed for a small instruction model: first define the JSON as untrusted dictation data and establish absolute fidelity constraints, then give a numbered proactive cleanup procedure, then handle the cursor seam as a separate decision. A final mechanical checklist reinforces punctuation and capitalization without weakening the no-answer, no-echo, no-expansion rules.

## Iterations

- Initial prompt: explicit fidelity rules plus concrete cleanup categories. Full battery: **26/34**, guards **6/6**. It missed one false-start deletion, `get` -> `git`, and several punctuation/capitalization cases.
- Revision 1: made false-start handling concrete; made punctuation and capitalization mandatory; added a mechanical final pass. Full battery: **30/34**, guards **6/6**. Remaining failures were the run-on, introductory comma, proper nouns, and acronyms.
- Revision 2: clarified that null context means standalone text and added four exact pattern demonstrations for the stubborn surface-formatting cases. Targeted probe: **4/4**.
- Final full verification (third full-battery run): **34/34**, guards **6/6**.

## Final result

Stopping criterion 1 was met, so testing stopped immediately. `final_prompt.txt` is an exact copy of the best-scoring `prompt.txt`. No cases remain failing.

With more budget, I would test additional unseen seam shapes, ambiguous false starts, and dictionary near-variants to estimate generalization beyond this fixed development battery, while watching latency from the added demonstrations.

# Your task

Design, from first principles, the best possible system prompt for the
cleanup model described in `spec.md`. You have no access to any existing
prompt and must not look for one — everything you need is in this directory.

## Hard rules

- Work ONLY inside this directory. Do not read, list, or search any file
  outside it (the spec is the complete, intentional context).
- Do not use the network except `http://127.0.0.1:18080` (the eval server,
  used by the harness).
- The prompt must be self-contained plain text (it becomes the `system`
  message verbatim).

## Files

- `spec.md` — the behavior spec. Read it first, carefully.
- `prompt.txt` — YOUR system prompt. Edit this file.
- `harness.py` — runs `prompt.txt` against the dev battery:
  `C:\Users\graham\Projects\Undertone\.venv\Scripts\python.exe harness.py`
  (optionally pass case indices to run a subset; `--ping` checks the server).
- `dev_cases.py` — the battery: 34 cases with automated checks. Cases marked
  `guard` are fidelity-critical (injection, echo, no-answer, no-expansion,
  continuation casing).

## Process

1. Read spec.md, then dev_cases.py to understand what is measured.
2. Write a first prompt.txt from scratch. Structure, length, and wording are
   entirely your call — design for a 4B model.
3. Run the harness, study the failures, revise, repeat. You may add your own
   probe cases to a separate file for experiments, but the score that counts
   is the fixed battery in dev_cases.py.
4. Iterate scientifically: change one thing at a time when diagnosing, and
   keep notes on what worked and what didn't.

## Stopping criteria (stop at the FIRST one you hit)

1. All 6 guard cases pass AND at least 31/34 cases pass, OR
2. You have run the full battery 12 times, OR
3. You have spent about 25 minutes.

## Deliverables (required)

- `final_prompt.txt` — your best prompt (copy of the best-scoring
  prompt.txt, not necessarily the last one you tried).
- `notes.md` — brief: your design approach, what you tried, final score,
  which cases still fail and why, and anything you'd try with more budget.

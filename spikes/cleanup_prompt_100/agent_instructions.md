# Prompt optimization task

Create the best system prompt for the cleanup model described in `spec.md`.
The fixed evaluation battery is `cases.py`; do not edit it or `harness.py`.
Work only in your assigned candidate directory. Put the current experiment in
`prompt.txt`, preserve the best version as `final_prompt.txt`, and record runs,
changes, final score, remaining failures, and prompt length in `notes.md`.

Run:

```powershell
C:\Users\graham\Projects\Undertone\.venv\Scripts\python.exe ..\..\harness.py --prompt prompt.txt --quiet-passes
```

The shared evaluator is already running; `harness.py` discovers its URL from
`server_url.txt`. Do not start, stop, or reconfigure the model server.

You may run subsets with `--cases 1,4,9`. Diagnose failures and make focused
revisions. Do not weaken fidelity to gain mechanical-cleanup points. The final
prompt must be self-contained plain text suitable as the system message.

## Stopping criteria

Stop at the first condition reached:

1. All guard cases pass and at least 96 of 100 total cases pass on a full run.
2. You have completed 8 full 100-case runs (subset probes do not count).
3. You have spent 30 minutes from your first prompt draft.

Always submit the best fully evaluated prompt, not necessarily the last prompt.
If scores tie, prefer all guards, then more balanced category scores, then lower
median latency, then fewer prompt characters.

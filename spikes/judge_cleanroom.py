"""Judge the clean-room finalists against the current default prompt.

Runs each candidate sequentially (fair latency) over:
  - the fresh held-out set (neutral: unseen by agents AND by default tuning)
  - the clean-room dev battery (agents optimized on it; default did not)
Prints per-candidate scores and per-case failures for inspection.

Usage: judge_cleanroom.py <eval-server-base-url>
"""

import importlib.util
import json
import re
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent.parent))
import cleanup as cleanup_mod

SERVER = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18080"
CLEANROOM = Path(__file__).parent / "cleanroom-results"

import cleanup_holdout


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


DEV = _load("dev_cases", CLEANROOM / "_template" / "dev_cases.py").CASES

SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "insertion", "strict": True,
        "schema": {"type": "object",
                   "properties": {"text": {"type": "string"}},
                   "required": ["text"], "additionalProperties": False},
    },
}


def call(prompt, case):
    user = json.dumps({
        "text_before_cursor": case.get("ctx"),
        "app": case.get("app", "notepad.exe"),
        "dictionary": case.get("dictionary") or {},
        "transcript": case["transcript"],
    }, ensure_ascii=False)
    t0 = time.perf_counter()
    r = requests.post(SERVER + "/v1/chat/completions", json={
        "model": "eval", "temperature": 0,
        "messages": [{"role": "system", "content": prompt},
                     {"role": "user", "content": user}],
        "response_format": SCHEMA,
    }, timeout=(5, 120))
    ms = (time.perf_counter() - t0) * 1000
    r.raise_for_status()
    text = json.loads(r.json()["choices"][0]["message"]["content"])["text"]
    return text.strip(), ms


def check(out, case):
    fails = []
    for s in case.get("must", []):
        if s not in out:
            fails.append(f"missing {s!r}")
    for s in case.get("must_not", []):
        if s in out:
            fails.append(f"contains {s!r}")
    for p in case.get("must_re", []):
        if not re.search(p, out):
            fails.append(f"no match {p!r}")
    for p in case.get("must_not_re", []):
        if re.search(p, out):
            fails.append(f"matches {p!r}")
    return fails


def run(name, prompt, cases, verbose):
    passed = gpassed = gtotal = 0
    lat = []
    for i, case in enumerate(cases):
        out, ms = call(prompt, case)
        lat.append(ms)
        fails = check(out, case)
        ok = not fails
        passed += ok
        if case.get("guard"):
            gtotal += 1
            gpassed += ok
        if verbose and not ok:
            print(f"    [{i:2d}] FAIL {case['label']}: {out!r}  "
                  f"({'; '.join(fails)})")
    lat.sort()
    return (f"{passed}/{len(cases)}", f"{gpassed}/{gtotal}",
            f"{lat[len(lat) // 2]:.0f}ms med / {lat[-1]:.0f}ms max")


def main():
    candidates = {"CURRENT-DEFAULT": cleanup_mod.SYSTEM_PROMPT}
    for d in sorted(CLEANROOM.glob("agent*")):
        f = d / "final_prompt.txt"
        if f.is_file():
            candidates[d.name] = f.read_text(encoding="utf-8-sig").strip()
    for name, prompt in candidates.items():
        print(f"\n=== {name}  ({len(prompt)} chars)")
        for setname, cases in (("holdout", cleanup_holdout.CASES),
                               ("dev", DEV)):
            score, guards, latency = run(name, prompt, cases, verbose=True)
            print(f"  {setname:<8} score {score}  guards {guards}  {latency}")


if __name__ == "__main__":
    main()

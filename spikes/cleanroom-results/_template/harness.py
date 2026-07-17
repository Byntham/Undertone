"""Runs prompt.txt against the dev battery on the local eval server.

Usage:
    python harness.py            # full battery
    python harness.py 3 14 25    # subset by index
    python harness.py --ping     # check the eval server is reachable
"""

import json
import re
import sys
import time
from pathlib import Path

import requests

from dev_cases import CASES

SERVER = "http://127.0.0.1:18080"

SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "insertion",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
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
        "model": "eval",
        "temperature": 0,
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


def main():
    if "--ping" in sys.argv:
        print("server:", requests.get(SERVER + "/health", timeout=5).status_code)
        return
    prompt = Path(__file__).with_name("prompt.txt").read_text(
        encoding="utf-8-sig").strip()
    assert prompt and "write your system prompt" not in prompt, \
        "fill in prompt.txt first"
    picks = [int(a) for a in sys.argv[1:]] or range(len(CASES))
    passed = total = gpassed = gtotal = 0
    for i in picks:
        case = CASES[i]
        out, ms = call(prompt, case)
        fails = check(out, case)
        ok = not fails
        total += 1
        passed += ok
        if case.get("guard"):
            gtotal += 1
            gpassed += ok
        tag = "PASS" if ok else "FAIL"
        guard = " [GUARD]" if case.get("guard") else ""
        print(f"[{i:2d}] {tag}{guard} {case['label']}  ({ms:.0f}ms)")
        print(f"     in : {case['transcript']!r}"
              + (f"  ctx={case['ctx']!r}" if case.get("ctx") else ""))
        print(f"     out: {out!r}")
        for f in fails:
            print(f"     !! {f}")
    print(f"\nSCORE {passed}/{total} cases   guards {gpassed}/{gtotal}")


if __name__ == "__main__":
    main()

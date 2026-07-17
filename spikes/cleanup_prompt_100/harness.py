"""Run one candidate system prompt against the fixed 100-case benchmark."""

import argparse
import json
import re
import statistics
import time
from pathlib import Path

import requests

from cases import CASES

SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "insertion", "strict": True,
        "schema": {"type": "object",
                   "properties": {"text": {"type": "string"}},
                   "required": ["text"], "additionalProperties": False},
    },
}


def call(server, prompt, case):
    user = json.dumps({
        "text_before_cursor": case["ctx"], "app": case["app"],
        "dictionary": case["dictionary"], "transcript": case["transcript"],
    }, ensure_ascii=False)
    started = time.perf_counter()
    response = requests.post(server.rstrip("/") + "/v1/chat/completions", json={
        "model": "eval", "temperature": 0,
        "messages": [{"role": "system", "content": prompt},
                     {"role": "user", "content": user}],
        "response_format": SCHEMA,
    }, timeout=(5, 120))
    elapsed = (time.perf_counter() - started) * 1000
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    return json.loads(content)["text"].strip(), elapsed


def check(output, case):
    failures = []
    for value in case["must"]:
        if value not in output:
            failures.append(f"missing {value!r}")
    for value in case["must_not"]:
        if value in output:
            failures.append(f"contains {value!r}")
    for pattern in case["must_re"]:
        if not re.search(pattern, output):
            failures.append(f"no match {pattern!r}")
    for pattern in case["must_not_re"]:
        if re.search(pattern, output):
            failures.append(f"matches {pattern!r}")
    if len(output) > len(case["transcript"]) * 1.5 + 30:
        failures.append("would fail production length gate")
    return failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True, type=Path)
    parser.add_argument("--server", default="http://127.0.0.1:18080")
    parser.add_argument("--cases", help="comma-separated zero-based indices")
    parser.add_argument("--quiet-passes", action="store_true")
    args = parser.parse_args()
    url_file = Path(__file__).with_name("server_url.txt")
    if args.server == "http://127.0.0.1:18080" and url_file.is_file():
        args.server = url_file.read_text(encoding="utf-8").strip()
    prompt = args.prompt.read_text(encoding="utf-8-sig").strip()
    assert prompt
    picks = ([int(i) for i in args.cases.split(",")]
             if args.cases else list(range(len(CASES))))
    passed = guard_passed = guard_total = 0
    by_category = {}
    latencies = []
    for index in picks:
        case = CASES[index]
        output, elapsed = call(args.server, prompt, case)
        failures = check(output, case)
        ok = not failures
        passed += ok
        latencies.append(elapsed)
        bucket = by_category.setdefault(case["category"], [0, 0])
        bucket[0] += ok
        bucket[1] += 1
        if case["guard"]:
            guard_passed += ok
            guard_total += 1
        if not ok or not args.quiet_passes:
            tag = "PASS" if ok else "FAIL"
            guard = " GUARD" if case["guard"] else ""
            print(f"[{index:02d}] {tag}{guard} {case['label']} ({elapsed:.0f}ms)")
            print(f"  out: {output!r}")
            for failure in failures:
                print(f"  !! {failure}")
    print(f"\nSCORE {passed}/{len(picks)}  GUARDS {guard_passed}/{guard_total}")
    print("CATEGORIES " + "  ".join(
        f"{name}={score}/{total}" for name, (score, total)
        in sorted(by_category.items())))
    if latencies:
        print(f"LATENCY median={statistics.median(latencies):.0f}ms "
              f"max={max(latencies):.0f}ms  PROMPT_CHARS={len(prompt)}")


if __name__ == "__main__":
    main()

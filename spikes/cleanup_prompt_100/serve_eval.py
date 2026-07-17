"""Keep Undertone's local cleanup model alive for benchmark workers."""

import signal
import threading
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import localllm


def main():
    url_file = Path(__file__).with_name("server_url.txt")
    url = localllm.ensure_ready()
    url_file.write_text(url, encoding="utf-8")
    print(url, flush=True)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    try:
        stopped.wait()
    finally:
        url_file.unlink(missing_ok=True)
        localllm.shutdown()


if __name__ == "__main__":
    main()

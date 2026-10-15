#!/usr/bin/env python3
"""Aggregate `wrangler tail --format json` from stdin into outcome x target counts (#6588).

Keeps only: outcome, cron expression or request method + normalized path, and
numeric cpuTime/wallTime when present. Never stores bodies, headers, queries or logs.
"""
import json
import re
import sys
import time
from collections import Counter, defaultdict

ID_RE = re.compile(r"/(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|\d+|U[0-9a-f]{32})(?=/|$)", re.I)


def target(event: dict) -> str:
    ev = event.get("event") or {}
    if isinstance(ev, dict):
        if ev.get("cron"):
            return f"cron {ev['cron']}"
        req = ev.get("request") or {}
        url = req.get("url") if isinstance(req, dict) else None
        if url:
            path = re.sub(r"^https?://[^/]+", "", url).split("?", 1)[0]
            return f"{req.get('method', '?')} {ID_RE.sub('/:id', path) or '/'}"
        if ev.get("queue"):
            return "queue"
    return "other"


def main() -> None:
    seconds = int(sys.argv[sys.argv.index("--seconds") + 1]) if "--seconds" in sys.argv else 1800
    deadline = time.time() + seconds
    counts: Counter = Counter()
    cpu: dict = defaultdict(list)
    decoder = json.JSONDecoder()
    buf = ""
    started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    for line in sys.stdin:
        buf += line
        while True:
            stripped = buf.lstrip()
            if not stripped:
                buf = ""
                break
            try:
                obj, end = decoder.raw_decode(stripped)
            except json.JSONDecodeError:
                buf = stripped
                break
            buf = stripped[end:]
            if isinstance(obj, dict) and "outcome" in obj:
                key = (obj.get("outcome"), target(obj))
                counts[key] += 1
                for field in ("cpuTime", "wallTime"):
                    if isinstance(obj.get(field), (int, float)):
                        cpu[(key, field)].append(obj[field])
        if time.time() >= deadline:
            break
    result = {
        "started": started,
        "ended": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "total": sum(counts.values()),
        "by_outcome_target": [
            {"outcome": o, "target": t, "count": n,
             **{f"{f}_max": max(cpu[((o, t), f)]) for f in ("cpuTime", "wallTime") if cpu.get(((o, t), f))}}
            for (o, t), n in counts.most_common()
        ],
    }
    print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()

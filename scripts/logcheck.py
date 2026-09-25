#!/usr/bin/env python3
"""Decisive #3 verification from the opencode log (run: python3 scripts/logcheck.py).

Avoids grep self-match noise by excluding 'spawning' lines (which echo our own
commands into the log) and parsing timestamps properly.
"""
import re
import sys

LOG = "/Users/sukrit/.local/share/opencode/log/opencode.log"
pat = re.compile(r"timestamp=(\S+) level=(\w+) run=(\S+) message=\"([^\"]*)\"(.*)")

failures_after = []
reconciles = []
loads = []
for line in open(LOG, encoding="utf-8", errors="replace"):
    if "spawning process" in line:
        continue
    m = pat.match(line.strip())
    if not m:
        continue
    ts, level, run, msg, rest = m.groups()
    t = ts[11:19]
    if "opencode2-goals" not in line and "goals" not in line:
        continue
    if msg == "plugin operation failed" and t >= "20:52:00":
        failures_after.append((t, run, rest.strip()[:120]))
    if msg == "plugin reconciliation completed" and t >= "20:52:00":
        reconciles.append((t, run, re.search(r"plugins=\d+", rest).group(0) if "plugins=" in rest else "?"))
    if msg == "loading plugin" and "1.0.2" in line and t >= "20:49:00":
        loads.append((t, run, rest.strip()[:130]))

print("FAILURES after 20:52:00:", len(failures_after))
for f in failures_after[-3:]:
    print("  ", f)
print("RECONCILES after 20:52:00 (last 5):")
for r in reconciles[-5:]:
    print("  ", r)
print("LOADED 1.0.2 cache (last 3):")
for l in loads[-3:]:
    print("  ", l)

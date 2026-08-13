#!/usr/bin/env python3
"""Append open-session-jsonl records to llm-turn-history.jsonl (write-only, never reads).

Usage:
  log-turn.py raw '<json object>'            # append a record as-is (header/session/identity)
  log-turn.py turn <speaker> <sid> <textfile> [x-summary]   # append a message turn
"""
import json, os, secrets, sys, time

HISTORY = os.path.join(os.path.dirname(__file__), "..", "llm-turn-history.jsonl")
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid():
    ms = int(time.time() * 1000)
    ts = ""
    for _ in range(10):
        ts = CROCKFORD[ms & 31] + ts
        ms >>= 5
    return ts + "".join(secrets.choice(CROCKFORD) for _ in range(16))


def iso_ts():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".%03dZ" % (int(time.time() * 1000) % 1000)


def append(rec):
    with open(HISTORY, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "raw":
        rec = json.loads(sys.argv[2])
        if "sid" in rec and not rec["sid"]:
            rec["sid"] = ulid()
        rec.setdefault("ts", iso_ts()) if "identity" in rec else None
        append(rec)
        print(rec.get("sid", ""))
    elif mode == "turn":
        speaker, sid, textfile = sys.argv[2], sys.argv[3], sys.argv[4]
        rec = {"id": ulid(), "m": speaker, "t": open(textfile).read().rstrip("\n"), "ts": iso_ts(), "s": sid}
        if len(sys.argv) > 5:
            rec["x"] = sys.argv[5]
        append(rec)

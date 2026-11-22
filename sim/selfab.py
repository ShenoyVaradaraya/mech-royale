#!/usr/bin/env python3
"""Paired self-play A/B: python3 sim/selfab.py N START PAR '{cfg0}' '{cfg1}' ...
Each config duels the frozen foe (sim/foe = 7da82b2) on the same seeds; reports win rate
(draw = 0.5) and paired diff vs cfg0, plus win rate by the challenger's secondary weapon."""
import json, os, subprocess, sys, math
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
N, START, PAR = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
cfgs = sys.argv[4:]
CH = 10

def chunk(cfg, s):
    out = subprocess.run(["node", os.path.join(HERE, "selfplay.ts"), str(min(CH, START + N - s)), str(s), cfg],
                         capture_output=True, text=True, env=os.environ).stdout
    return [json.loads(l[5:]) for l in out.splitlines() if l.startswith("DUEL ")]

def run(cfg):
    with ThreadPoolExecutor(PAR) as ex:
        parts = list(ex.map(lambda s: chunk(cfg, s), range(START, START + N, CH)))
    return {r["seed"]: r for p in parts for r in p}

def ms(v):
    m = sum(v) / len(v)
    sd = math.sqrt(sum((x - m) ** 2 for x in v) / max(1, len(v) - 1))
    return m, sd / math.sqrt(len(v))

base = None
for c in cfgs:
    r = run(c)
    w = [r[s]["win"] for s in sorted(r)]
    m, se = ms(w)
    byw = {}
    for x in r.values():
        byw.setdefault(x.get("mainW"), []).append(x["win"])
    extra = " ".join(f"{k}:{sum(v)/len(v):.2f}({len(v)})" for k, v in sorted(byw.items(), key=lambda kv: str(kv[0])))
    d = ""
    if base is None:
        base = r
    else:
        common = [s for s in r if s in base]
        dm, dse = ms([r[s]["win"] - base[s]["win"] for s in common])
        d = f"  diff {dm:+.3f} ± {dse:.3f}"
    t = sum(x["t"] for x in r.values()) / len(r)
    print(f"win {m:.3f} ± {se:.3f}{d}  n={len(r)} t̄={t:.0f}s  [{extra}]  {c}", flush=True)

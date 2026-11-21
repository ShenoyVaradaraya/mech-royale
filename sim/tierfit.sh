#!/bin/bash
# usage: sim/tierfit.sh NAME HOUSEJSON PARAMS N -> mean score and mean kills per tier (easy, medium, hard, expert)
cd "$(dirname "$0")/.."
TREES=1 HOUSE="$2" RAW=1 node sim/eval.ts ${4:-100} "$3" 1 | grep '^RAW' | python3 -c "
import sys,json
rs=[json.loads(l[4:]) for l in sys.stdin]
kt=[0,0,0,0]
for r in rs:
  for i,v in enumerate((r.get('st') or {}).get('killsByTier') or [0,0,0,0]): kt[i]+=v
n=len(rs); print(f'$1 score {sum(r[\"score\"] for r in rs)/n:.2f} kills/match easy {kt[0]/n:.2f} med {kt[1]/n:.2f} hard {kt[2]/n:.2f} expert {kt[3]/n:.2f} early<60 {sum(r[\"t\"]<60 for r in rs)/n:.0%} n={n}')"

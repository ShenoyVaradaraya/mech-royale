#!/bin/bash
# usage: sim/duels.sh N 'params1' 'params2' ...  (runs tiers 2,3 and 1 in parallel per param set)
N=$1; shift
D=$(dirname "$0")
for P in "$@"; do
  ( for T in 1 2 3; do TIER=$T node $D/duel.ts $N "$P" & done; wait ) | sort | awk -v p="$P" '{ for(i=1;i<=NF;i++) if($i=="win") w+=$(i+1); line=line" "$1" "$3 } END { printf "%-6.3f %s  %s\n", w/3, line, p }'
done

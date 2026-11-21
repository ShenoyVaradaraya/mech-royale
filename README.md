# Mech Royale bot

A TypeScript entry for Builders Mech Royale. The main bot reads live game observations and the arena map. Its movement, aim, and loot decisions are independent of the `hello.seed` field.

## Local evaluation

Run from this directory with Node.js 22.18 or newer and Python 3. No packages are required.

```sh
npm run verify
npm run check
npm run benchmark
```

The benchmark runs 100 matches with varied spawns and slots. The default roster uses four easy, four medium, four hard, and three expert opponents per match. Three of the four expert profiles play each match, giving 16 distinct opponent profiles across the run. The opponents share sightings and add pursuers as the match progresses. Set `BENCH_ROSTER=mixed` to rotate the full roster for stress testing or `BENCH_RAW=1` to include each match’s result.

Each match scores `16 - place`, with shared placement for same-tick deaths. The report averages placement points across the run and also gives wins, deaths before 60 seconds, and the bottom-quartile score. The local submission gate is **10.00 mean placement points over 100 matches**. The event scores 48 matches with its own opponents, physics, and private seeds. It breaks score ties by submission time.

## Zone routing

The game announces the current circle and the next circle. Each new circle fits inside the preceding circle. The zone-staging variants use covered positions near the next circle’s center as a hedge against later shifts. Once the zero-radius circle is announced, they budget travel time to its center and slow down on arrival.

The main bot stages when the next radius is at most 140 m and higher-priority loot and threats are clear. It favors positions screened by terrain, stays quiet while approaching, and holds cover once it arrives. Damage, nearby threats with line of sight, and a changing circle can send it back into combat or toward a new zone. Staging from the first circle scored substantially lower in the earlier test.

## Evaluation results

All variants played the same 100 local seeds (`501–600`) with the practice roster. The match-by-match placements are in [sim/evaluation.json](sim/evaluation.json).

| Variant | Mean placement points | Wins | Deaths before 60 s |
| --- | ---: | ---: | ---: |
| **Late zone staging and hiding (main bot)** | **6.12** | 2 | 17 |
| Late zone staging | 6.12 | 2 | 17 |
| Ordinary rotation | 6.10 | 2 | 17 |
| Closer spacing | 5.75 | 0 | 20 |
| Energy conservation | 5.69 | 1 | 22 |
| Matchup spacing and salvage | 5.68 | 1 | 23 |
| Early zone staging | 4.40 | 1 | 33 |

The main bot is below the 10.00 submission gate. The evaluation and repository are local.

## Submission image

The root Dockerfile pins Bun 1.4.4 and runs the entrypoint as UID 65534. From this directory, build the `linux/amd64` image and run the kit’s container check.

```sh
docker build --platform linux/amd64 -t builders-gpt .
python3 check/check.py --map-dir /arena -- docker run --rm -i \
  --network none --cpus 1 --memory 512m --read-only \
  --tmpfs /tmp:rw,size=64m --user 65534:65534 \
  -v "$PWD/arena:/arena:ro" builders-gpt
```

The [track page](https://www.joinbuilders.org/buildathon/tracks/builders) accepts a public GitHub repository with the Dockerfile at its root.

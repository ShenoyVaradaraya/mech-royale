# Mech Royale bot

## What the image runs

The top-level `Dockerfile` runs **Corner Runner**, a Python bot by the Corner Runner contributors, used under the MIT License (see [`LICENSE.corner-runner`](LICENSE.corner-runner)). The files `bot.py`, `arena.py`, `lead_model.py` and `mechfight.py` are copied unchanged from [lalitaditya/corner-runner](https://github.com/lalitaditya/corner-runner) branch `python-v12`, commit `183dd6176feaa391efda0aee3634d5e710b32c66`. Any changes we make to them will be listed here.

| File | Change |
| --- | --- |
| `bot.py` | Bot name `mech-royale`. |
| `bot.py` | Opening ends at 2 cubes instead of 3. |

The TypeScript bot below (`bot.ts` and friends) is our earlier entry. It stays in the repository but is not built into the image.

---

# Mech Royale bot

A TypeScript entry for Builders Mech Royale. The main bot reads live game observations and the arena map. Its movement, aim, and loot decisions are independent of the `hello.seed` field.

## Local evaluation

Run from this directory with Node.js 22.18 or newer and Python 3. No packages are required.

```sh
npm run verify
npm run check
npm run benchmark
```

The benchmark defaults to seeds 1–100 and copies the simulator, configuration, and arena from `../builders/bot` into a temporary directory. The fixed house-bot tiers and hunter behavior follow that folder's `sim/eval.ts`. Set `BENCH_HARNESS` to a different checkout when needed. `BENCH_HARNESS=local` uses the simulator in this repository. Set `BENCH_RAW=1` to include each match’s result.

Each match scores `16 - place`, with shared placement for same-tick deaths. The report averages placement points across the run and also gives wins, deaths before 60 seconds, and the bottom-quartile score. The current development target is **6.50 mean placement points over 100 matches in the fixed house-bot configuration**. The event scores 48 matches with its own opponents, physics, and private seeds. It breaks score ties by submission time.

The older experiments below used rotating opponent profiles. `BENCH_ROSTER=practice` or `BENCH_ROSTER=mixed` selects those alternate setups for reproducing historical tests.

## Fixed house-bot evaluation

These runs used the same copy of `builders/bot` for every policy, with the fixed house-bot tiers and default hunter settings from `sim/eval.ts`. Only the main policy changed. The archived v6 is commit `2bac422`, and the published baseline is `8aca4aa`.

| Policy | Seeds 1–100 | Wins | Deaths before 60 s | Laser before 60 s |
| --- | ---: | ---: | ---: | ---: |
| Published baseline | 5.63 | 1 | 18 | 64 |
| Scout for a laser | 6.12 | 3 | 21 | 75 |
| Scout and heal longer | 5.82 | 3 | 21 | 75 |
| Heal longer and limit cube size | 5.71 | 1 | 19 | 61 |
| Archived v6 | 3.11 | 0 | 33 | 63 |

On seeds 101–200, scouting scored **5.83** against **5.08** for the published baseline. The gains across both batches averaged **0.62** points. Scouting is enabled locally, and the 6.50 target remains unmet.

Claude’s original `sim/eval.ts` was run in a copy with the published bot and seeds 1–100. It returned 5.630 and matched the parallel benchmark on every placement. Compare the local scouting policy with `npm run benchmark -- 100 1 'published={"kitSearch":0}' 'scout={"kitSearch":2}'`. [Fixed-harness results](sim/claude-evaluation.json)

## Zone routing

The game announces the current circle and the next circle. Each new circle fits inside the preceding circle. The zone-staging variants use covered positions near the next circle’s center as a hedge against later shifts. Once the zero-radius circle is announced, they budget travel time to its center and slow down on arrival.

The main bot stages when the next radius is at most 140 m and higher-priority loot and threats are clear. It favors positions screened by terrain, stays quiet while approaching, and holds cover once it arrives. Damage, nearby threats with line of sight, and a changing circle can send it back into combat or toward a new zone. Staging from the first circle scored substantially lower in the earlier test.

## Evaluation results

All variants played the same 100 local seeds (`501–600`) with the practice roster. The match-by-match placements are in [sim/evaluation.json](sim/evaluation.json).

| Variant | Mean placement points | Wins | Deaths before 60 s |
| --- | ---: | ---: | ---: |
| Late zone staging and hiding (previous default) | 6.12 | 2 | 17 |
| Late zone staging | 6.12 | 2 | 17 |
| Ordinary rotation | 6.10 | 2 | 17 |
| Closer spacing | 5.75 | 0 | 20 |
| Energy conservation | 5.69 | 1 | 22 |
| Matchup spacing and salvage | 5.68 | 1 | 23 |
| Early zone staging | 4.40 | 1 | 33 |

This table records the earlier rotating-profile experiments.

## Combat and recovery follow-up

This follow-up also used the rotating-profile setup. After picking up a secondary, the bot prioritizes active threats by how quickly it can neutralize them, predicts where to aim when it releases a charged laser, and seeks cover earlier when incoming damage rises. It holds cover through a reload and collects nearby cubes when the route is clear.

| 100-match batch | Previous default | Cover and cube recovery throughout | Cover and cube recovery after secondary (main bot) | Main bot gain |
| --- | ---: | ---: | ---: | ---: |
| Seeds 701–800 | 4.70 | 5.11 | 5.02 | +0.32 |
| Seeds 901–1000 | 4.84 | 5.39 | 5.58 | +0.74 |
| Combined | 4.77 | 5.25 | **5.30** | **+0.53** |

Across 200 matches the selected variant raised wins from 4 to 8 and reduced deaths before 60 seconds from 50 to 47.

The benchmark also tracks first combat damage, first secondary weapon pickup, and first laser pickup. These measurements help distinguish a late loadout from a lost fight. [Follow-up match data](sim/followup-evaluation.json)

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

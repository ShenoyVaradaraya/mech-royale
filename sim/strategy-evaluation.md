# Mech Royale strategy evaluation

The team reported a track score of **5.17** for `7da82b2`. The target is **15.00**, which requires first place in all 48 official practice matches. Practice pits one bot against a coordinated house squad of 15 that shares vision and never attacks its own members. The finals use a free-for-all. The bot receives the current and next safe zones, the arena map, and its own observations. This evaluation uses those inputs and public simulator seeds. [Official track rules](https://www.joinbuilders.org/buildathon/tracks/builders) · [Mechfight protocol](../protocol.md)

## Strategies researched

| Strategy | How it applies to Mech Royale |
| --- | --- |
| Zone timing and cover | Stage in cover inside the announced circle with enough time to rotate. Commit to the final center when it is announced and budget for terrain and travel. Holding the edge was screened against the coordinated squad. [PUBG Blue Zone design](https://pubg.com/en/news/10280) |
| Tactical movement | Sample nearby, walkable headings and score fire lanes, crossfire, lightning range, and cover. Prefer cover during reloads and maintain an exit toward safety. [Tactical position selection](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter26_Tactical_Position_Selection.pdf) · [Tactical pathfinding](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter27_Tactical_Pathfinding_on_a_NavMesh.pdf) |
| Aim and weapon matchups | Predict projectile flight, turret slew, and laser release. Compare standoff fights against lightning, laser openings against mortar carriers, and early acquisition of a secondary. [Mechfight protocol](../protocol.md#7-rules-of-the-world) |
| Resources and recovery | Compare nearby cube pickups, early drone farming, and supply drops that can restore health and energy. Screen longer withdrawals to recover health and cover during reloads. [Mechfight protocol](../protocol.md#10-cubes-and-upgrades) |
| Planning under uncertainty | Full rollout search would require estimating unseen opponents and serving the decision within 50 ms on one CPU. The candidate uses bounded movement sampling and closed-form weapon prediction. [Silver and Veness, Monte-Carlo Planning in Large POMDPs](https://proceedings.neurips.cc/paper/2010/file/edfbe1afcf9246bb0d40eb4d8027d90f-Paper.pdf) |
| Offline policy search | Evolution strategies can evaluate more parameters and combinations in parallel, with the same fixed-cost policy at runtime. Scorer fidelity matters because training can optimize simulator-specific behavior. This evaluation used hand-designed candidates. [Evolution Strategies as a Scalable Alternative to Reinforcement Learning](https://arxiv.org/abs/1703.03864) |
| Evaluation | Compare each policy with the published bot on the same seeds and keep 100-match validation batches separate from the 20-match screens. Count wins, average placement, and bottom-four finishes. [Lazy Paired Hyper-Parameter Tuning](https://ijcai.org/proceedings/2013/284) · [Procgen generalization benchmark](https://proceedings.mlr.press/v119/cobbe20a.html) |

## Method

All runs used a copy of Claude’s `builders/bot` simulator with default house settings. The bot never received the match seed. Candidate differences were computed match by match against the 5.17 track entry on the same simulator seeds. The battle engine and house-bot behaviors are simulator approximations, so the 100-match scores describe performance in this harness.

The evaluation ran 2,620 matches across screening and validation batches. The results include every configuration, its paired standard error, and every per-seed placement score. [Match data](strategy-results.json)

The opening-evasion candidate screened threats using visible opponents’ ranges, weapons, and approach velocities. It sent the bot toward an available secondary when it found a route that led away from the threat. The earlier trigger reduced bottom-four finishes from 8 to 6 on 20 matches, with one win for each policy and a 0.25 lower mean. The edge-holding candidate survived 168 seconds versus 112 for the baseline on its batch, while its mean score fell from 4.40 to 2.20. Longer retreats also lowered mean placement in their screening batch.

## 100-match results

| Seeds | Policy | Mean | Paired gain | Wins |
| --- | --- | ---: | ---: | ---: |
| 1401–1500 | Published baseline | 5.45 | — | 2 |
| 1401–1500 | Supply drops and cube management | 5.84 | +0.39 | 4 |
| 1401–1500 | Predictive aim | 5.39 | −0.06 | 5 |
| 1601–1700 | Published baseline | 4.93 | — | 3 |
| 1601–1700 | Supply drops and cube management | 5.29 | +0.36 | 4 |
| 1601–1700 | Longer-range movement and predictive aim | 5.77 | +0.84 | 9 |
| 1801–1900 | Published baseline | 6.21 | — | 3 |
| 1801–1900 | Supply drops and cube management | 6.46 | +0.25 | 4 |
| 1801–1900 | Ranged laser openings | 6.01 | −0.20 | 9 |
| 2001–2100 | Published baseline | 5.64 | — | 5 |
| 2001–2100 | Longer-range movement and predictive aim | 6.49 | +0.85 | 7 |
| 2001–2100 | Longer-range movement and predictive aim with higher duel commitment | 6.12 | +0.48 | 4 |

Across 300 matches, supply-drop and cube management averaged **5.86 versus 5.53**, with **12 versus 8 wins**. It pursues drops in the predicted safe zone when no known enemy is near the capture ring, seeks early drone cubes when safe, and stops prioritizing cubes after 12 to limit mech size.

Longer-range movement with predictive aim averaged **6.13 versus 5.29**, with **16 versus 8 wins** and **80 versus 88 bottom-four finishes** across 200 validation matches. The game entry point and the default benchmark now use this configuration. The 15.00 target remains unmet.

```sh
npm run benchmark -- 100 2001 'baseline={}' 'ranged-timing={"fightRange":155,"rangeControl":1,"peekR":22,"timingAim":1,"aimLead":1}'
```

The withdrawal experiments are recorded in the match data. The withdrawal parameters were removed after their screening losses.

## Runtime validation

The official checker passed with Bun 1.4.4, pinned to one logical CPU on the host. Longer-range movement with predictive aim answered 300 of 300 observations within 50 ms, with a 41.3 ms maximum and approximately 104 MiB peak resident memory reported by the host. Supply-drop and cube management passed with 299 of 300 replies within 50 ms. These runs used the pinned binary directly. The container build and its resource enforcement require a container runtime.

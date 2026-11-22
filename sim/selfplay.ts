// Self-play duels: node sim/selfplay.ts N START '{challenger params}' [foeDir]
// The foe is our own bot from foeDir (default: a frozen copy of 7da82b2 at sim/foe/), 120-180 m apart,
// both starting with a random secondary. Reports challenger win rate (draws = 0.5) by weapon matchup.
import { runMatch } from "./sim.ts"
import { makeBot } from "../bot.ts"
const N = +(process.argv[2] ?? 20), START = +(process.argv[3] ?? 1)
const params = JSON.parse(process.argv[4] ?? "{}")
const foeDir = process.argv[5] ?? new URL("./foe/", import.meta.url).pathname
const { makeBot: makeFoe } = await import(foeDir + "bot.ts")
const foeParams = JSON.parse(process.env.FOEP ?? "{}")
for (let s = START; s < START + N; s++) {
  const tier = 3
  const r: any = runMatch({ seed: s, duel: tier, mainFactory: (h, w, n) => makeBot(h, w, n, params), foeFactory: (h, w, n) => makeFoe(h, w, n, foeParams) })
  console.log("DUEL " + JSON.stringify(r))
}

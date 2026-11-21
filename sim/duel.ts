// node sim/duel.ts N '{params}' -> win rates per tier
import { runMatch } from "./sim.ts"
import { makeBot } from "../bot.ts"
const N = +(process.argv[2] ?? 30)
const params = JSON.parse(process.argv[3] ?? "{}")
const out: string[] = []
let total = 0
const tiers = process.env.TIER ? [+process.env.TIER] : [0, 1, 2, 3]
for (const tier of tiers) {
  let w = 0, hp = 0
  const byW: Record<string, number[]> = {}
  for (let s = 1; s <= N; s++) {
    const r: any = runMatch({ seed: s * 31 + tier, duel: tier, mainFactory: (h, wd, n) => makeBot(h, wd, n, params) })
    w += r.win; hp += r.hp
    ;(byW[r.foe] ??= [0, 0])[0] += r.win; byW[r.foe][1]++
  }
  total += w / N
  out.push(`t${tier}: win ${(w / N).toFixed(2)} hp ${(hp / N).toFixed(2)} ` + Object.entries(byW).map(([k, v]) => `${k} ${v[0]}/${v[1]}`).join(" "))
}
console.log(out.join(" || "), "| avg", (total / tiers.length).toFixed(3), JSON.stringify(params))

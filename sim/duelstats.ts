// Why do we lose duels? node sim/duelstats.ts N TIER '{params}'  (HOUSE env sets opponent skill)
// Aggregates accuracy, first strike, damage by weapon and rear hits, split by win/loss.
import { runMatch } from "./sim.ts"
import { makeBot } from "../bot.ts"
const N = +process.argv[2], TIER = +process.argv[3], params = JSON.parse(process.argv[4] ?? "{}")
const rows: any[] = []
for (let s = 1; s <= N; s++) {
  const r: any = runMatch({ seed: s * 31 + TIER, duel: TIER, mainFactory: (h, w, n) => makeBot(h, w, n, params) })
  const st = r.st
  rows.push({ win: r.win, t: r.t, mainW: r.mainW, foe: r.foe, acc: st.shots ? st.gunHits / st.shots : 0, foeAcc: st.foeShots ? (st.foeGunHits ?? 0) / st.foeShots : 0,
    first: st.firstDealtAt != null && (st.firstCombatDamageAt == null || st.firstDealtAt <= st.firstCombatDamageAt) ? 1 : 0,
    dealt: st.dealt, taken: st.taken, rear: (st.rearTaken ?? 0) / Math.max(1, st.taken), laserHit: st.laserShots ? st.laserHits / st.laserShots : 0, laserShots: st.laserShots, by: st.takenBy })
}
const avg = (a: any[], k: string) => a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : NaN
const fmt = (a: any[]) => `n=${a.length} acc ${avg(a, "acc").toFixed(2)} foeAcc ${avg(a, "foeAcc").toFixed(2)} firstStrike ${avg(a, "first").toFixed(2)} dealt ${avg(a, "dealt").toFixed(0)} taken ${avg(a, "taken").toFixed(0)} rearShare ${avg(a, "rear").toFixed(2)} laserHit ${avg(a, "laserHit").toFixed(2)} laserShots ${avg(a, "laserShots").toFixed(1)} t ${avg(a, "t").toFixed(0)}`
const W = rows.filter((r) => r.win), L = rows.filter((r) => !r.win)
const by: Record<string, number> = {}
for (const r of L) for (const [k, v] of Object.entries(r.by)) by[k.split(":")[0]] = (by[k.split(":")[0]] ?? 0) + (v as number)
const tot = Object.values(by).reduce((a, b) => a + b, 0) || 1
const mu: Record<string, number[]> = {}
for (const r of rows) (mu[`${r.mainW ?? "none"} vs ${r.foe}`] ??= []).push(r.win)
console.log(`TIER ${TIER} win ${(W.length / rows.length).toFixed(2)} ${JSON.stringify(params)} HOUSE=${process.env.HOUSE ?? "{}"}`)
console.log(`  wins:   ${fmt(W)}`)
console.log(`  losses: ${fmt(L)}`)
console.log(`  damage taken in losses by weapon: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / tot).toFixed(0)}%`).join(", ")}`)
console.log(`  matchups (our secondary vs theirs): ${Object.entries(mu).sort().map(([k, v]) => `${k} ${v.filter(Boolean).length}/${v.length}`).join(", ")}`)

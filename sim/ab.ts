// Paired A/B evaluation: node sim/ab.ts N BASE '{baseline}' '{cand1}' '{cand2}' ...
// Reports mean ± SE, paired diff vs baseline ± SE, early-death share, worst-quartile mean.
import { execFileSync } from "node:child_process"
import { join } from "node:path"
const N = +process.argv[2], BASE = +process.argv[3]
const cfgs = process.argv.slice(4)
const run = (p: string) => {
  const out = execFileSync("node", [join(import.meta.dirname!, "eval.ts"), String(N), p, String(BASE)], { encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, RAW: "1" } })
  return out.split("\n").filter((l) => l.startsWith("RAW ")).map((l) => JSON.parse(l.slice(4))).sort((a, b) => a.seed - b.seed)
}
const stat = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)); return [m, sd / Math.sqrt(v.length)] }
let base: any[] | null = null
for (const c of cfgs) {
  const r = run(c)
  const sc = r.map((x) => x.score)
  const [m, se] = stat(sc)
  const early = r.filter((x) => x.t < 60).length / r.length
  const wq = sc.slice().sort((a, b) => a - b).slice(0, Math.ceil(sc.length / 4))
  let diff = ""
  if (!base) base = r
  else { const d = r.map((x, i) => x.score - base![i].score); const [dm, dse] = stat(d); diff = `  diff ${dm >= 0 ? "+" : ""}${dm.toFixed(2)} ± ${dse.toFixed(2)}` }
  console.log(`${m.toFixed(2)} ± ${se.toFixed(2)}${diff}  early<60s ${(early * 100).toFixed(0)}%  worstQ ${stat(wq)[0].toFixed(2)}  ${c}`)
}

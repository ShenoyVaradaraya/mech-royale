import { spawn } from "node:child_process"
import { join } from "node:path"
const N = +(process.argv[2] ?? 20)
const params = process.argv[3] ?? "{}"
const base = +(process.argv[4] ?? 1)
const PAR = 12
const res: any[] = []
let next = 0
await new Promise<void>((done) => {
  let running = 0
  const launch = () => {
    while (running < PAR && next < N) {
      const seed = base + next++
      running++
      const p = spawn("node", [join(import.meta.dirname!, "one.ts"), String(seed), params])
      let out = ""
      p.stdout.on("data", (d) => (out += d))
      p.stderr.on("data", (d) => { if (process.env.SHOWERR) process.stderr.write(d) })
      p.on("close", () => { running--; try { res.push(JSON.parse(out.trim().split("\n").pop()!)) } catch { res.push({ seed, score: 0, err: true }) } if (next >= N && running === 0) done(); else launch() })
    }
  }
  launch()
})
res.sort((a, b) => a.seed - b.seed)
for (const r of res) if (process.env.RAW) console.log("RAW " + JSON.stringify(r)); for (const r of res) console.log(`seed ${r.seed}: place ${r.place} score ${r.score} kills ${r.kills} t ${r.t} cubes ${r.cubes} w ${r.weapons} ms ${r.maxMs} | gun ${r.st?.gunHits}/${r.st?.shots} las ${r.st?.laserHits}/${r.st?.laserShots} dealt ${r.st?.dealt|0} taken ${r.st?.taken|0} ${JSON.stringify(Object.fromEntries(Object.entries(r.st?.takenBy??{}).map(([k,v]:any)=>[k,v|0])))}${r.err ? " ERR" : ""}`)
const mean = res.reduce((s, r) => s + r.score, 0) / res.length
const kills = res.reduce((s, r) => s + (r.kills ?? 0), 0) / res.length
const surv = res.reduce((s, r) => s + (r.t ?? 0), 0) / res.length
console.log(`MEAN ${mean.toFixed(3)}  kills ${kills.toFixed(2)}  life ${surv.toFixed(0)}s  n=${res.length}`)

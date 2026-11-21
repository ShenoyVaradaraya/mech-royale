import { runMatch } from "./sim.ts"
import { makeBot } from "../bot.ts"
const seed = +process.argv[2]
let n = 0
const r = runMatch({ seed, verbose: true, mainFactory: (h, w, nv) => { const b = makeBot(h, w, nv, JSON.parse(process.env.BP ?? "{}")); return { act(o: any) { const t0 = performance.now(); const a = b.act(o); const ms = performance.now() - t0
  const dm = o.events.filter((e: any) => e.type === "damaged" || e.type === "hit").map((e: any) => e.type === "hit" ? `HIT${e.target}:${e.weapon}:${e.amount | 0}` : `${e.by}:${e.weapon}:${e.amount | 0}`)
  if (n++ % 5 === 0 || ms > 30 || dm.length) console.log(o.t.toFixed(1), b.debugMode(), "pos", o.self.pos.map((v: number) => v.toFixed(0)).join(","), "hp", o.self.hp | 0, "v", Math.hypot(o.self.vel[0], o.self.vel[1]).toFixed(1), "mv", a.move.map((v: number) => v.toFixed(2)).join(","), "seen", o.mechs.filter((m: any) => m.kind === "mech").map((m: any) => m.id + "@" + Math.hypot(m.pos[0] - o.self.pos[0], m.pos[1] - o.self.pos[1]).toFixed(0)).join(" "), "dmg", dm.join(" "), ms > 20 ? "SLOW " + ms.toFixed(0) : "")
  return a } } } })
console.log(r.log.join("\n"))

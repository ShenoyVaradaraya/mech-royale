import { runMatch } from "./sim.ts"
import { makeBot } from "../bot.ts"
const seed = +process.argv[2]
runMatch({ seed, mainFactory: (h, w, nv) => { const b = makeBot(h, w, nv); let n = 0; return { act(o: any) { const a = b.act(o); if (o.drops.length && n++ % 10 === 0) console.log(o.t.toFixed(0), b.debugMode(), o.self.pos.map((v: number) => v | 0).join(","), o.drops.map((d: any) => `${d.id}@${d.pos.map((v: number) => v | 0)} d${Math.hypot(d.pos[0] - o.self.pos[0], d.pos[1] - o.self.pos[1]) | 0} in${d.lands_in.toFixed(0)} h${d.holder} p${d.progress.toFixed(1)}`).join(" | ")); return a } } } })

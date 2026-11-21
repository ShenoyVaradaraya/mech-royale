import { runMatch } from "./sim.ts"
import { makeExample } from "./example.ts"
const seed = +process.argv[2]
const dmgBy: Record<string, number> = {}
const r = runMatch({ seed, verbose: true, mainFactory: (h) => { const b = makeExample(h); return { act(o: any) { for (const e of o.events) if (e.type === "damaged") dmgBy[e.by + ":" + e.weapon] = (dmgBy[e.by + ":" + e.weapon] ?? 0) + e.amount; return b.act(o) } } } })
console.log(r.log.join("\n")); console.log(dmgBy, r.place)

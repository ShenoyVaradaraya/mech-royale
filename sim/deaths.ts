import { execFileSync } from "node:child_process"
const N = +(process.argv[2] ?? 40)
const res = execFileSync("node", [import.meta.dirname + "/eval.ts", String(N), process.argv[3] ?? "{}", "1"], { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 26 })
console.log(res.split("\n").filter((l) => l.startsWith("RAW")).map((l) => { const r = JSON.parse(l.slice(4)); return `s${r.seed} sc${r.score} t${r.t} near${r.st.deathNear} kt${r.st.killerTier} H${r.st.deathHunters} w${r.weapons} c${r.cubes}` }).join("\n"))

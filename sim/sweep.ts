import { execFileSync } from "node:child_process"
import { join } from "node:path"
// usage: node sweep.ts N '{"a":1}' '{"a":2}' ...
const N = +process.argv[2]
for (const p of process.argv.slice(3)) {
  const out = execFileSync("node", [join(import.meta.dirname!, "eval.ts"), String(N), p, "1"], { encoding: "utf8", maxBuffer: 1 << 26 })
  const lines = out.trim().split("\n")
  const sc = lines.filter((l) => l.startsWith("seed")).map((l) => +l.split(" score ")[1].split(" ")[0])
  const a = sc.slice(0, 20), b = sc.slice(20)
  const m = (v: number[]) => (v.reduce((x, y) => x + y, 0) / Math.max(1, v.length)).toFixed(2)
  console.log(`${m(sc)}  [${m(a)} | ${m(b)}]  ${lines[lines.length - 1].replace(/^MEAN \S+\s+/, "")}  ${p}`)
}

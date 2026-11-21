import { runMatch } from "./sim.ts"
import { makeBot } from "../bot.ts"
import { makeExample } from "./example.ts"
const seed = +process.argv[2]
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {}
const verbose = process.argv.includes("-v")
const r = runMatch({ seed, verbose, mainFactory: params.example ? (h) => makeExample(h) : (h, w, n) => makeBot(h, w, n, params) })
if (verbose) console.error(r.log.join("\n"))
console.log(JSON.stringify({ ...r, log: undefined }))

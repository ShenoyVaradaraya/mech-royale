import { availableParallelism } from "node:os"
import { isMainThread, parentPort, Worker } from "node:worker_threads"
import { DEFAULT_P, makeBot, type Params } from "../bot.ts"
import { makeExample } from "./example.ts"
import { runMatch } from "./sim.ts"

type Variant = { name: string; params: Partial<Params> & { example?: boolean } }
type Job = { variant: Variant; seed: number }
type Result = { variant: string; seed: number; score: number; t: number; kills: number; maxMs: number; slot: number; opponents: string[] }
const roster = process.env.BENCH_ROSTER === "mixed" ? "mixed" : "practice"
const submissionTarget = 10
const evaluationMatches = 100

if (!isMainThread) {
  parentPort!.on("message", ({ variant, seed }: Job) => {
    const mainFactory = variant.params.example
      ? makeExample
      : (...args: Parameters<typeof makeBot>) => makeBot(args[0], args[1], args[2], variant.params)
    const result = runMatch({ seed, roster, mainFactory, strict: true })
    if (result.score === undefined || result.slot === undefined || !result.opponents) throw new Error(`No placement for seed ${seed}`)
    if (result.score !== 16 - result.place || result.score < 0 || result.score > 15) throw new Error(`Invalid placement for seed ${seed}`)
    parentPort!.postMessage({ ...result, variant: variant.name } satisfies Result)
  })
} else {
  const [countArg = String(evaluationMatches), startArg = "501", ...variantArgs] = process.argv.slice(2)
  const count = Number(countArg), start = Number(startArg)
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(start + count - 1)) {
    throw new Error("Usage: node sim/benchmark.ts COUNT START_SEED 'name={...}' ...")
  }
  const variants: Variant[] = (variantArgs.length ? variantArgs : ["main={}"]).map((arg) => {
    const separator = arg.indexOf("=")
    if (separator < 1) throw new Error(`Expected name=JSON, got ${arg}`)
    const params: Variant["params"] = JSON.parse(arg.slice(separator + 1))
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error(`Expected a parameter object for ${arg}`)
    for (const [key, value] of Object.entries(params)) {
      if (key === "example" && typeof value === "boolean") continue
      if (!Object.hasOwn(DEFAULT_P, key) || !Number.isFinite(value)) throw new Error(`Invalid parameter ${key} for ${arg}`)
    }
    return { name: arg.slice(0, separator), params }
  })
  if (new Set(variants.map((v) => v.name)).size !== variants.length) throw new Error("Variant names must be unique")
  const jobs = Array.from({ length: count }, (_, i) => variants.map((variant) => ({ variant, seed: start + i }))).flat()
  const workerCount = Math.min(jobs.length, Math.max(1, Math.floor(Number(process.env.BENCH_WORKERS) || Math.min(8, availableParallelism()))))
  const results: Result[] = []
  let next = 0
  console.log(`${count} matches per variant · seeds ${start}–${start + count - 1} · ${roster} roster · ${workerCount} workers`)
  await Promise.all(Array.from({ length: workerCount }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url))
    let done = false
    const dispatch = () => {
      if (next < jobs.length) worker.postMessage(jobs[next++])
      else {
        done = true
        void worker.terminate().then(() => resolve(), reject)
      }
    }
    worker.on("error", reject)
    worker.on("exit", (code) => { if (!done) reject(new Error(`Match worker exited early with code ${code}`)) })
    worker.on("message", (result: Result) => {
      results.push(result)
      if (process.env.BENCH_PROGRESS === "1" && results.length % 20 === 0) console.log(`${results.length}/${jobs.length} matches complete`)
      dispatch()
    })
    dispatch()
  })))
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const baseline = new Map(results.filter((r) => r.variant === variants[0].name).map((r) => [r.seed, r.score]))
  for (const { name } of variants) {
    const runs = results.filter((r) => r.variant === name).sort((a, b) => a.seed - b.seed)
    const scores = runs.map((r) => r.score)
    const average = mean(scores)
    const tail = scores.slice().sort((a, b) => a - b).slice(0, Math.ceil(count / 4))
    const delta = mean(runs.map((r) => r.score - baseline.get(r.seed)!))
    const worst = Math.min(...scores), best = Math.max(...scores)
    const wins = scores.filter((score) => score === 15).length
    const earlyDeaths = runs.filter((r) => r.t < 60 && r.score < 15).length
    const gate = count === evaluationMatches && roster === "practice" ? `  target ${submissionTarget.toFixed(2)} ${average >= submissionTarget ? "met" : "unmet"}` : ""
    console.log(`${name.padEnd(14)} mean ${average.toFixed(2)}  paired Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}  range ${worst}–${best}  bottom quartile ${mean(tail).toFixed(2)}  wins ${wins}/${count}  early deaths ${earlyDeaths}/${count}  life ${mean(runs.map((r) => r.t)).toFixed(0)}s${gate}`)
    if (process.env.BENCH_RAW === "1") for (const run of runs) console.log(JSON.stringify(run))
  }
}

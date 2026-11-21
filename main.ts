import { run, log } from "./mechfight.ts"
import { World } from "./world.ts"
import { Nav } from "./nav.ts"
import { makeBot } from "./bot.ts"
import { existsSync } from "node:fs"
import { join } from "node:path"

run((hello) => {
  const t0 = performance.now()
  let dir = hello.map?.dir ?? "/arena"
  if (!existsSync(join(dir, "v2/world.json"))) dir = existsSync("/arena/v2/world.json") ? "/arena" : join(import.meta.dirname ?? ".", "arena")
  const world = new World(dir)
  const nav = new Nav(world)
  // warm up the JIT on pathing / LOS so the first real decisions are fast
  for (let i = 0; i < 6; i++) {
    nav.path(-200 + i * 60, -100, 0, 150 - i * 40, 120, undefined, 12000)
    for (let k = 0; k < 300; k++) world.los(-300 + k, -50, 5, 200 - k, 80, 8, 1)
    // builds the tree grid and compiles the canopy check before the first observation
    for (let k = 0; k < 300; k++) world.treeClear(-300 + k, -50, 8, 200 - k, 80, 4.5)
  }
  log(`map loaded + warmed in ${(performance.now() - t0).toFixed(0)} ms`)
  return makeBot(hello, world, nav)
})

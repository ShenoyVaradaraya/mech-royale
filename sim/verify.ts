import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { makeBot } from "../bot.ts"
import { rng } from "../geom.ts"
import type { Hello, Observation } from "../mechfight.ts"
import { assignOpponents, OPPONENTS } from "./opponents.ts"
import { loadMap } from "./sim.ts"

const names = new Set(OPPONENTS.map((entry) => entry.name))
assert.equal(names.size, 16)
const exclusions = new Set<string>()
for (let seed = 1; seed <= 20; seed++) {
  const roster = new Set(assignOpponents(seed, rng(seed)).map((entry) => entry.name))
  assert.equal(roster.size, 15)
  for (const name of names) if (!roster.has(name)) exclusions.add(name)
  const tiers = [0, 0, 0, 0]
  for (const entry of assignOpponents(seed, rng(seed), true)) tiers[entry.tier]++
  assert.deepEqual(tiers, [4, 4, 4, 3])
}
assert.equal(exclusions.size, 16)

const stream = gunzipSync(readFileSync(new URL("../check/stream.jsonl.gz", import.meta.url))).toString()
const messages = stream.trim().split("\n").map((line) => JSON.parse(line))
const hello: Hello = messages[0]
const observations: Observation[] = messages.filter((message) => message.type === "obs")
const { world, nav } = loadMap()
const reference = makeBot(hello, world, nav)
const changedHello = { ...hello, seed: 0 }
const changed = makeBot(changedHello, world, nav)
const seedlessHello = { ...hello }
delete (seedlessHello as Partial<Hello>).seed
const seedless = makeBot(seedlessHello, world, nav)
for (const observation of observations) {
  const action = reference.act(observation)
  assert.deepEqual(changed.act(observation), action, `changed seed at tick ${observation.tick}`)
  assert.deepEqual(seedless.act(observation), action, `missing seed at tick ${observation.tick}`)
}

const openCell = nav.ok.findIndex((ok, cell) => {
  if (!ok) return false
  const x = nav.cx(cell), y = nav.cy(cell)
  return nav.walkable(x, y, x + 12, y)
})
assert.ok(openCell >= 0)
const x = nav.cx(openCell), y = nav.cy(openCell)
const finalZone: Observation = {
  ...observations[0], t: 400, mechs: [], crates: [], cubes: [], pickups: [], sounds: [], projectiles: [], drops: [], events: [],
  self: { ...observations[0].self, pos: [x, y, nav.s[openCell]], vel: [0, 0, 0], in_zone: true, grounded: true, energy: 100 },
  zone: { center: [x, y], radius: 25, next_center: [x + 12, y], next_radius: 0, shrink_start: 401, shrink_end: 426, dps: 260 },
}
const rotate = makeBot(hello, world, nav, { zoneAnchor: 1, battleRoyale: 1 })
assert.ok(rotate.act(finalZone).move![0] > 0.95)
const nearby = structuredClone(finalZone)
nearby.t += 0.1
nearby.self.pos[0] += 11
const arrival = rotate.act(nearby)
assert.ok(arrival.move![0] > 0 && arrival.move![0] < 0.5)
assert.equal(arrival.boost, false)
console.log(`PASS · ${observations.length} seed-independent actions · 16 opponent profiles · final circle rotation and braking`)

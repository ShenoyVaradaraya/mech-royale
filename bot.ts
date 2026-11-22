// Main bot logic. Exported as makeBot(hello, world, nav) so the local simulator can run it in-process.
import type { Action, Hello, Observation, PickupObs, WeaponKind } from "./mechfight.ts"
import { World } from "./world.ts"
import { Nav } from "./nav.ts"
import { ballisticPitch, intercept, rng, wrap } from "./geom.ts"

export const DEFAULT_P = {
  retreatHp: 0.42, // retreat to cover below this hp fraction
  reengageHp: 0.85, // leave cover after healing to this
  fightRange: 105, // preferred distance with gun/laser
  lightRange: 28, // preferred distance with lightning
  zoneMargin: 18,
  strafeMin: 0.6,
  strafeMax: 1.4,
  boostDodge: 0,
  lootRadius: 140,
  crateRadius: 70,
  npcFarm: 0,
  dropGrab: 0,
  laserScore: 5,
  lightScore: 2.2,
  mortarScore: 1.2,
  coverSearch: 55,
  finishHp: 260, // keep fighting a target below this hp even when low
  fearCount: 2, // retreat earlier when this many enemies see us
  aimLead: 0.8,
  campHp: 0.0,
  grudgeS: 12,
  hostileRange: 50,
  aggressive: 0,
  duelMargin: 0.6,
  kiteRange: 68,
  wanderS: 20,
  wanderAvoid: 2,
  segAvoid: 0.5,
  edgePref: 0,
  repel: 1,
  cubeCap: 99,
  restHp: 0.68,
  dropRange: 400,
  losDodge: 1,
  fireDiscipline: 0,
  strayClear: 7,
  thirdRepel: 1,
  peek: 0,
  peekR: 16,
  closeRange: 35,
  safePlay: 1,
  battleRoyale: 1,
  mortarFocus: 1,
  survival: 1,
  projectileDodge: 1,
  prepare: 2,
  escapeRoute: 0,
  fightSpacing: 0,
  harvest: 1,
  opening: 1,
  fireControl: 0,
  supplyPriority: 0,
  stockpile: 0,
  rotationTime: 0,
  rangeControl: 0,
  zoneAnchor: 1,
  hideAtAnchor: 1,
  laserTiming: 1,
  upgradePlan: 2,
  peekHold: 1,
  recoverEarly: 1,
  targetPriority: 1,
  armedGuard: 1,
  kitSearch: 2,
  mrm: 0,
  mrmMin: 2,
  mrmNoLos: 3,
  mrmRange: 1.5,
  detail: 0,
  retreatFix: 0,
  standFight: 0, // max enemies within 120 m for which we stand and fight instead of fleeing a chaser
  standEnergy: 25,
  standR: 75,
  ghost: 0, // survival mode: after ghostT never start fights, hide concealed in the next circle, move silently
  ghostT: 360, // phase 5 starts at 350 s: from here only HP at the final collapse matters
  ghostQuiet: 70,
  budgetMs: 25, // per-decision time budget for optional searches (limit is 50 ms on 1 CPU)
  killCleanup: 1, // always forget a mech we killed
  laserCounter: 0, // no laser/lightning: break LOS from laser carriers; with lightning: close in to short them; dodge charging lasers in any mode
  preempt: 0, // treat enemies aiming at us (clear line, <230 m) as hostile
  spin: 0, // idle look-around: rotate the torso continuously when no enemy is known
  trees: 0, // model tree concealment in our own visibility checks (cover, hiding, MRM)
  detailR: 140,
  detailGap: 35,
}
export type Params = typeof DEFAULT_P

type Track = { id: number; pos: number[]; vel: number[]; aim: number[]; hp: number; maxHp: number; weapons: string[]; charging: boolean; seen: number; vis: boolean; cubes: number }
type Item = { id: number; pos: number[]; kind?: string; hp?: number; seen: number }

const UPG_PRI = ["armor", "plating", "laser_damage", "gun_rate", "gun_damage", "laser_charge", "lightning_efficiency", "nanites", "gun_mag", "lightning_range", "lightning_chain", "gyros", "servos", "gun_velocity", "reactor", "capacitor", "jets", "laser_pierce", "sensors", "mortar_reload", "mortar_splash", "mortar_velocity"]

const SUSTAIN_UPGRADES = ["plating", "armor", "nanites", "gun_mag", "gun_damage", "laser_damage", "servos", "gun_velocity", "laser_charge", "lightning_efficiency", "lightning_range", "gun_rate", "reactor"]

export function makeBot(hello: Hello, world: World, nav: Nav, params?: Partial<Params>) {
  const P: Params = { ...DEFAULT_P, ...(params ?? {}) }
  // Hard per-decision time budget: optional searches stop once it is spent so we always answer well inside 50 ms.
  // The local simulator sets MECH_NO_BUDGET so its results do not depend on machine load.
  const noBudget = typeof process !== "undefined" && !!process.env?.MECH_NO_BUDGET
  let tickStart = 0
  const overBudget = () => !noBudget && performance.now() - tickStart > P.budgetMs
  const C = hello.config
  const R = rng(18)
  const me_id = hello.slot
  const tracks = new Map<number, Track>()
  const pickups = new Map<number, Item>()
  const crates = new Map<number, Item>()
  const cubes = new Map<number, Item>()
  const npcs = new Map<number, Track>()
  let path: [number, number][] | null = null
  let pathGoal: number[] | null = null
  let pathT = -99
  let wp = 0
  let strafeDir = 1
  let strafeUntil = 0
  let stuckT = 0
  let unstickUntil = 0
  let mode = "loot"
  let cover: number[] | null = null
  let coverT = -99
  let lastDamagedT = -99
  let recentDamage: { amount: number; t: number }[] = []
  let freshSalvage: { pos: number[]; until: number } | null = null
  let dmgBearings: { b: number; t: number; by: number | null }[] = []
  let wander: number[] | null = null
  let wanderT = -99
  let lastT = 0
  let scanPhase = R() * 6
  let healing = false
  const failedTake = new Map<number, number>()
  const lastAttack = new Map<number, number>()
  const npcAttack = new Map<number, number>()
  let lastTargetId = -1
  let dodging = -99
  let peekCover: number[] | null = null
  let mrmPt: number[] | null = null
  let mrmT = -99
  let retreatJinkDir = 1
  let retreatJinkUntil = -99
  let peekT = -99
  let peekTarget = -1
  let anchor: number[] | null = null
  let anchorPhase = -1
  let anchorCheckedAt = -99
  const surveyed = new Set<string>()
  let surveyCheckedAt = -99
  const guardReady = (obs: Observation) => !P.armedGuard || !!obs.self.weapons[1]

  const wscore = (k: string | undefined) => (k === "laser" ? P.laserScore : k === "lightning" ? P.lightScore : k === "mortar" ? P.mortarScore : 0)

  function safeCircle(obs: Observation, eta: number) {
    const z = obs.zone
    const t = obs.t
    // circle we must be in by time t+eta
    const tt = t + eta
    if (tt <= z.shrink_start) return { c: z.center, r: z.radius }
    if (tt >= z.shrink_end) return { c: z.next_center, r: z.next_radius }
    const start = P.safePlay ? Math.max(t, z.shrink_start) : z.shrink_start
    const f = (tt - start) / Math.max(1e-3, z.shrink_end - start)
    return { c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f], r: z.radius + (z.next_radius - z.radius) * f }
  }

  function goalCircle(obs: Observation, x: number, y: number) {
    const z = obs.zone
    const dNext = Math.hypot(x - z.next_center[0], y - z.next_center[1])
    const travel = Math.max(0, dNext - z.next_radius + P.zoneMargin) / 10
    // head to next circle if shrink starts soon relative to travel time
    if (obs.t + travel + 20 >= z.shrink_start) return { c: z.next_center, r: z.next_radius }
    return { c: z.center, r: z.radius }
  }

  function inCircle(p: number[], c: { c: number[]; r: number }, margin: number) {
    return Math.hypot(p[0] - c.c[0], p[1] - c.c[1]) <= Math.max(2, c.r - margin)
  }

  function clampToCircle(p: number[], c: { c: number[]; r: number }, margin: number): number[] {
    const dx = p[0] - c.c[0], dy = p[1] - c.c[1]
    const d = Math.hypot(dx, dy)
    const r = Math.max(1, c.r - margin)
    if (d <= r) return p
    return [c.c[0] + (dx / d) * r, c.c[1] + (dy / d) * r]
  }

  const surveySize = 42
  const surveyCell = (x: number, y: number) => `${Math.floor(x / surveySize)},${Math.floor(y / surveySize)}`

  function rememberSurvey(obs: Observation) {
    if (obs.t - surveyCheckedAt < 1.3) return
    surveyCheckedAt = obs.t
    const [x, y, z] = obs.self.pos
    const eye = z + obs.self.stats.eye_height
    const yaw = obs.self.aim[0]
    surveyed.add(surveyCell(x, y))
    for (const radius of [30, 63, 97, 138]) {
      for (const offset of [-0.92, -0.46, 0, 0.46, 0.92]) {
        const px = x + radius * Math.cos(yaw + offset), py = y + radius * Math.sin(yaw + offset)
        const ground = world.ground(px, py)
        if (world.inBounds(px, py, 4) && world.los(x, y, eye, px, py, ground + 1.3, 1.5)) surveyed.add(surveyCell(px, py))
      }
    }
  }

  function routeExposure(x: number, y: number, gx: number, gy: number, threats: Track[]): number {
    const dx = gx - x, dy = gy - y
    const lengthSq = dx * dx + dy * dy || 1
    let exposure = 0
    for (const foe of threats) {
      const toward = ((foe.pos[0] - x) * dx + (foe.pos[1] - y) * dy) / lengthSq
      if (toward <= 0.08) continue
      const step = Math.min(1, toward)
      const px = x + dx * step, py = y + dy * step
      const lateral = Math.hypot(foe.pos[0] - px, foe.pos[1] - py)
      const dangerRadius = foe.weapons.includes("lightning") ? 57 : 43
      if (lateral < dangerRadius && world.los(foe.pos[0], foe.pos[1], foe.pos[2] + 7, px, py, world.ground(px, py) + 5, 1.5)) {
        exposure += (1 - lateral / dangerRadius) * 2.5
      }
    }
    return exposure
  }

  function safeLaserRoute(obs: Observation, threats: Track[], underFire: boolean): Item | null {
    const [x, y, z] = obs.self.pos
    let best: Item | null = null, bestCost = Infinity
    for (const pickup of pickups.values()) {
      if (pickup.kind !== "laser" || obs.t - (failedTake.get(pickup.id) ?? -99) < 4) continue
      const [px, py, pz] = pickup.pos
      const distance = Math.hypot(px - x, py - y)
      const limit = underFire ? P.kitSearch > 2 ? 87 : 53 : 180
      if (distance > limit || Math.abs(pz - z) > 4 || !inCircle(pickup.pos, safeCircle(obs, distance / 10 + 4), 6)) continue
      const exposure = routeExposure(x, y, px, py, threats)
      if (underFire && exposure > 0.55 || exposure > 2) continue
      const approach = distance * (1 + exposure) + Math.min(24, obs.t - pickup.seen) * 1.4
      if (approach < bestCost) { bestCost = approach; best = pickup }
    }
    return best
  }

  function findZoneAnchor(obs: Observation, enemies: Track[]): number[] | null {
    const [x, y, z] = obs.self.pos
    const [cx, cy] = obs.zone.next_center
    const radius = obs.zone.next_radius
    const ghosting = P.ghost && obs.t > P.ghostT
    const extent = ghosting ? Math.min(120, radius * 0.55) : Math.min(40, radius * 0.32)
    let best: number[] | null = null
    let bestScore = Infinity
    for (const fraction of ghosting ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.45, 0.75, 1]) {
      if (overBudget() && best) break
      const steps = fraction === 0 ? 1 : ghosting ? 12 : 8
      for (let i = 0; i < steps; i++) {
        const angle = i * 2 * Math.PI / steps
        const px = cx + Math.cos(angle) * extent * fraction
        const py = cy + Math.sin(angle) * extent * fraction
        const cell = nav.cell(px, py)
        if (cell < 0 || !nav.ok[cell]) continue
        const floor = nav.s[cell]
        if (floor > world.ground(px, py) + 2) continue
        let score = Math.hypot(px - x, py - y) * 0.16 + extent * fraction * (ghosting ? 0.15 : 0.6) + Math.abs(floor - z) * 0.3
        for (const e of enemies) {
          const d = Math.hypot(px - e.pos[0], py - e.pos[1])
          if (d < 105 && visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8, px, py, floor, C.mech.height)) score += (105 - d) * 0.65
        }
        for (let step = 0; step < 8; step++) {
          const bearing = step * Math.PI / 4
          const ax = px + Math.cos(bearing) * 28, ay = py + Math.sin(bearing) * 28
          if (world.los(ax, ay, world.ground(ax, ay) + 7, px, py, floor + 4.5, 1.5) && (!P.trees || world.treeClear(ax, ay, world.ground(ax, ay) + 8, px, py, floor + 4.5))) score += ghosting ? 9 : P.hideAtAnchor ? 5 : 2.2
          if (ghosting) {
            const fx = px + Math.cos(bearing) * 70, fy = py + Math.sin(bearing) * 70
            if (world.los(fx, fy, world.ground(fx, fy) + 8, px, py, floor + 4.5, 2) && (!P.trees || world.treeClear(fx, fy, world.ground(fx, fy) + 8, px, py, floor + 4.5))) score += 4
          }
        }
        if (score < bestScore) { bestScore = score; best = [px, py] }
      }
    }
    return best
  }

  function goTo(obs: Observation, gx: number, gy: number, x: number, y: number, z: number): number[] {
    const t = obs.t
    const distance = Math.hypot(gx - x, gy - y)
    if (P.battleRoyale && distance <= 40 && nav.walkable(x, y, gx, gy)) return [gx - x, gy - y]
    const need = (!path || !pathGoal || Math.hypot(pathGoal[0] - gx, pathGoal[1] - gy) > 6 || t - pathT > 2.5) && !(path && overBudget())
    if (need) {
      const zc = safeCircle(obs, 5)
      const r2 = Math.max(5, zc.r)
      path = nav.path(x, y, z, gx, gy, (k) => {
        const cx = nav.cx(k), cy = nav.cy(k)
        return Math.hypot(cx - zc.c[0], cy - zc.c[1]) > r2 ? 3 : 0
      }, 12000)
      pathGoal = [gx, gy]
      pathT = t
      wp = 0
    }
    if (!path || path.length === 0) return [gx - x, gy - y]
    while (wp < path.length - 1 && Math.hypot(path[wp][0] - x, path[wp][1] - y) < 2.5) wp++
    // skip ahead if next waypoint directly walkable
    if (wp < path.length - 1 && nav.walkable(x, y, path[wp + 1][0], path[wp + 1][1])) wp++
    const p = path[wp]
    return [p[0] - x, p[1] - y]
  }

  function visibleFrom(ex: number, ey: number, ez: number, x: number, y: number, z: number, h: number) {
    if (P.trees) {
      // real vision: tree crowns/trunks hide us even with a clear building line
      const line = (tz: number) => world.los(ex, ey, ez, x, y, tz, 1.5) && world.treeClear(ex, ey, ez, x, y, tz)
      return line(z + h * 0.5) || line(z + h)
    }
    return world.los(ex, ey, ez, x, y, z + h * 0.5, 1.5) || world.los(ex, ey, ez, x, y, z + h, 1.5)
  }

  /** pick a walkable direction closest to desired vector (dx,dy) */
  function steer(x: number, y: number, z: number, dx: number, dy: number): number[] {
    const L = Math.hypot(dx, dy)
    if (L < 1e-6) return [0, 0]
    const ux = dx / L, uy = dy / L
    const free = (a: number) => {
      const cx = Math.cos(a), cy = Math.sin(a)
      let prevS = z
      let score = 0
      for (const r of [1.5, 3, 5]) {
        const k = nav.cell(x + cx * r, y + cy * r)
        if (k < 0 || !nav.ok[k] || nav.s[k] - prevS > 1.6) return score
        prevS = nav.s[k]
        score++
      }
      return score
    }
    const a0 = Math.atan2(uy, ux)
    if (free(a0) === 3) return [ux, uy]
    let best = [ux, uy], bs = -Infinity
    for (let i = 1; i < 16; i++) {
      const a = a0 + (i * Math.PI * 2) / 16
      const f = free(a)
      const sc = f * 1.0 + Math.cos(a - a0) * 1.2
      if (f >= 2 && sc > bs) { bs = sc; best = [Math.cos(a), Math.sin(a)] }
    }
    return bs === -Infinity ? [ux, uy] : best
  }

  function findCover(obs: Observation, threats: Track[], x: number, y: number, z: number, h: number, maxR = P.coverSearch): number[] | null {
    const zc = safeCircle(obs, 8)
    threats = threats.slice().sort((a, b) => Math.hypot(a.pos[0] - x, a.pos[1] - y) - Math.hypot(b.pos[0] - x, b.pos[1] - y)).slice(0, 4)
    let best: number[] | null = null
    let bs = Infinity
    for (let rad = 4; rad <= maxR; rad += maxR < 25 ? 4 : 7) {
      if (overBudget()) break
      const n = Math.max(8, Math.round(rad / 3))
      for (let a = 0; a < n; a++) {
        const ang = (a / n) * Math.PI * 2 + rad
        const px = x + Math.cos(ang) * rad, py = y + Math.sin(ang) * rad
        const k = nav.cell(px, py)
        if (k < 0 || !nav.ok[k]) continue
        const pz = nav.s[k]
        if (Math.abs(pz - z) > 6) continue
        if (!inCircle([px, py], zc, 6)) continue
        let tdist = Infinity
        let exposed = 0
        for (const e of threats) {
          tdist = Math.min(tdist, Math.hypot(e.pos[0] - px, e.pos[1] - py))
          if (visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8, px, py, pz, h)) {
            if (!P.escapeRoute) { exposed = Infinity; break }
            exposed += Math.hypot(e.pos[0] - px, e.pos[1] - py) < 90 ? 1 : 0.5
          }
        }
        if (exposed > (P.escapeRoute && threats.length >= 2 ? 1 : 0)) continue
        const direct = nav.walkable(x, y, px, py)
        if (!direct && rad > 20) continue
        // prefer close, away from threats
        const sc = rad - Math.min(tdist, 80) * 0.25 + (P.escapeRoute ? exposed * 36 + (direct ? 0 : 8) : 0)
        if (sc < bs) { bs = sc; best = [px, py] }
      }
      if (best && rad > 20 && (!P.escapeRoute || bs < 25)) break
    }
    return best
  }

  function sidestepProjectiles(obs: Observation, movement: number[], boosting: boolean, height: number, radius: number): number[] {
    if (!obs.self.grounded) return movement
    const [x, y, z] = obs.self.pos
    const speed = boosting ? obs.self.stats.boost_speed ?? C.mech.boost_speed : obs.self.stats.walk_speed ?? C.mech.walk_speed
    const ax = obs.self.vel[0], ay = obs.self.vel[1]
    const accel = obs.self.stats.ground_accel ?? C.mech.ground_accel
    const length = Math.hypot(movement[0], movement[1])
    if (length < 0.1) return movement
    const ux = movement[0] / length, uy = movement[1] / length
    const imminent: { x: number; y: number; t: number; padding: number }[] = []
    for (const p of obs.projectiles) {
      const dx = p.pos[0] - x, dy = p.pos[1] - y
      if (Math.abs(dx) + Math.abs(dy) > 130) continue
      const vx = p.vel[0] - ax, vy = p.vel[1] - ay
      const time = -(dx * vx + dy * vy) / Math.max(1, vx * vx + vy * vy)
      if (time < 0.07 || time > 0.45) continue
      const shell = p.kind === "mortar"
      const padding = radius + (shell ? C.weapons.mortar.splash_radius : 0.65)
      const altitude = p.pos[2] + p.vel[2] * time - (shell ? C.weapons.mortar.gravity * time * time / 2 : 0)
      if (altitude < z - 1 || altitude > z + height + (shell ? 3 : 0.5)) continue
      if (Math.hypot(dx + vx * time, dy + vy * time) > padding + 5) continue
      imminent.push({ x: dx + p.vel[0] * time, y: dy + p.vel[1] * time, t: time, padding })
    }
    if (!imminent.length) return movement
    const circle = safeCircle(obs, 1)
    const goal = Math.atan2(uy, ux)
    let best = movement, cost = Infinity
    for (const offset of [0, -0.55, 0.55, -1.1, 1.1, -1.7, 1.7]) {
      const vx = Math.cos(goal + offset), vy = Math.sin(goal + offset)
      const px = x + vx * 4, py = y + vy * 4
      if (!nav.walkable(x, y, px, py)) continue
      let danger = Math.abs(offset) * 0.8 + Math.max(0, Math.hypot(px - circle.c[0], py - circle.c[1]) - circle.r) * 1.5
      const dvx = speed * vx - ax, dvy = speed * vy - ay
      const ramp = Math.hypot(dvx, dvy) / accel
      for (const p of imminent) {
        const fraction = ramp < p.t ? p.t - ramp / 2 : p.t * p.t / (2 * ramp)
        const dx = ax * p.t + dvx * fraction - p.x
        const dy = ay * p.t + dvy * fraction - p.y
        danger += Math.max(0, p.padding - Math.hypot(dx, dy)) * 2
      }
      if (danger < cost) { cost = danger; best = [vx, vy] }
    }
    return best
  }

  function pickUpgrade(obs: Observation): number {
    const ch = obs.offer!.choices
    const preferred = P.upgradePlan && guardReady(obs) ? SUSTAIN_UPGRADES : UPG_PRI
    let bi = 0, bp = 999
    ch.forEach((c, i) => {
      const priority = preferred.indexOf(c.id)
      const fallback = UPG_PRI.indexOf(c.id)
      const pp = priority >= 0 ? priority : fallback >= 0 ? preferred.length + fallback : 50
      if (pp < bp) { bp = pp; bi = i }
    })
    return bi
  }

  return {
    name: "builders-gpt",
    act(obs: Observation): Omit<Action, "tick"> {
      tickStart = performance.now()
      const t = obs.t
      const dt = Math.max(0.05, t - lastT)
      lastT = t
      const me = obs.self
      const [x, y, z] = me.pos
      const scale = 1 + (C.cubes.size_per_cube as number) * me.cubes
      const myH = 9 * scale
      const muzZ = z + (me.stats.muzzle_height ?? 7 * scale)
      const act: Omit<Action, "tick"> = {}
      const hpF = me.hp / me.max_hp

      const lookingForLaser = P.kitSearch && t < 150 && !me.weapons.some((weapon) => weapon?.kind === "laser")
      if (P.kitSearch > 1 && lookingForLaser) rememberSurvey(obs)

      // ---- tracking
      for (const tr of tracks.values()) tr.vis = false
      if (P.battleRoyale) for (const tr of npcs.values()) tr.vis = false
      for (const m of obs.mechs) {
        if (m.kind === "mech") {
          if (m.id === me_id) continue
          tracks.set(m.id, { id: m.id, pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp ?? 1400, maxHp: m.max_hp ?? 1400, weapons: (m.weapons ?? []) as string[], charging: !!m.charging, seen: t, vis: true, cubes: m.cubes ?? 0 })
        } else npcs.set(m.id, { id: m.id, pos: m.pos, vel: m.vel, aim: m.aim, hp: m.hp ?? 350, maxHp: m.max_hp ?? 350, weapons: [], charging: false, seen: t, vis: true, cubes: 0 })
      }
      for (const [id, tr] of tracks) if (t - tr.seen > 25) tracks.delete(id)
      for (const [id, n] of npcs) if (t - n.seen > 3) npcs.delete(id)
      const upd = (mp: Map<number, Item>, list: { id: number; pos: number[]; kind?: string; hp?: number }[], view: number) => {
        const s = new Set<number>()
        for (const it of list) { mp.set(it.id, { id: it.id, pos: it.pos, kind: it.kind, hp: it.hp, seen: t }); s.add(it.id) }
        for (const [id, it] of mp) {
          if (s.has(id)) continue
          const d = Math.hypot(it.pos[0] - x, it.pos[1] - y)
          if (d < view && Math.abs(it.pos[2] - z) < 6) mp.delete(id)
          else if (t - it.seen > 90) mp.delete(id)
        }
      }
      upd(pickups, obs.pickups as PickupObs[], 25)
      upd(crates, obs.crates, 25)
      upd(cubes, obs.cubes, 25)
      for (const e of obs.events) {
        if (e.type === "damaged" && e.by !== null) {
          lastDamagedT = t
          if ((P.survival || P.recoverEarly) && e.by < 16) recentDamage.push({ amount: e.amount, t })
          if (e.by < 100) lastAttack.set(e.by, t)
          else npcAttack.set(e.by, t)
          if (e.bearing !== null) dmgBearings.push({ b: e.bearing, t, by: e.by })
        } else if (e.type === "damaged") {
          // zone damage: does not count as combat for our logic
        } else if (e.type === "take_failed") failedTake.set(e.id, t)
        else if (e.type === "kill" && (P.killCleanup || P.harvest && guardReady(obs))) {
          // a confirmed kill is never a threat again (previously only cleared when holding a secondary)
          const defeated = tracks.get(e.target)
          if (defeated && P.harvest && guardReady(obs)) freshSalvage = { pos: defeated.pos, until: t + 7 }
          tracks.delete(e.target)
          lastAttack.delete(e.target)
        }
      }
      if (freshSalvage && t > freshSalvage.until) freshSalvage = null
      dmgBearings = dmgBearings.filter((d) => t - d.t < 4)
      if (P.survival || P.recoverEarly) recentDamage = recentDamage.filter((d) => t - d.t <= 1.2)

      // ---- upgrades
      if (obs.offer) act.pick = pickUpgrade(obs)

      // ---- weapons state
      const W = me.weapons
      const slotOf = (k: WeaponKind) => (W[0]?.kind === k ? 0 : W[1]?.kind === k ? 1 : -1)
      const gunS = slotOf("gun"), laserS = slotOf("laser"), lightS = slotOf("lightning"), mortarS = slotOf("mortar")
      const fire: [boolean, boolean] = [false, false]

      // ---- pickup take
      const reach = C.loot.pickup_radius
      for (const p of obs.pickups) {
        if (Math.hypot(p.pos[0] - x, p.pos[1] - y) > reach - 0.3 || Math.abs(p.pos[2] - z) > 3.8) continue
        if (failedTake.has(p.id) && t - failedTake.get(p.id)! < 2) continue
        if (slotOf(p.kind) >= 0) continue
        const empty = W[0] === null ? 0 : W[1] === null ? 1 : -1
        if (empty >= 0) { if (p.kind !== "gun") { act.take = p.id; break } else continue }
        // both full: swap the worse non-gun slot if better
        const other = gunS === 0 ? 1 : 0
        const ow = W[other]
        if (ow && wscore(p.kind) > wscore(ow.kind) + 0.3 && !(ow.kind === "laser" && (ow.charge ?? 0) > 0)) { act.take = p.id; act.drop = other; break }
      }

      // ---- threat assessment
      const enemies = [...tracks.values()].filter((e) => t - e.seen < 6)
      const visible = enemies.filter((e) => e.vis)
      const dist = (e: { pos: number[] }) => Math.hypot(e.pos[0] - x, e.pos[1] - y, e.pos[2] - z)
      const seeingMe = visible.filter((e) => dist(e) < 130 && visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8, x, y, z, myH))
      const holdingCover = P.hideAtAnchor && mode === "hide" && anchor && me.in_zone && me.grounded &&
        obs.zone.shrink_end === anchorPhase && Math.hypot(anchor[0] - x, anchor[1] - y) < 4 &&
        t - lastDamagedT > 1.5 && seeingMe.length === 0 && inCircle([x, y], safeCircle(obs, 8), 5)

      // ---- choose target (selective: attackers, approaching/aiming enemies, weak ones)
      const attackedBy = new Map<number, number>()
      for (const [id, tt] of lastAttack) if (t - tt < P.grudgeS) attackedBy.set(id, tt)
      const dpsOf = (wl: string[], d: number, cubesN: number) => {
        let v = 0
        if (wl.includes("gun") && d < 230) v += (45 / 0.24) * (d < 60 ? 0.75 : d < 120 ? 0.5 : 0.3)
        if (wl.includes("laser") && d < 280) v += 131 * 0.85
        if (wl.includes("lightning") && d < 45) v += 240 * 0.9
        if (wl.includes("mortar") && d > 25 && d < 230) v += 60
        return v * (1 + 0.04 * Math.min(10, cubesN))
      }
      const myW = W.filter(Boolean).map((w) => w!.kind) as string[]
      const useGuard = guardReady(obs)
      const recoverEarly = P.recoverEarly && useGuard
      let target: Track | null = null
      let tbest = Infinity
      for (const e of visible) {
        const d = dist(e)
        const losOk = world.los(x, y, muzZ, e.pos[0], e.pos[1], e.pos[2] + 4.5, 1.0)
        const toMe = Math.atan2(y - e.pos[1], x - e.pos[0])
        const facing = Math.abs(wrap(e.aim[0] - toMe)) < 0.5
        const approaching = (e.vel[0] * Math.cos(toMe) + e.vel[1] * Math.sin(toMe)) > 3
        // preempt: a mech pointing its gun at us with a clear line is hunting us; shoot first instead of waiting to be hit
        const aimedAtUs = P.preempt && losOk && d < 230 && Math.abs(wrap(e.aim[0] - toMe)) < 0.12
        const hostile = attackedBy.has(e.id) || (facing && approaching && d < P.hostileRange) || d < P.closeRange || aimedAtUs
        const weak = e.hp < e.maxHp * 0.45 && (!P.survival || losOk && hpF > 0.65 && d < 100)
        const goodOpening = P.battleRoyale && P.survival < 2 && hpF > 0.85 && !!W[1] && losOk && d < 85 &&
          (!e.weapons.includes("lightning") || d > C.weapons.lightning.range + 12) &&
          !visible.some((other) => other !== e && Math.hypot(other.pos[0] - e.pos[0], other.pos[1] - e.pos[1]) < 80)
        const ghostNow = P.ghost && t > P.ghostT
        const want = ghostNow ? (t - (attackedBy.get(e.id) ?? -99) < 4 || d < P.closeRange) && (losOk || d < 20)
          : holdingCover ? hostile && losOk : hostile || weak || goodOpening || (P.aggressive && hpF > 0.8 && visible.length === 1)
        if (!want) continue
        let s = d / 40 + e.hp / 400 + (losOk ? 0 : 4) - (attackedBy.has(e.id) ? 1 : 0)
        if (P.targetPriority && useGuard) {
          const toEnemy = Math.atan2(e.pos[1] - y, e.pos[0] - x)
          const swivel = Math.abs(wrap(me.aim[0] - toEnemy)) / (me.stats.turn_rate ?? C.mech.turn_rate)
          const danger = dpsOf(e.weapons, d, e.cubes) * (facing ? 1 : 0.35)
          const ability = dpsOf(myW, d, me.cubes)
          const health = Math.max(1, e.hp)
          const removalTime = health / Math.max(35, ability) + swivel + (losOk ? 0 : 4)
          const defenseValue = Math.min(6, danger / 110) * (attackedBy.has(e.id) || facing && d < 65 ? 1 : 0.5)
          s = removalTime / (1 + defenseValue * 0.35) + (hostile ? 0 : 1.4)
        }
        if (e.id === lastTargetId) s -= 0.7
        if (s < tbest) { tbest = s; target = e }
      }
      lastTargetId = target ? target.id : -1
      const hostileIds = new Set<number>()
      for (const e of visible) if (attackedBy.has(e.id) || dist(e) < P.closeRange) hostileIds.add(e.id)
      if (target) hostileIds.add(target.id)
      const bystanders = visible.filter((e) => !hostileIds.has(e.id))
      // true if a shot from us along yaw/pitch might hit a bystander
      const strayRisk = (yaw: number, pitch: number, range: number) => {
        if (!P.fireDiscipline) return false
        const dx = Math.cos(pitch) * Math.cos(yaw), dy = Math.cos(pitch) * Math.sin(yaw), dz = Math.sin(pitch)
        for (const e of bystanders) {
          const vx = e.pos[0] - x, vy = e.pos[1] - y, vz = e.pos[2] + 4.5 - muzZ
          const along = vx * dx + vy * dy + vz * dz
          if (along < 0 || along > range) continue
          const px = vx - dx * along, py = vy - dy * along, pz = vz - dz * along
          if (Math.hypot(px, py, pz) < P.strayClear) return true
        }
        return false
      }

      // ---- mode
      const recentlyHurt = t - lastDamagedT < 1.5
      // duel estimate: time for us to kill target vs time for all seeing enemies to kill us
      let incoming = 0
      for (const e of visible) if (attackedBy.has(e.id) || seeingMe.includes(e)) incoming += dpsOf(e.weapons, dist(e), e.cubes)
      const myArmor = me.stats.armor ?? 0
      const observedDps = P.survival || recoverEarly ? recentDamage.reduce((sum, hit) => sum + hit.amount, 0) / 1.2 : 0
      const ttdMe = me.hp / Math.max(1, incoming * (1 - myArmor), observedDps)
      const ttkT = target ? target.hp / Math.max(1, dpsOf(myW, dist(target), me.cubes)) : Infinity
      const winning = target !== null && ttkT < ttdMe * P.duelMargin
      const activeAttackers = P.survival || recoverEarly ? visible.filter((e) => t - (lastAttack.get(e.id) ?? -99) < 3).length : 0
      const pressured = P.survival && (activeAttackers >= 2 && hpF < 0.84 || observedDps > 180 && ttdMe < 4.2)
      const disengage = P.survival >= 3 && target !== null && !winning && me.in_zone &&
        (activeAttackers > 1 || target.weapons.includes("lightning") && lightS < 0 && dist(target) < 52 ||
          P.survival >= 4 && !W[1] && dist(target) < 75 && !recentlyHurt)
      const fearful = (hpF < P.retreatHp && !winning) || (seeingMe.length >= P.fearCount && hpF < 0.7 && !winning) || (hpF < 0.2 && ttkT > 1.5) || pressured
      const shortRetreat = recoverEarly && target && me.in_zone && hpF < (P.recoverEarly > 1 ? 0.85 : 0.72) &&
        (activeAttackers > 1 && observedDps > 100 || observedDps > 190 && ttdMe < 4.5) && ttkT > Math.min(ttdMe, 2.5)
      if (healing && (hpF >= P.reengageHp || enemies.length === 0 && hpF > 0.7)) healing = false
      if ((fearful || (P.battleRoyale && incoming > 240 && hpF < 0.78 && !winning)) && enemies.length > 0) healing = true
      if (shortRetreat) healing = true
      if (healing && winning && hpF > (P.survival ? 0.5 : 0.25) && !pressured && !shortRetreat) healing = false
      // finishing a weak close target overrides retreat
      const finish = target && target.hp < P.finishHp && dist(target) < 120 && hpF > 0.15 &&
        (!P.survival || ttdMe > Math.max(1.5, ttkT * 2) && activeAttackers < 3)
      // laser counter: with neither laser nor lightning, a laser carrier out-trades us at range (2/13 in hard duels), so break LOS
      const laserAvoid = P.laserCounter > 0 && laserS < 0 && lightS < 0 && visible.some((e) => e.weapons.includes("laser") && e.hp > 300 &&
        dist(e) > 45 && dist(e) < 280 && seeingMe.includes(e) && !(target && target.id === e.id && target.hp < P.finishHp))
      mode = shortRetreat || (healing || disengage || laserAvoid) && !finish ? "retreat" : target ? "fight" : "loot"
      // can't outrun a chaser that keeps hitting us: fleeing only gives it free shots, so fight back
      if (P.standFight && mode === "retreat" && target && !finish && hpF > 0.12 && me.energy < P.standEnergy &&
          t - lastDamagedT < 0.8 && dist(target) < P.standR && attackedBy.has(target.id) &&
          visible.filter((e) => dist(e) < 120).length <= P.standFight &&
          !(target.weapons.includes("lightning") && lightS < 0 && dist(target) < C.weapons.lightning.range + 5 && !cover))
        mode = "fight"
      const npcAngry = [...npcAttack.values()].some((tt) => t - tt < 4)
      if (mode === "loot" && !npcAngry && t - lastDamagedT > 2 && hpF < P.restHp && inCircle([x, y], safeCircle(obs, 10), P.zoneMargin * 0.5)) mode = "rest"
      if (holdingCover && !npcAngry && (mode === "loot" || mode === "rest")) mode = "hide"
      if (!me.in_zone && obs.zone.dps * 3 > me.hp * 0.5) mode = "zone"
      if (P.safePlay) {
        const next = safeCircle(obs, 6)
        const outsideBy = Math.hypot(x - next.c[0], y - next.c[1]) - next.r
        if (outsideBy > 0 && (t > 300 || outsideBy * obs.zone.dps > me.hp * 2.5)) mode = "zone"
      }
      if (P.rotationTime > t && mode === "fight" && target && dist(target) < 120 &&
          !(target.hp < 200 && ttdMe > 3) && hpF > 0.3 && inCircle([x, y], safeCircle(obs, 6), 5)) mode = "rotate"
      const finalDistance = Math.hypot(x - obs.zone.next_center[0], y - obs.zone.next_center[1])
      const finalTravelTime = finalDistance / (me.stats.walk_speed ?? C.mech.walk_speed)
      const headingToFinal = P.zoneAnchor && obs.zone.next_radius === 0 && t + finalTravelTime * 1.35 + 8 >= obs.zone.shrink_start
      if (headingToFinal) mode = "zone"

      // ---- movement goal
      let mv: number[] = [0, 0]
      let boost = false
      let jump = false
      const gc = goalCircle(obs, x, y)
      const sc = safeCircle(obs, 4)
      let aimYaw = me.aim[0], aimPitch = 0
      let wantFace: number | null = null
      let lootCrate: Item | null = null
      let lootDrone: Track | null = null
      let staging = false
      let quiet = false // walk below sound.step_speed so footsteps make no sound

      if (mode === "retreat") {
        const attackers = recoverEarly ? enemies.filter((e) => attackedBy.has(e.id) || seeingMe.includes(e) || e === target) : []
        const threats = attackers.length ? attackers : enemies
        const concealed = P.safePlay && !seeingMe.length && inCircle([x, y], sc, 6) &&
          threats.every((e) => !visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8, x, y, z, myH))
        if (concealed) {
          cover = [x, y]
          coverT = t
        } else if (P.safePlay ? t - coverT > 0.8 : !cover || t - coverT > 0.8) {
          cover = findCover(obs, threats, x, y, z, myH, shortRetreat ? 30 : P.coverSearch)
          coverT = t
        }
        if (cover) {
          const d = Math.hypot(cover[0] - x, cover[1] - y)
          if (d > 1.5) mv = goTo(obs, cover[0], cover[1], x, y, z)
          boost = d > 4 && me.energy > 15
        } else {
          // run away from threats, within zone
          let ax = 0, ay = 0
          for (const e of threats) {
            const d = Math.max(5, dist(e))
            const weight = P.survival ? (attackedBy.has(e.id) ? 1.25 : 0.65) * Math.min(1.8, 65 / d) : 1
            ax += (x - e.pos[0]) / d * weight
            ay += (y - e.pos[1]) / d * weight
          }
          const g = clampToCircle([x + ax * 30, y + ay * 30], sc, P.zoneMargin)
          mv = goTo(obs, g[0], g[1], x, y, z)
          boost = me.energy > 15
        }
        // face nearest threat to keep front armor toward it
        let ne: Track | null = null
        for (const e of threats) if (!ne || dist(e) < dist(ne)) ne = e
        if (ne) wantFace = Math.atan2(ne.pos[1] - y, ne.pos[0] - x)
        if (P.retreatFix) {
          const hurtNow = t - lastDamagedT < 0.45
          // cover that still lets us get hit is not cover: re-search against everyone in view
          if (hurtNow && Math.hypot(mv[0], mv[1]) < 0.1) {
            cover = findCover(obs, visible.length ? visible : threats, x, y, z, myH, P.coverSearch)
            coverT = t
            if (cover && Math.hypot(cover[0] - x, cover[1] - y) > 1.5) mv = goTo(obs, cover[0], cover[1], x, y, z)
          }
          // never flee in a straight line while exposed: jink sideways so lead aim misses
          if ((hurtNow || seeingMe.length) && ne) {
            if (t > retreatJinkUntil) { retreatJinkDir = R() < 0.5 ? -1 : 1; retreatJinkUntil = t + P.strafeMin + R() * (P.strafeMax - P.strafeMin) }
            const ml = Math.hypot(mv[0], mv[1])
            const toE = Math.atan2(ne.pos[1] - y, ne.pos[0] - x)
            const px = Math.cos(toE + Math.PI / 2 * retreatJinkDir), py = Math.sin(toE + Math.PI / 2 * retreatJinkDir)
            if (ml < 0.1) mv = [px, py]
            else mv = [mv[0] / ml + px * P.retreatFix, mv[1] / ml + py * P.retreatFix]
            mv = steer(x, y, z, mv[0], mv[1])
          }
        }
      } else if (mode === "rotate" && target) {
        const away = Math.atan2(y - target.pos[1], x - target.pos[0])
        const d = dist(target)
        let bestScore = -Infinity
        for (const offset of [0, -0.45, 0.45, -0.9, 0.9, -1.35, 1.35, -1.8, 1.8]) {
          const dx = Math.cos(away + offset), dy = Math.sin(away + offset)
          const px = x + dx * 19, py = y + dy * 19
          const k = nav.cell(px, py)
          if (k < 0 || !nav.walkable(x, y, px, py)) continue
          let value = Math.cos(offset) * 2 + (dx * me.vel[0] + dy * me.vel[1]) / 12
          const margin = Math.max(2, sc.r - 10)
          value -= Math.max(0, Math.hypot(px - sc.c[0], py - sc.c[1]) - margin) / 3
          for (const foe of enemies) {
            const range = Math.hypot(px - foe.pos[0], py - foe.pos[1])
            if (range > 110) continue
            const exposed = visibleFrom(foe.pos[0], foe.pos[1], foe.pos[2] + 8, px, py, nav.s[k], myH)
            if (exposed) value -= (110 - range) / 17
          }
          if (value > bestScore) { bestScore = value; mv = [dx, dy] }
        }
        if (bestScore === -Infinity) mv = steer(x, y, z, Math.cos(away), Math.sin(away))
        boost = me.energy > (d < 55 ? 16 : 80)
        wantFace = Math.atan2(target.pos[1] - y, target.pos[0] - x)
      } else if (mode === "fight" && target) {
        const d = Math.hypot(target.pos[0] - x, target.pos[1] - y)
        const toT = Math.atan2(target.pos[1] - y, target.pos[0] - x)
        const tLight = target.weapons.includes("lightning")
        let pref = lightS >= 0 && me.energy > 20 ? P.lightRange : P.fightRange
        if (P.opening && lightS < 0) {
          if (tLight || target.weapons.includes("laser")) pref += 12
          else if (hpF > 0.8 && seeingMe.length < 2 && target.weapons.length === 1) pref -= 25
        }
        if (P.fightSpacing && lightS >= 0 && me.energy > 20) {
          if (tLight && (hpF < 0.85 || target.hp > me.hp * 0.7)) pref = P.fightRange
          else pref = W[lightS]!.stats.range * 0.81
        }
        if (tLight && !(lightS >= 0 && me.energy > 20)) pref = Math.max(pref, P.kiteRange)
        const shortCircuit = P.laserCounter > 0 && lightS >= 0 && laserS < 0 && target.weapons.includes("laser") && me.energy > 15
        if (shortCircuit) pref = Math.min(pref, C.weapons.lightning.range * 0.6)
        if (t > strafeUntil) {
          strafeDir = R() < 0.5 ? -1 : 1
          strafeUntil = t + P.strafeMin + R() * (P.strafeMax - P.strafeMin)
        }
        let radial = d > pref * 1.25 ? 1 : d < pref * 0.7 ? -0.8 : 0
        if (P.rangeControl) radial = Math.max(-2.8, Math.min(0.9, (d - pref) / 18))
        if (tLight && lightS < 0 && d < P.kiteRange) radial = -1.5
        const perp = toT + (Math.PI / 2) * strafeDir
        const enemyArc = C.weapons.lightning.range
        const contestArc = lightS >= 0 && (!P.fightSpacing || pref < enemyArc)
        const escapingArc = P.battleRoyale && tLight && !contestArc && d < Math.max(P.kiteRange, enemyArc + 10)
        if (escapingArc) radial = d < enemyArc + 5 ? -3 : -1.8
        const lateral = escapingArc && d < enemyArc + 5 ? 0.45 : P.rangeControl && d < pref - 24 ? 0.7 : 1
        mv = [Math.cos(perp) * lateral + Math.cos(toT) * radial, Math.sin(perp) * lateral + Math.sin(toT) * radial]
        // drift away from uninvolved mechs so they don't join
        if (P.thirdRepel) for (const e of bystanders) {
          const dd = Math.hypot(e.pos[0] - x, e.pos[1] - y)
          if (dd < 90 && dd > 1) { const w = ((90 - dd) / 90) * 2 * P.thirdRepel; mv[0] += ((x - e.pos[0]) / dd) * w; mv[1] += ((y - e.pos[1]) / dd) * w }
        }
        // Defeat in detail (Lanchester square law): when several enemies would arrive together,
        // back away from their centroid while firing so they string out, then fight the leader alone.
        if (P.detail && !escapingArc) {
          const near = visible.filter((e) => dist(e) < P.detailR)
          if (near.length >= 2) {
            const ds = near.map(dist).sort((a, b) => a - b)
            if (ds[1] - ds[0] < P.detailGap) {
              let cx = 0, cy = 0
              for (const e of near) { cx += e.pos[0]; cy += e.pos[1] }
              cx /= near.length; cy /= near.length
              const dc = Math.max(1, Math.hypot(x - cx, y - cy))
              mv[0] += (x - cx) / dc * P.detail
              mv[1] += (y - cy) / dc * P.detail
            }
          }
        }
        // Minimum Risk Movement (RoboWiki melee): with several threats, pick the reachable spot
        // that keeps LOS on our target while minimizing exposure to everyone else.
        if (P.mrm) {
          const threats = visible.filter((e) => dist(e) < 160)
          if (threats.length >= P.mrmMin && !escapingArc) {
            if (!mrmPt || t - mrmT > 0.3 || Math.hypot(mrmPt[0] - x, mrmPt[1] - y) < 2) {
              let best: number[] | null = null, br = Infinity
              for (const rad of [6, 12]) for (let i = 0; i < 12; i++) {
                const a = (i / 12) * Math.PI * 2 + (rad === 12 ? Math.PI / 12 : 0)
                const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad
                const k = nav.cell(px, py)
                if (k < 0 || !nav.ok[k] || Math.abs(nav.s[k] - z) > 1.6) continue
                if (!inCircle([px, py], sc, P.zoneMargin * 0.5)) continue
                const pz = nav.s[k]
                let risk = 0
                for (const e of threats) {
                  const de = Math.max(20, Math.hypot(e.pos[0] - px, e.pos[1] - py))
                  const seen = visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8, px, py, pz, myH)
                  risk += (dpsOf(e.weapons, de, e.cubes) + 40) * (seen ? 1 : 0.15) * 4000 / (de * de)
                }
                const dt2 = Math.hypot(target.pos[0] - px, target.pos[1] - py)
                const canShoot = world.los(px, py, pz + (muzZ - z), target.pos[0], target.pos[1], target.pos[2] + 4.5, 1.5)
                risk += canShoot ? 0 : P.mrmNoLos
                risk += P.mrmRange * ((dt2 - pref) / Math.max(20, pref)) ** 2
                if (risk < br) { br = risk; best = [px, py] }
              }
              mrmPt = best; mrmT = t
            }
            if (mrmPt) mv = [mrmPt[0] - x, mrmPt[1] - y]
          } else mrmPt = null
        }
        // if far and no LOS, path to it
        const losT = world.los(x, y, muzZ, target.pos[0], target.pos[1], target.pos[2] + 4.5, 1.0)
        const holdCover = P.rangeControl && hpF < 0.75 && d >= 45 && target.hp >= P.finishHp
        if (!losT && d > 12 && !escapingArc && !holdCover) mv = goTo(obs, target.pos[0], target.pos[1], x, y, z)
        // keep inside safe circle
        if (!inCircle([x, y], sc, P.zoneMargin * 0.5)) {
          mv = [sc.c[0] - x, sc.c[1] - y]
        }
        // avoid running into walls: steer to a walkable direction; flip strafe if mostly blocked
        if (losT || d <= 12 || escapingArc) {
          const st = steer(x, y, z, mv[0], mv[1])
          const ml0 = Math.hypot(mv[0], mv[1]) || 1
          if ((st[0] * mv[0] + st[1] * mv[1]) / ml0 < 0.2 && t > strafeUntil - (P.strafeMax - 0.3)) { strafeDir = -strafeDir; strafeUntil = t + P.strafeMin }
          mv = st
        }
        // peek fighting: hide during reload when nothing else can fire
        if (P.peek && gunS >= 0 && !escapingArc) {
          const g = W[gunS]!
          const reloading = (g.reload ?? 0) > 0.4 || (g.ammo ?? 1) <= 0
          const laserReady = laserS >= 0 && W[laserS]!.cooldown <= 0.3
          const lightReady = lightS >= 0 && d < 45 && me.energy > 10
          const holdPeek = P.peekHold && useGuard
          if (reloading && !laserReady && !lightReady && (losT || holdPeek && peekTarget === target.id)) {
            if (!peekCover || t - peekT > 1.0 && (!holdPeek || losT) || holdPeek && peekTarget !== target.id) {
              peekCover = findCover(obs, [target], x, y, z, myH, P.peekR)
              peekT = t
              peekTarget = target.id
            }
            if (peekCover && (!holdPeek || d > 23 && inCircle(peekCover, sc, 5))) {
              const reached = holdPeek && Math.hypot(peekCover[0] - x, peekCover[1] - y) < 1.8
              mv = reached ? [0, 0] : goTo(obs, peekCover[0], peekCover[1], x, y, z)
            }
          }
        }
        // dodge lasers: any enemy charging aimed at us
        const danger = visible.some((e) => e.charging && Math.abs(wrap(e.aim[0] - Math.atan2(y - e.pos[1], x - e.pos[0]))) < 0.25)
        boost = !!P.boostDodge && (danger || recentlyHurt) && me.energy > (lightS >= 0 ? 35 : 20)
        if (danger && P.losDodge) {
          const ch = visible.filter((e) => e.charging && Math.abs(wrap(e.aim[0] - Math.atan2(y - e.pos[1], x - e.pos[0]))) < 0.25)
          const reach = me.energy > 15 ? 9 : 5.5
          let bestA: number[] | null = null, bd2 = Infinity
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2
            const st = steer(x, y, z, Math.cos(a), Math.sin(a))
            if (Math.abs(st[0] - Math.cos(a)) > 0.01 || Math.abs(st[1] - Math.sin(a)) > 0.01) continue
            const px = x + Math.cos(a) * reach, py = y + Math.sin(a) * reach
            const hidden = ch.every((e) => !visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8, px, py, z, myH))
            if (!hidden) continue
            const dev = Math.abs(wrap(a - Math.atan2(mv[1], mv[0])))
            if (dev < bd2) { bd2 = dev; bestA = [Math.cos(a), Math.sin(a)] }
          }
          if (bestA) { mv = bestA; boost = me.energy > 5; dodging = t }
        }
        if (tLight && !contestArc && d < P.kiteRange && me.energy > 5) boost = true
        if (shortCircuit && d > C.weapons.lightning.range * 0.8 && me.energy > 25) boost = true
        if (P.rangeControl && d < pref - 30 && me.energy > 55 && (recentlyHurt || target.charging) && lightS < 0) boost = true
      } else if (mode === "rest") {
        const known = [...tracks.values()].filter((e) => t - e.seen < 30)
        if (known.length) {
          if (!cover || t - coverT > 1.5) { cover = findCover(obs, known, x, y, z, myH); coverT = t }
          if (cover && Math.hypot(cover[0] - x, cover[1] - y) > 1.5) mv = goTo(obs, cover[0], cover[1], x, y, z)
          let lk: Track | null = null
          for (const e of known) if (!lk || e.seen > lk.seen) lk = e
          if (lk) wantFace = Math.atan2(lk.pos[1] - y, lk.pos[0] - x)
        }
      } else if (mode === "zone") {
        const g = headingToFinal ? obs.zone.next_center : clampToCircle([x, y], gc, P.safePlay ? Math.min(P.zoneMargin, gc.r * 0.3) : P.zoneMargin)
        mv = goTo(obs, g[0], g[1], x, y, z)
        boost = me.energy > 10 && (!headingToFinal || finalDistance > 10)
      } else if (mode === "loot") {
        // loot / explore
        let goal: number[] | null = null
        let gscore = Infinity
        const considerGoal = (p: number[], value: number, crate: Item | null = null, drone: Track | null = null) => {
          if (!inCircle(p, gc, P.zoneMargin * 0.5)) return
          const d = Math.hypot(p[0] - x, p[1] - y)
          const s = d / value
          if (s < gscore) { gscore = s; goal = p; lootCrate = crate; lootDrone = drone }
        }
        const haveSecond = W[0] && W[1]
        for (const p of pickups.values()) {
          if (failedTake.has(p.id) && t - failedTake.get(p.id)! < 5) continue
          if (slotOf(p.kind as WeaponKind) >= 0) continue
          const d = Math.hypot(p.pos[0] - x, p.pos[1] - y)
          if (d > P.lootRadius || Math.abs(p.pos[2] - z) > 4) continue
          let v = haveSecond ? 0 : P.battleRoyale ? 2 + wscore(p.kind) : 3
          if (haveSecond) {
            const other = gunS === 0 ? 1 : 0
            if (wscore(p.kind) > wscore(W[other]?.kind) + 0.3) v = 1.5
            if (P.prepare > 1 && p.kind === "laser" && laserS < 0 && t < 75) v = 5
          }
          if (v > 0) considerGoal(p.pos, v)
        }
        if (me.cubes < P.cubeCap) for (const c of cubes.values()) if (Math.abs(c.pos[2] - z) < 4) considerGoal(c.pos, 4)
        if (P.prepare === 1 && (!haveSecond || me.cubes < 4) && gunS >= 0 && hpF > 0.76 && !recentlyHurt) {
          for (const c of crates.values()) {
            if (t - c.seen > 0.8 || Math.abs(c.pos[2] - z) > 4 || dist(c) > 62) continue
            const clear = world.los(x, y, muzZ, c.pos[0], c.pos[1], c.pos[2] + 1.2, 1)
            if (!clear || visible.some((e) => Math.hypot(e.pos[0] - c.pos[0], e.pos[1] - c.pos[1]) < 55)) continue
            considerGoal(c.pos, haveSecond ? 1.2 : 2.5, c)
          }
        }
        if (P.stockpile && t < 125 && me.cubes < 6 && gunS >= 0 && hpF > 0.78 && !recentlyHurt && !seeingMe.length) {
          for (const n of npcs.values()) {
            const distance = dist(n)
            if (distance > 70 || !n.vis || !world.los(x, y, muzZ, n.pos[0], n.pos[1], n.pos[2] + 1.75, 0.9)) continue
            considerGoal(n.pos, P.stockpile > 1 ? 3 : 1.5, null, n)
          }
        }
        if (lookingForLaser && hpF > 0.57) {
          const laser = safeLaserRoute(obs, enemies, false)
          if (laser) { goal = laser.pos; lootCrate = null; lootDrone = null }
        }
        const travelingToLoot = goal !== null
        if (P.ghost && t > P.ghostT && !lookingForLaser) { goal = null; lootCrate = null; lootDrone = null }
        if (P.zoneAnchor && goal === null && obs.zone.next_radius > 0 && obs.zone.next_radius <= (P.zoneAnchor > 1 || P.ghost && t > P.ghostT ? 380 : 140)) {
          const threatenedAnchor = anchor && enemies.some((e) => Math.hypot(e.pos[0] - anchor![0], e.pos[1] - anchor![1]) < 55)
          if (obs.zone.shrink_end !== anchorPhase || t - anchorCheckedAt > (threatenedAnchor ? 3 : 12)) {
            anchor = findZoneAnchor(obs, enemies)
            anchorPhase = obs.zone.shrink_end
            anchorCheckedAt = t
          }
          goal = anchor
          staging = !!(P.hideAtAnchor && anchor)
        }
        if (goal === null) {
          // wander inside goal circle, away from known enemies
          const crowdNearGoal = wander !== null && visible.some((e) => Math.hypot(e.pos[0] - wander![0], e.pos[1] - wander![1]) < 90)
          const surveying = P.kitSearch > 1 && lookingForLaser
          const maxWanderTime = surveying ? Math.min(P.wanderS, 9) : P.wanderS
          if (!wander || t - wanderT > maxWanderTime || Math.hypot(wander[0] - x, wander[1] - y) < 6 || !inCircle(wander, gc, P.zoneMargin) || (crowdNearGoal && t - wanderT > 2)) {
            let bestW: number[] | null = null, bws = -Infinity
            const known = [...tracks.values()]
            for (let k = 0; k < 40; k++) {
              const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * Math.max(5, gc.r - P.zoneMargin)
              const p = [gc.c[0] + Math.cos(a) * rr, gc.c[1] + Math.sin(a) * rr]
              const kk = nav.cell(p[0], p[1])
              if (kk < 0 || !nav.ok[kk]) continue
              let md = 200
              for (const e of known) md = Math.min(md, Math.hypot(e.pos[0] - p[0], e.pos[1] - p[1]) + (t - e.seen) * 2)
              const travel = Math.hypot(p[0] - x, p[1] - y)
              // path should not pass near visible enemies: penalize enemies close to the segment
              let segPen = 0
              for (const e of visible) {
                const vx = p[0] - x, vy = p[1] - y, L2 = vx * vx + vy * vy || 1
                const u = Math.max(0, Math.min(1, ((e.pos[0] - x) * vx + (e.pos[1] - y) * vy) / L2))
                const dd = Math.hypot(x + vx * u - e.pos[0], y + vy * u - e.pos[1])
                if (dd < 80) segPen += 80 - dd
              }
              const rc = Math.hypot(p[0] - gc.c[0], p[1] - gc.c[1]) / Math.max(1, gc.r - P.zoneMargin)
              const information = surveying && !surveyed.has(surveyCell(p[0], p[1])) ? 32 - Math.max(0, travel - 85) * 0.28 : 0
              const sc2 = md * P.wanderAvoid - travel * 0.25 + R() * 10 - segPen * P.segAvoid + rc * P.edgePref + information
              if (sc2 > bws) { bws = sc2; bestW = p }
            }
            if (bestW) wander = bestW
            wanderT = t
          }
          goal = wander
        }
        if (goal) {
          const gg = goal as number[]
          mv = goTo(obs, gg[0], gg[1], x, y, z)
          if (Math.hypot(gg[0] - x, gg[1] - y) < (lootCrate ? 8 : lootDrone ? 22 : 1)) mv = [0, 0]
        }
        if (P.repel) {
          let rx = 0, ry = 0
          for (const e of visible) {
            const d = Math.hypot(e.pos[0] - x, e.pos[1] - y)
            if (d < 70 && d > 1) { const w = (70 - d) / 70; rx += ((x - e.pos[0]) / d) * w; ry += ((y - e.pos[1]) / d) * w }
          }
          if (rx || ry) {
            const ml0 = Math.hypot(mv[0], mv[1]) || 1
            mv = steer(x, y, z, mv[0] / ml0 + rx * 2 * P.repel, mv[1] / ml0 + ry * 2 * P.repel)
          }
        }
        boost = !inCircle([x, y], gc, 0) && me.energy > 20
        if (P.ghost && t > P.ghostT && me.in_zone && enemies.some((e) => dist(e) < P.ghostQuiet)) {
          quiet = true
          boost = false
        }
        if (P.battleRoyale && travelingToLoot && goal && !haveSecond && me.energy > 65 && Math.hypot(goal[0] - x, goal[1] - y) > 12) boost = true
        if (staging && anchor && me.grounded && !recentlyHurt && !npcAngry && seeingMe.length === 0 &&
            Math.hypot(anchor[0] - x, anchor[1] - y) < 3 && me.in_zone && inCircle([x, y], safeCircle(obs, 8), 5)) {
          mode = "hide"
          mv = [0, 0]
          boost = false
        }
        // supply drop
        if (P.dropGrab && !P.supplyPriority && mode === "loot") {
          for (const dr of obs.drops) {
            const dd = Math.hypot(dr.pos[0] - x, dr.pos[1] - y)
            if (dd < P.dropRange && dr.lands_in < dd / 11 + 3 && (dr.holder === null || dr.holder === me_id)) {
              if (P.safePlay && !inCircle(dr.pos, safeCircle(obs, Math.max(dd / 11, dr.lands_in) + dr.capture_s), 5)) continue
              const contested = enemies.some((e) => Math.hypot(e.pos[0] - dr.pos[0], e.pos[1] - dr.pos[1]) < 40)
              if (!contested) {
                if (dd > dr.radius * 0.5) mv = goTo(obs, dr.pos[0], dr.pos[1], x, y, z)
                else mv = [0, 0]
              }
            }
          }
        }
      }

      if (P.harvest && useGuard && (mode === "fight" || mode === "loot") && me.in_zone && hpF > 0.45 &&
          me.cubes < P.cubeCap && seeingMe.length < 2 && (!target || dist(target) > 48)) {
        let salvage: Item | null = null
        let salvageCost = Infinity
        const reach = freshSalvage && hpF > 0.7 ? 44 : 22
        for (const cube of cubes.values()) {
          const [px, py, pz] = cube.pos
          const distance = Math.hypot(px - x, py - y)
          if (distance > reach || Math.abs(pz - z) > 4 || !inCircle(cube.pos, sc, 6)) continue
          if (!nav.walkable(x, y, px, py) || enemies.some((e) => Math.hypot(e.pos[0] - px, e.pos[1] - py) < 38)) continue
          const fromKill = freshSalvage && Math.hypot(px - freshSalvage.pos[0], py - freshSalvage.pos[1]) < 8
          const cost = distance / (fromKill ? 2 : 1)
          if (cost < salvageCost) { salvage = cube; salvageCost = cost }
        }
        if (salvage) {
          mv = [salvage.pos[0] - x, salvage.pos[1] - y]
          boost = me.energy > 60 && Math.hypot(mv[0], mv[1]) > 12
        }
      }

      if (lookingForLaser && P.kitSearch < 4 && mode === "fight" && hpF > 0.72 && target && seeingMe.length < 2 && dist(target) > 47 && !shortRetreat) {
        const laser = safeLaserRoute(obs, enemies, true)
        if (laser) {
          const distance = Math.hypot(laser.pos[0] - x, laser.pos[1] - y)
          mv = goTo(obs, laser.pos[0], laser.pos[1], x, y, z)
          boost = distance > 7 && me.energy > 48
        }
      }

      if (P.supplyPriority && P.dropGrab && mode !== "zone" && mode !== "hide" && (mode !== "fight" || hpF < 0.75 || seeingMe.length === 0)) {
        let bestDrop: (typeof obs.drops)[number] | null = null
        let bestTime = Infinity
        for (const drop of obs.drops) {
          if (drop.holder !== null && drop.holder !== me_id) continue
          const distance = Math.hypot(drop.pos[0] - x, drop.pos[1] - y)
          if (distance > P.dropRange || (mode === "retreat" && distance > 46)) continue
          const travel = distance / (me.stats.walk_speed ?? C.mech.walk_speed)
          const remaining = Math.max(travel, drop.lands_in) + drop.capture_s - drop.progress
          if (!inCircle(drop.pos, safeCircle(obs, remaining + 3), 6)) continue
          const contested = enemies.some((enemy) => {
            const nearDrop = Math.hypot(enemy.pos[0] - drop.pos[0], enemy.pos[1] - drop.pos[1])
            return nearDrop < (mode === "loot" ? 42 : 64)
          })
          if (contested || drop.lands_in > travel + (P.supplyPriority > 1 ? 12 : 5)) continue
          if (remaining < bestTime) { bestDrop = drop; bestTime = remaining }
        }
        if (bestDrop) {
          const distance = Math.hypot(bestDrop.pos[0] - x, bestDrop.pos[1] - y)
          mv = distance > bestDrop.radius * 0.45 ? goTo(obs, bestDrop.pos[0], bestDrop.pos[1], x, y, z) : [0, 0]
          boost = distance > 16 && me.energy > 50 && (hpF < 0.8 || bestDrop.lands_in < 3)
        }
      }

      // laser counter (any mode but fight, which has its own dodge): a visible charging laser aimed at us -> step out of its sight
      if (P.laserCounter > 0 && mode !== "fight") {
        const ch = visible.filter((e) => e.charging && Math.abs(wrap(e.aim[0] - Math.atan2(y - e.pos[1], x - e.pos[0]))) < 0.25 &&
          visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8, x, y, z, myH))
        if (ch.length) {
          const reach = me.energy > 15 ? 9 : 5.5
          let bestA: number[] | null = null, bd2 = Infinity
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2
            const st = steer(x, y, z, Math.cos(a), Math.sin(a))
            if (Math.abs(st[0] - Math.cos(a)) > 0.01 || Math.abs(st[1] - Math.sin(a)) > 0.01) continue
            const px = x + Math.cos(a) * reach, py = y + Math.sin(a) * reach
            if (!ch.every((e) => !visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8, px, py, z, myH))) continue
            const dev = Math.abs(wrap(a - Math.atan2(mv[1], mv[0])))
            if (dev < bd2) { bd2 = dev; bestA = [Math.cos(a), Math.sin(a)] }
          }
          if (bestA) { mv = bestA; boost = me.energy > 5; quiet = false }
          else {
            // no cover in reach: sprint across its line of fire
            const e = ch[0], toE = Math.atan2(e.pos[1] - y, e.pos[0] - x)
            mv = steer(x, y, z, Math.cos(toE + Math.PI / 2 * strafeDir), Math.sin(toE + Math.PI / 2 * strafeDir)); boost = me.energy > 5; quiet = false
          }
        }
      }
      if (P.projectileDodge && (mode === "fight" || mode === "retreat")) {
        mv = sidestepProjectiles(obs, mv, boost, myH, C.mech.radius * scale)
      }

      // ---- stuck handling
      const spd = Math.hypot(me.vel[0], me.vel[1])
      const wantMove = Math.hypot(mv[0], mv[1]) > 0.1
      if (wantMove && spd < 1.5 && me.grounded) stuckT += dt
      else stuckT = Math.max(0, stuckT - dt)
      if (stuckT > 0.7) { unstickUntil = t + 0.8; stuckT = 0; path = null; strafeDir = -strafeDir }
      if (t < unstickUntil) { jump = me.grounded; boost = !me.grounded && me.energy > 5 }

      // ---- aiming & firing
      if (target && (mode === "fight" || (mode === "retreat" && (finish || dist(target) < 60 || recentlyHurt)) || mode === "zone")) {
        const targetScale = 1 + (C.cubes.size_per_cube as number) * target.cubes
        const tp = [target.pos[0], target.pos[1], target.pos[2] + C.mech.height * 0.5 * targetScale]
        const tv = target.vel
        const d3 = Math.hypot(tp[0] - x, tp[1] - y, tp[2] - muzZ)
        const o = [x, y, muzZ]
        const losT = world.los(x, y, muzZ, tp[0], tp[1], tp[2], 0.8)
        // gun lead
        let ap = tp
        if (gunS >= 0) {
          const gs = W[gunS]!.stats.speed
          const latency = 0.05
          const pp = [tp[0] + tv[0] * latency, tp[1] + tv[1] * latency, tp[2] + Math.max(-5, tv[2]) * latency * 0.5]
          const ti = intercept(o, pp, [tv[0] * P.aimLead, tv[1] * P.aimLead, tv[2] * 0.3], gs)
          if (ti !== null) ap = [pp[0] + tv[0] * ti * P.aimLead, pp[1] + tv[1] * ti * P.aimLead, pp[2] + tv[2] * 0.3 * ti]
        }
        let useMortarOnly = false
        // Aim at the predicted impact point when the mortar is nearly ready.
        if (mortarS >= 0 && (!losT || P.mortarFocus) && d3 > 25 && d3 < 230 && W[mortarS]!.cooldown <= (P.mortarFocus ? 0.22 : 0.05)) {
          const ms = W[mortarS]!.stats
          const fz = target.pos[2] + (P.mortarFocus && losT ? 2.25 : 0.5)
          const dh = Math.hypot(target.pos[0] - x, target.pos[1] - y)
          const launchZ = z + myH + 0.5
          let tof = dh / (ms.speed * 0.7)
          let px = target.pos[0], py = target.pos[1], pit: number | null = null
          for (let step = 0; step < (P.mortarFocus ? 4 : 1); step++) {
            px = target.pos[0] + tv[0] * tof
            py = target.pos[1] + tv[1] * tof
            const dhp = Math.hypot(px - x, py - y)
            pit = ballisticPitch(dhp, fz - launchZ, ms.speed, ms.gravity, !!P.mortarFocus && losT)
            if (pit === null) break
            tof = dhp / (Math.cos(pit) * ms.speed)
          }
          const launchYaw = Math.atan2(py - y, px - x)
          const clear = !P.mortarFocus || (pit !== null && world.los(x, y, launchZ, x + Math.cos(launchYaw) * 12, y + Math.sin(launchYaw) * 12, launchZ + Math.tan(pit) * 12, 0.8))
          if (pit !== null && pit < C.mech.max_pitch && clear) {
            aimYaw = launchYaw
            aimPitch = pit
            useMortarOnly = true
            if (Math.abs(wrap(me.aim[0] - aimYaw)) < 0.03 && Math.abs(me.aim[1] - aimPitch) < 0.03 &&
                !strayRisk(aimYaw, aimPitch, d3 + ms.splash_radius)) fire[mortarS] = true
          }
        }
        if (!useMortarOnly) {
          aimYaw = Math.atan2(ap[1] - y, ap[0] - x)
          aimPitch = Math.atan2(ap[2] - muzZ, Math.hypot(ap[0] - x, ap[1] - y))
          const errY = Math.abs(wrap(me.aim[0] - aimYaw)), errP = Math.abs(me.aim[1] - aimPitch)
          const tol = Math.max(0.006, 2.0 / Math.max(1, d3))
          if (!P.fireControl && gunS >= 0 && losT && d3 < W[gunS]!.stats.range && errY < tol * 1.2 && errP < tol && !strayRisk(me.aim[0], me.aim[1], W[gunS]!.stats.range)) {
            const g = W[gunS]!
            if ((g.ammo ?? 1) > 0 && (g.reload ?? 0) <= 0) fire[gunS] = true
          }
          // laser
          if (laserS >= 0) {
            const L = W[laserS]!
            const ls = L.stats
            const chg = L.charge ?? 0
            const laserTiming = P.laserTiming && useGuard
            const launchDelay = laserTiming ? 1 / C.match.tick_hz : 0
            const dx = tp[0] - x + (tv[0] - me.vel[0]) * launchDelay
            const dy = tp[1] - y + (tv[1] - me.vel[1]) * launchDelay
            const dz = tp[2] - muzZ + (tv[2] - me.vel[2]) * launchDelay
            const dyaw = Math.atan2(dy, dx)
            const dp = Math.atan2(dz, Math.hypot(dx, dy))
            const ey = Math.abs(wrap(me.aim[0] - dyaw)), ep = Math.abs(me.aim[1] - dp)
            const ltol = Math.max(0.005, 1.6 / Math.max(1, d3))
            const yawSweep = launchDelay * (me.stats.turn_rate ?? C.mech.turn_rate) * 0.78
            const pitchSweep = launchDelay * (me.stats.pitch_rate ?? C.mech.pitch_rate) * 0.78
            const okShot = losT && d3 < ls.range && ey < ltol + yawSweep && ep < ltol * 1.5 + pitchSweep &&
              (!laserTiming || dp >= C.mech.min_pitch && dp <= C.mech.max_pitch)
            if (chg > 0) {
              // keep holding until full and aimed
              const cubeDamage = 1 + Number(C.cubes.damage_per_cube) * Math.min(me.cubes, Number(C.cubes.stat_cap))
              const damage = laserTiming ? ls.damage * cubeDamage : ls.damage
              const damageSeconds = (target.hp / damage - ls.min_frac) / (1 - ls.min_frac) * ls.charge
              const standardCharge = ls.charge
              const releaseAt = (P.fightSpacing || laserTiming) && damageSeconds < standardCharge * 0.9
                ? Math.min(standardCharge, Math.max(ls.min_charge, damageSeconds * 1.15, ls.charge * 0.5)) : standardCharge
              const full = chg + launchDelay >= releaseAt - 0.02
              const tooLong = chg > ls.charge + ls.hold_s - 0.25
              if ((full && okShot && !strayRisk(laserTiming ? dyaw : me.aim[0], laserTiming ? dp : me.aim[1], d3 + 5)) || tooLong) fire[laserS] = false
              else fire[laserS] = true
              // laser hitscan: aim straight at target, not leading
              if (gunS < 0 || chg > releaseAt * 0.7) { aimYaw = dyaw; aimPitch = dp }
            } else if (L.cooldown <= 0.1 && losT && d3 < ls.range &&
                !(P.battleRoyale && target.weapons.includes("lightning") && d3 < C.weapons.lightning.range + 9)) {
              fire[laserS] = true
            }
          }
          if (lightS >= 0) {
            const ls = W[lightS]!.stats
            const dyaw = Math.atan2(tp[1] - y, tp[0] - x)
            if (d3 < ls.range * 0.95 && Math.abs(wrap(me.aim[0] - dyaw)) < ((ls.cone_deg * Math.PI) / 180) * 0.7 && losT && me.energy >= ls.energy && W[lightS]!.cooldown <= 0.1) fire[lightS] = true
          }
          if (P.fireControl && gunS >= 0) {
            const gun = W[gunS]!
            const frame = 1 / C.match.tick_hz
            const now = Math.max(frame, gun.cooldown - 1e-6)
            if (d3 < gun.stats.range && now <= C.match.decide_every * frame && (gun.ammo ?? 1) > 0 && (gun.reload ?? 0) <= 0) {
              const yawLimit = now * (me.stats.turn_rate ?? C.mech.turn_rate) * 0.9
              const pitchLimit = now * (me.stats.pitch_rate ?? C.mech.pitch_rate) * 0.9
              const shotYaw = me.aim[0] + Math.max(-yawLimit, Math.min(yawLimit, wrap(aimYaw - me.aim[0])))
              const shotPitch = me.aim[1] + Math.max(-pitchLimit, Math.min(pitchLimit, aimPitch - me.aim[1]))
              const intendedYaw = Math.atan2(ap[1] - y, ap[0] - x)
              const intendedPitch = Math.atan2(ap[2] - muzZ, Math.hypot(ap[0] - x, ap[1] - y))
              if (Math.abs(wrap(shotYaw - intendedYaw)) < tol * targetScale && Math.abs(shotPitch - intendedPitch) < tol * 1.45 * targetScale &&
                  world.los(x, y, muzZ, ap[0], ap[1], ap[2], 0.8) && !strayRisk(shotYaw, shotPitch, gun.stats.range)) fire[gunS] = true
            }
          }
        }
      } else {
        // not fighting: shoot crates / npcs if cheap, else scan
        let shot = false
        if (mode === "loot" && !staging && gunS >= 0 && !(P.prepare > 1 && t < 2.3)) {
          let best: { pos: number[]; h: number } | null = lootCrate ? { pos: (lootCrate as Item).pos, h: 1.2 } : null
          let bd = lootCrate ? dist(lootCrate) : Infinity
          for (const c of crates.values()) {
            if (lootCrate) break
            if (t - c.seen > 0.5) continue
            const d = Math.hypot(c.pos[0] - x, c.pos[1] - y)
            if (d < P.crateRadius && d < bd && world.los(x, y, muzZ, c.pos[0], c.pos[1], c.pos[2] + 1.2, 0.8)) { bd = d; best = { pos: c.pos, h: 1.2 } }
          }
          for (const n of npcs.values()) {
            if (!n.vis) continue
            const d = Math.hypot(n.pos[0] - x, n.pos[1] - y)
            const angry = t - (npcAttack.get(n.id) ?? -99) < 4
            if (n !== lootDrone && !angry && (!P.npcFarm || best || P.survival && (hpF < 0.92 || visible.length > 0))) continue
            if (n === lootDrone) bd = Infinity
            if (angry) bd = Infinity
            if (d < (angry ? 120 : 70) && d < bd && (hpF > 0.6 || angry) && world.los(x, y, muzZ, n.pos[0], n.pos[1], n.pos[2] + 1.75, 0.8)) { bd = d; best = { pos: n.pos, h: 1.75 } }
          }
          if (best) {
            const tp = [best.pos[0], best.pos[1], best.pos[2] + best.h]
            aimYaw = Math.atan2(tp[1] - y, tp[0] - x)
            aimPitch = Math.atan2(tp[2] - muzZ, Math.hypot(tp[0] - x, tp[1] - y))
            const tol = Math.max(0.006, 1.0 / Math.max(1, bd))
            if (Math.abs(wrap(me.aim[0] - aimYaw)) < tol && Math.abs(me.aim[1] - aimPitch) < tol * 1.5) {
              const g = W[gunS]!
              if ((g.ammo ?? 1) > 0 && (g.reload ?? 0) <= 0) fire[gunS] = true
            }
            if (lightS >= 0 && bd < 40 && me.energy > 60 && Math.abs(wrap(me.aim[0] - aimYaw)) < 0.3) fire[lightS] = true
            shot = true
          }
        }
        if (!shot) {
          if (P.prepare > 1 && mode === "loot" && t < 2.3 && !recentlyHurt) aimYaw = wrap(2.8 * t)
          else if (wantFace !== null) aimYaw = wantFace
          else if (dmgBearings.length) aimYaw = dmgBearings[dmgBearings.length - 1].b
          else {
            // look toward last known enemy, else sweep around travel dir
            let lk: Track | null = null
            for (const e of tracks.values()) if (!lk || e.seen > lk.seen) lk = e
            const heard = obs.sounds.filter((s) => s.kind !== "step" && s.kind !== "death" && s.kind !== "drop" && s.kind !== "crate" && s.kind !== "npc_gun")
            if (heard.length) aimYaw = heard[0].bearing
            else if (lk && t - lk.seen < 15) aimYaw = Math.atan2(lk.pos[1] - y, lk.pos[0] - x)
            else if (P.spin) {
              // full 360° look-around: turn_rate 4 rad/s sweeps the 120° view wedge round in ~1.6 s,
              // legs move independently, so nobody can approach unseen from behind
              aimYaw = wrap(me.aim[0] + 1.2)
            } else {
              scanPhase += dt * 1.2
              const base = Math.hypot(mv[0], mv[1]) > 0.1 ? Math.atan2(mv[1], mv[0]) : me.aim[0]
              aimYaw = base + Math.sin(scanPhase) * 1.2
            }
          }
          aimPitch = 0
          // reload early when calm
          if (gunS >= 0) {
            const g = W[gunS]!
            if ((g.ammo ?? 12) < g.stats.mag * 0.5 && (g.reload ?? 0) <= 0 && t - lastDamagedT > 2) act.reload = true
          }
        }
        // keep laser from auto-firing while not fighting
        if (laserS >= 0 && (W[laserS]!.charge ?? 0) > 0) fire[laserS] = false
      }
      if (healing && mode === "retreat" && !finish) {
        // don't shoot while healing unless we are being hit anyway or enemy is close
        if (!(target && (dist(target) < 60 || recentlyHurt))) { fire[0] = false; fire[1] = false }
      }

      const ml = Math.hypot(mv[0], mv[1])
      const movementScale = headingToFinal && finalDistance < 3 ? Math.min(1, finalDistance / 2.5) : 1
      const quietScale = quiet && mode !== "fight" && mode !== "retreat" && mode !== "zone" ? Math.min(1, (C.sound.step_speed * 0.9) / (me.stats.walk_speed ?? C.mech.walk_speed)) : 1
      act.move = ml > 1e-6 ? [mv[0] / ml * movementScale * quietScale, mv[1] / ml * movementScale * quietScale] : [0, 0]
      act.boost = boost
      act.jump = jump
      act.aim = [wrap(aimYaw), Math.max(C.mech.min_pitch, Math.min(C.mech.max_pitch, aimPitch))]
      act.fire = fire
      return act
    },
    debugMode: () => mode,
  }
}

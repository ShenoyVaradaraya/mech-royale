// Main bot logic. Exported as makeBot(hello, world, nav) so the local simulator can run it in-process.
import type { Action, ActorObs, Hello, Observation, PickupObs, WeaponKind, WeaponObs } from "./mechfight.ts"
import { World } from "./world.ts"
import { Nav } from "./nav.ts"
import { ballisticPitch, intercept, rng, wrap } from "./geom.ts"

export const DEFAULT_P = {
  retreatHp: 0.42, // retreat to cover below this hp fraction
  reengageHp: 0.85, // leave cover after healing to this
  fightRange: 55, // preferred distance with gun/laser
  lightRange: 28, // preferred distance with lightning
  zoneMargin: 18,
  strafeMin: 0.6,
  strafeMax: 1.4,
  boostDodge: 1,
  lootRadius: 140,
  crateRadius: 70,
  npcFarm: 1,
  dropGrab: 1,
  laserScore: 3,
  lightScore: 2.6,
  mortarScore: 1.2,
  coverSearch: 55,
  finishHp: 260, // keep fighting a target below this hp even when low
  fearCount: 2, // retreat earlier when this many enemies see us
  aimLead: 1,
  campHp: 0.0,
  grudgeS: 12,
  hostileRange: 50,
  aggressive: 0,
  duelMargin: 0.8,
  kiteRange: 58,
  wanderS: 20,
  wanderAvoid: 2,
  segAvoid: 0.5,
  edgePref: 0,
  repel: 1,
  cubeCap: 99,
  closeRange: 35,
}
export type Params = typeof DEFAULT_P

type Track = { id: number; pos: number[]; vel: number[]; aim: number[]; hp: number; maxHp: number; weapons: string[]; charging: boolean; seen: number; vis: boolean; cubes: number }
type Item = { id: number; pos: number[]; kind?: string; hp?: number; seen: number }

const UPG_PRI = ["armor", "plating", "gun_rate", "nanites", "gun_damage", "laser_charge", "laser_damage", "lightning_damage", "lightning_range", "gun_mag", "gyros", "gun_velocity", "servos", "reactor", "capacitor", "jets", "sensors", "mortar_reload", "mortar_splash", "mortar_velocity"]

export function makeBot(hello: Hello, world: World, nav: Nav, params?: Partial<Params>) {
  const P: Params = { ...DEFAULT_P, ...(params ?? {}) }
  const C = hello.config
  const R = rng(hello.seed || 1)
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
  let lastPos: number[] = [0, 0, 0]
  let mode = "loot"
  let cover: number[] | null = null
  let coverT = -99
  let lastDamagedT = -99
  let lastHitT = -99
  let dmgBearings: { b: number; t: number; by: number | null }[] = []
  let wander: number[] | null = null
  let wanderT = -99
  let laserHeld = 0
  let lastT = 0
  let scanPhase = R() * 6
  let healing = false
  const failedTake = new Map<number, number>()
  const lastAttack = new Map<number, number>()
  const npcAttack = new Map<number, number>()
  let lastTargetId = -1

  const wscore = (k: string | undefined) => (k === "laser" ? P.laserScore : k === "lightning" ? P.lightScore : k === "mortar" ? P.mortarScore : 0)

  function safeCircle(obs: Observation, eta: number) {
    const z = obs.zone
    const t = obs.t
    // circle we must be in by time t+eta
    const tt = t + eta
    if (tt <= z.shrink_start) return { c: z.center, r: z.radius }
    if (tt >= z.shrink_end) return { c: z.next_center, r: z.next_radius }
    const f = (tt - z.shrink_start) / Math.max(1e-3, z.shrink_end - z.shrink_start)
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

  function goTo(obs: Observation, gx: number, gy: number, x: number, y: number, z: number): number[] {
    const t = obs.t
    const need = !path || !pathGoal || Math.hypot(pathGoal[0] - gx, pathGoal[1] - gy) > 6 || t - pathT > 2.5
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

  function findCover(obs: Observation, threats: Track[], x: number, y: number, z: number, h: number): number[] | null {
    const zc = safeCircle(obs, 8)
    const deadline = performance.now() + 7
    threats = threats.slice().sort((a, b) => Math.hypot(a.pos[0] - x, a.pos[1] - y) - Math.hypot(b.pos[0] - x, b.pos[1] - y)).slice(0, 4)
    let best: number[] | null = null
    let bs = Infinity
    for (let rad = 6; rad <= P.coverSearch; rad += 7) {
      const n = Math.max(8, Math.round(rad / 3))
      for (let a = 0; a < n; a++) {
        const ang = (a / n) * Math.PI * 2 + rad
        const px = x + Math.cos(ang) * rad, py = y + Math.sin(ang) * rad
        const k = nav.cell(px, py)
        if (k < 0 || !nav.ok[k]) continue
        const pz = nav.s[k]
        if (Math.abs(pz - z) > 6) continue
        if (!inCircle([px, py], zc, 6)) continue
        if (performance.now() > deadline) return best
        let hidden = true
        let tdist = Infinity
        for (const e of threats) {
          tdist = Math.min(tdist, Math.hypot(e.pos[0] - px, e.pos[1] - py))
          if (visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8, px, py, pz, h)) { hidden = false; break }
        }
        if (!hidden) continue
        if (!nav.walkable(x, y, px, py) && rad > 20) continue
        // prefer close, away from threats
        const sc = rad - Math.min(tdist, 80) * 0.25
        if (sc < bs) { bs = sc; best = [px, py] }
      }
      if (best && rad > 20) break
    }
    return best
  }

  function pickUpgrade(obs: Observation): number {
    const ch = obs.offer!.choices
    let bi = 0, bp = 999
    ch.forEach((c, i) => {
      const p = UPG_PRI.indexOf(c.id)
      const pp = p < 0 ? 50 : p
      if (pp < bp) { bp = pp; bi = i }
    })
    return bi
  }

  return {
    name: "oval-office",
    act(obs: Observation): Omit<Action, "tick"> {
      const t = obs.t
      const dt = Math.max(0.05, t - lastT)
      lastT = t
      const me = obs.self
      const [x, y, z] = me.pos
      const scale = 1 + (C.cubes.size_per_cube as number) * me.cubes
      const myH = 9 * scale
      const eyeZ = z + (me.stats.eye_height ?? 8 * scale)
      const muzZ = z + (me.stats.muzzle_height ?? 7 * scale)
      const act: Omit<Action, "tick"> = {}
      const hpF = me.hp / me.max_hp

      // ---- tracking
      for (const tr of tracks.values()) tr.vis = false
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
          if (e.by < 100) lastAttack.set(e.by, t)
          else npcAttack.set(e.by, t)
          if (e.bearing !== null) dmgBearings.push({ b: e.bearing, t, by: e.by })
        } else if (e.type === "damaged") {
          // zone damage: does not count as combat for our logic
        } else if (e.type === "hit") lastHitT = t
        else if (e.type === "take_failed") failedTake.set(e.id, t)
      }
      dmgBearings = dmgBearings.filter((d) => t - d.t < 4)

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
      let target: Track | null = null
      let tbest = Infinity
      for (const e of visible) {
        const d = dist(e)
        const losOk = world.los(x, y, muzZ, e.pos[0], e.pos[1], e.pos[2] + 4.5, 1.0)
        const toMe = Math.atan2(y - e.pos[1], x - e.pos[0])
        const facing = Math.abs(wrap(e.aim[0] - toMe)) < 0.5
        const approaching = (e.vel[0] * Math.cos(toMe) + e.vel[1] * Math.sin(toMe)) > 3
        const hostile = attackedBy.has(e.id) || (facing && approaching && d < P.hostileRange) || d < P.closeRange
        const weak = e.hp < e.maxHp * 0.45
        const want = hostile || weak || (P.aggressive && hpF > 0.8 && visible.length === 1)
        if (!want) continue
        let s = d / 40 + e.hp / 400 + (losOk ? 0 : 4) - (attackedBy.has(e.id) ? 1 : 0)
        if (e.id === lastTargetId) s -= 0.7
        if (s < tbest) { tbest = s; target = e }
      }
      lastTargetId = target ? target.id : -1

      // ---- mode
      const recentlyHurt = t - lastDamagedT < 1.5
      // duel estimate: time for us to kill target vs time for all seeing enemies to kill us
      let incoming = 0
      for (const e of visible) if (attackedBy.has(e.id) || seeingMe.includes(e)) incoming += dpsOf(e.weapons, dist(e), e.cubes)
      const myArmor = me.stats.armor ?? 0
      const ttdMe = me.hp / Math.max(1, incoming * (1 - myArmor))
      const ttkT = target ? target.hp / Math.max(1, dpsOf(myW, dist(target), me.cubes)) : Infinity
      const winning = target !== null && ttkT < ttdMe * P.duelMargin
      const fearful = (hpF < P.retreatHp && !winning) || (seeingMe.length >= P.fearCount && hpF < 0.7 && !winning) || (hpF < 0.2 && ttkT > 1.5)
      if (healing && (hpF >= P.reengageHp || enemies.length === 0 && hpF > 0.7)) healing = false
      if (fearful && enemies.length > 0) healing = true
      if (healing && winning && hpF > 0.25) healing = false
      // finishing a weak close target overrides retreat
      const finish = target && target.hp < P.finishHp && dist(target) < 120 && hpF > 0.15
      mode = healing && !finish ? "retreat" : target ? "fight" : "loot"
      if (!me.in_zone && obs.zone.dps * 3 > me.hp * 0.5) mode = "zone"

      // ---- movement goal
      let mv: number[] = [0, 0]
      let boost = false
      let jump = false
      const gc = goalCircle(obs, x, y)
      const sc = safeCircle(obs, 4)
      let aimYaw = me.aim[0], aimPitch = 0
      let wantFace: number | null = null

      if (mode === "retreat") {
        const threats = enemies
        if (!cover || t - coverT > 0.8) {
          cover = findCover(obs, threats, x, y, z, myH)
          coverT = t
        }
        if (cover) {
          const d = Math.hypot(cover[0] - x, cover[1] - y)
          if (d > 1.5) mv = goTo(obs, cover[0], cover[1], x, y, z)
          boost = d > 4 && me.energy > 15
        } else {
          // run away from threats, within zone
          let ax = 0, ay = 0
          for (const e of threats) { const d = Math.max(5, dist(e)); ax += (x - e.pos[0]) / d; ay += (y - e.pos[1]) / d }
          const g = clampToCircle([x + ax * 30, y + ay * 30], sc, P.zoneMargin)
          mv = goTo(obs, g[0], g[1], x, y, z)
          boost = me.energy > 15
        }
        // face nearest threat to keep front armor toward it
        let ne: Track | null = null
        for (const e of threats) if (!ne || dist(e) < dist(ne)) ne = e
        if (ne) wantFace = Math.atan2(ne.pos[1] - y, ne.pos[0] - x)
      } else if (mode === "fight" && target) {
        const d = Math.hypot(target.pos[0] - x, target.pos[1] - y)
        const toT = Math.atan2(target.pos[1] - y, target.pos[0] - x)
        const tLight = target.weapons.includes("lightning")
        let pref = lightS >= 0 && me.energy > 20 ? P.lightRange : P.fightRange
        if (tLight && !(lightS >= 0 && me.energy > 20)) pref = Math.max(pref, P.kiteRange)
        if (t > strafeUntil) {
          strafeDir = R() < 0.5 ? -1 : 1
          strafeUntil = t + P.strafeMin + R() * (P.strafeMax - P.strafeMin)
        }
        let radial = d > pref * 1.25 ? 1 : d < pref * 0.7 ? -0.8 : 0
        if (tLight && lightS < 0 && d < P.kiteRange) radial = -1.5
        const perp = toT + (Math.PI / 2) * strafeDir
        mv = [Math.cos(perp) + Math.cos(toT) * radial, Math.sin(perp) + Math.sin(toT) * radial]
        // if far and no LOS, path to it
        const losT = world.los(x, y, muzZ, target.pos[0], target.pos[1], target.pos[2] + 4.5, 1.0)
        if (!losT && d > 12) mv = goTo(obs, target.pos[0], target.pos[1], x, y, z)
        // keep inside safe circle
        if (!inCircle([x, y], sc, P.zoneMargin * 0.5)) {
          mv = [sc.c[0] - x, sc.c[1] - y]
        }
        // avoid running into walls: steer to a walkable direction; flip strafe if mostly blocked
        if (losT || d <= 12) {
          const st = steer(x, y, z, mv[0], mv[1])
          const ml0 = Math.hypot(mv[0], mv[1]) || 1
          if ((st[0] * mv[0] + st[1] * mv[1]) / ml0 < 0.2 && t > strafeUntil - (P.strafeMax - 0.3)) { strafeDir = -strafeDir; strafeUntil = t + P.strafeMin }
          mv = st
        }
        // dodge lasers: any enemy charging aimed at us
        const danger = visible.some((e) => e.charging && Math.abs(wrap(e.aim[0] - Math.atan2(y - e.pos[1], x - e.pos[0]))) < 0.25)
        boost = !!P.boostDodge && (danger || recentlyHurt) && me.energy > (lightS >= 0 ? 35 : 20)
        if (tLight && lightS < 0 && d < P.kiteRange && me.energy > 5) boost = true
      } else if (mode === "zone") {
        const g = clampToCircle([x, y], gc, P.zoneMargin)
        mv = goTo(obs, g[0], g[1], x, y, z)
        boost = me.energy > 10
      } else {
        // loot / explore
        let goal: number[] | null = null
        let gscore = Infinity
        const considerGoal = (p: number[], value: number) => {
          if (!inCircle(p, gc, P.zoneMargin * 0.5)) return
          const d = Math.hypot(p[0] - x, p[1] - y)
          const s = d / value
          if (s < gscore) { gscore = s; goal = p }
        }
        const haveSecond = W[0] && W[1]
        for (const p of pickups.values()) {
          if (failedTake.has(p.id) && t - failedTake.get(p.id)! < 5) continue
          if (slotOf(p.kind as WeaponKind) >= 0) continue
          const d = Math.hypot(p.pos[0] - x, p.pos[1] - y)
          if (d > P.lootRadius || Math.abs(p.pos[2] - z) > 4) continue
          let v = haveSecond ? 0 : 3
          if (haveSecond) {
            const other = gunS === 0 ? 1 : 0
            if (wscore(p.kind) > wscore(W[other]?.kind) + 0.3) v = 1.5
          }
          if (v > 0) considerGoal(p.pos, v)
        }
        if (me.cubes < P.cubeCap) for (const c of cubes.values()) if (Math.abs(c.pos[2] - z) < 4) considerGoal(c.pos, 4)
        if (goal === null) {
          // wander inside goal circle, away from known enemies
          const crowdNearGoal = wander !== null && visible.some((e) => Math.hypot(e.pos[0] - wander![0], e.pos[1] - wander![1]) < 90)
          if (!wander || t - wanderT > P.wanderS || Math.hypot(wander[0] - x, wander[1] - y) < 6 || !inCircle(wander, gc, P.zoneMargin) || (crowdNearGoal && t - wanderT > 2)) {
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
              const sc2 = md * P.wanderAvoid - travel * 0.25 + R() * 10 - segPen * P.segAvoid + rc * P.edgePref
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
          if (Math.hypot(gg[0] - x, gg[1] - y) < 1.0) mv = [0, 0]
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
        // supply drop
        if (P.dropGrab) {
          for (const dr of obs.drops) {
            const dd = Math.hypot(dr.pos[0] - x, dr.pos[1] - y)
            if (dd < 160 && dr.lands_in < dd / 11 + 3 && (dr.holder === null || dr.holder === me_id)) {
              const contested = enemies.some((e) => Math.hypot(e.pos[0] - dr.pos[0], e.pos[1] - dr.pos[1]) < 40)
              if (!contested) {
                if (dd > dr.radius * 0.5) mv = goTo(obs, dr.pos[0], dr.pos[1], x, y, z)
                else mv = [0, 0]
              }
            }
          }
        }
      }

      // ---- stuck handling
      const spd = Math.hypot(me.vel[0], me.vel[1])
      const wantMove = Math.hypot(mv[0], mv[1]) > 0.1
      if (wantMove && spd < 1.5 && me.grounded) stuckT += dt
      else stuckT = Math.max(0, stuckT - dt)
      if (stuckT > 0.7) { unstickUntil = t + 0.8; stuckT = 0; path = null; strafeDir = -strafeDir }
      if (t < unstickUntil) { jump = me.grounded; boost = !me.grounded && me.energy > 5 }
      lastPos = me.pos

      // ---- aiming & firing
      if (target && (mode === "fight" || (mode === "retreat" && (finish || dist(target) < 60 || recentlyHurt)) || mode === "zone")) {
        const tp = [target.pos[0], target.pos[1], target.pos[2] + 4.5 * (1 + 0.05 * (target.cubes ?? 0))]
        const tv = target.vel
        const d3 = Math.hypot(tp[0] - x, tp[1] - y, tp[2] - muzZ)
        const o = [x, y, muzZ]
        const losT = world.los(x, y, muzZ, tp[0], tp[1], tp[2], 0.8)
        // gun lead
        let ap = tp
        if (gunS >= 0) {
          const gs = W[gunS]!.stats.speed
          const lat = 0.05
          const pp = [tp[0] + tv[0] * lat, tp[1] + tv[1] * lat, tp[2] + Math.max(-5, tv[2]) * lat * 0.5]
          const ti = intercept(o, pp, [tv[0] * P.aimLead, tv[1] * P.aimLead, tv[2] * 0.3], gs)
          if (ti !== null) ap = [pp[0] + tv[0] * ti * P.aimLead, pp[1] + tv[1] * ti * P.aimLead, pp[2] + tv[2] * 0.3 * ti]
        }
        let useMortarOnly = false
        // mortar when no LOS
        if (mortarS >= 0 && !losT && d3 > 25 && d3 < 230 && W[mortarS]!.cooldown <= 0.05) {
          const ms = W[mortarS]!.stats
          const fz = target.pos[2] + 0.5
          const dh = Math.hypot(target.pos[0] - x, target.pos[1] - y)
          const tof = dh / (ms.speed * 0.7)
          const px = target.pos[0] + tv[0] * tof, py = target.pos[1] + tv[1] * tof
          const dhp = Math.hypot(px - x, py - y)
          const pit = ballisticPitch(dhp, fz - (z + myH + 0.5), ms.speed, ms.gravity, false)
          if (pit !== null && pit < C.mech.max_pitch) {
            aimYaw = Math.atan2(py - y, px - x)
            aimPitch = pit
            useMortarOnly = true
            if (Math.abs(wrap(me.aim[0] - aimYaw)) < 0.03 && Math.abs(me.aim[1] - aimPitch) < 0.03) fire[mortarS] = true
          }
        }
        if (!useMortarOnly) {
          aimYaw = Math.atan2(ap[1] - y, ap[0] - x)
          aimPitch = Math.atan2(ap[2] - muzZ, Math.hypot(ap[0] - x, ap[1] - y))
          const errY = Math.abs(wrap(me.aim[0] - aimYaw)), errP = Math.abs(me.aim[1] - aimPitch)
          const tol = Math.max(0.006, 2.0 / Math.max(1, d3))
          if (gunS >= 0 && losT && d3 < W[gunS]!.stats.range && errY < tol * 1.2 && errP < tol) {
            const g = W[gunS]!
            if ((g.ammo ?? 1) > 0 && (g.reload ?? 0) <= 0) fire[gunS] = true
          }
          // laser
          if (laserS >= 0) {
            const L = W[laserS]!
            const ls = L.stats
            const chg = L.charge ?? 0
            const dyaw = Math.atan2(tp[1] - y, tp[0] - x), dp = Math.atan2(tp[2] - muzZ, Math.hypot(tp[0] - x, tp[1] - y))
            const ey = Math.abs(wrap(me.aim[0] - dyaw)), ep = Math.abs(me.aim[1] - dp)
            const ltol = Math.max(0.005, 1.6 / Math.max(1, d3))
            const okShot = losT && d3 < ls.range && ey < ltol && ep < ltol * 1.5
            if (chg > 0) {
              // keep holding until full and aimed
              const full = chg >= ls.charge - 0.02
              const tooLong = chg > ls.charge + ls.hold_s - 0.25
              if ((full && okShot) || tooLong) fire[laserS] = false
              else fire[laserS] = true
              // laser hitscan: aim straight at target, not leading
              if (gunS < 0 || chg > ls.charge * 0.7) { aimYaw = dyaw; aimPitch = dp }
            } else if (L.cooldown <= 0.1 && losT && d3 < ls.range) {
              fire[laserS] = true
            }
          }
          if (lightS >= 0) {
            const ls = W[lightS]!.stats
            const dyaw = Math.atan2(tp[1] - y, tp[0] - x)
            if (d3 < ls.range * 0.95 && Math.abs(wrap(me.aim[0] - dyaw)) < ((ls.cone_deg * Math.PI) / 180) * 0.7 && losT && me.energy >= ls.energy && W[lightS]!.cooldown <= 0.1) fire[lightS] = true
          }
        }
      } else {
        // not fighting: shoot crates / npcs if cheap, else scan
        let shot = false
        if (mode === "loot" && gunS >= 0) {
          let best: { pos: number[]; h: number } | null = null
          let bd = Infinity
          for (const c of crates.values()) {
            if (t - c.seen > 0.5) continue
            const d = Math.hypot(c.pos[0] - x, c.pos[1] - y)
            if (d < P.crateRadius && d < bd && world.los(x, y, muzZ, c.pos[0], c.pos[1], c.pos[2] + 1.2, 0.8)) { bd = d; best = { pos: c.pos, h: 1.2 } }
          }
          for (const n of npcs.values()) {
            if (!n.vis) continue
            const d = Math.hypot(n.pos[0] - x, n.pos[1] - y)
            const angry = t - (npcAttack.get(n.id) ?? -99) < 4
            if (!angry && (!P.npcFarm || best)) continue
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
          if (wantFace !== null) aimYaw = wantFace
          else if (dmgBearings.length) aimYaw = dmgBearings[dmgBearings.length - 1].b
          else {
            // look toward last known enemy, else sweep around travel dir
            let lk: Track | null = null
            for (const e of tracks.values()) if (!lk || e.seen > lk.seen) lk = e
            const heard = obs.sounds.filter((s) => s.kind !== "step" && s.kind !== "death" && s.kind !== "drop" && s.kind !== "crate" && s.kind !== "npc_gun")
            if (heard.length) aimYaw = heard[0].bearing
            else if (lk && t - lk.seen < 15) aimYaw = Math.atan2(lk.pos[1] - y, lk.pos[0] - x)
            else {
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
      act.move = ml > 1e-6 ? [mv[0] / ml, mv[1] / ml] : [0, 0]
      act.boost = boost
      act.jump = jump
      act.aim = [wrap(aimYaw), Math.max(C.mech.min_pitch, Math.min(C.mech.max_pitch, aimPitch))]
      act.fire = fire
      laserHeld = fire[laserS >= 0 ? laserS : 0] ? laserHeld + dt : 0
      return act
    },
    debugMode: () => mode,
  }
}

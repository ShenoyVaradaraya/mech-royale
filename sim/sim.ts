// Local approximation of the mechfight server + house-bot squad, for offline evaluation.
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { join } from "node:path"
import { World } from "../world.ts"
import { Nav } from "../nav.ts"
import { gauss, intercept, rng, wrap, ballisticPitch } from "../geom.ts"
import type { Hello, Observation } from "../mechfight.ts"

const ROOT = join(import.meta.dirname!, "..")
export const HELLO: Hello = JSON.parse(gunzipSync(readFileSync(join(ROOT, "check/stream.jsonl.gz"))).toString().split("\n")[0])
const C: any = HELLO.config
const DT = 1 / C.match.tick_hz

type Wpn = { kind: string; cooldown: number; ammo: number; reload: number; charge: number; charging: boolean }
type Ctrl = { move: number[]; boost: boolean; jump: boolean; aim: number[]; fire: boolean[]; reload: boolean; pick?: number; take?: number; drop?: number }
export type Mech = {
  id: number; pos: number[]; vel: number[]; aim: number[]; hp: number; maxHp: number; energy: number; spendT: number; combatT: number
  weapons: (Wpn | null)[]; cubes: number; upgrades: string[]; ms: any; ws: any; alive: boolean; deathT: number; place: number; kills: number
  grounded: boolean; ctrl: Ctrl; offer: any; offerQ: number; seen: Map<number, number>; house: boolean; tier: number; ai: any
  events: any[]; sounds: any[]; beams: any[]; shortUntil: number; equipUntil: number[]; lastAttacker: number; lastAttackT: number; missed: number
}
type Proj = { kind: string; pos: number[]; vel: number[]; owner: number; dmg: number; travel: number; range: number; ttl: number; splash?: number; sr?: number }
type NPC = { id: number; pos: number[]; home: number[]; hp: number; target: number; cool: number; wander: number[]; wt: number; vel: number[]; aggroT: number }
type Crate = { id: number; pos: number[]; hp: number }
type Pick = { id: number; kind: string; pos: number[]; wpn?: Wpn }
type Cube = { id: number; pos: number[] }
type Drop = { id: number; pos: number[]; callT: number; landT: number; holder: number | null; progress: number; taken: boolean }

let WORLD: World | null = null
let NAV: Nav | null = null
export function loadMap() {
  if (!WORLD) { WORLD = new World(join(ROOT, "arena")); NAV = new Nav(WORLD) }
  return { world: WORLD!, nav: NAV! }
}

const clone = (o: any) => JSON.parse(JSON.stringify(o))

export type MatchOpts = { seed: number; mainFactory: (hello: Hello, world: World, nav: Nav) => { act(o: Observation): any }; verbose?: boolean; houseAll?: boolean }

export function runMatch(opts: MatchOpts) {
  const { world, nav } = loadMap()
  const R = rng(opts.seed * 7919 + 13)
  const mechs: Mech[] = []
  const projs: Proj[] = []
  const npcs: NPC[] = []
  const crates: Crate[] = []
  const picks: Pick[] = []
  const cubes: Cube[] = []
  const drops: Drop[] = []
  let nextId = { crate: 1000, cube: 5000, pick: 8000, drop: 20000, npc: 100 }
  let t = 0
  let tick = 0
  let aliveCount = 16
  const log: string[] = []
  const say = (s: string) => { if (opts.verbose) log.push(`${t.toFixed(1)} ${s}`) }

  // ---- zone
  const Z = C.zone
  const phases: { start: number; end: number; c0: number[]; r0: number; c1: number[]; r1: number; dps: number }[] = []
  {
    let c = Z.start_center.slice(), r = Z.start_radius, tt = 0
    for (const ph of Z.phases) {
      const a = R() * Math.PI * 2, off = Math.sqrt(R()) * Math.max(0, r - ph.radius) * 0.9
      const nc = [c[0] + Math.cos(a) * off, c[1] + Math.sin(a) * off]
      // keep next center on standable-ish ground inside bounds
      phases.push({ start: tt + ph.hold_s, end: tt + ph.hold_s + ph.shrink_s, c0: c, r0: r, c1: nc, r1: ph.radius, dps: ph.dps })
      tt += ph.hold_s + ph.shrink_s
      c = nc; r = ph.radius
    }
  }
  const zoneNow = () => {
    let ph = phases[phases.length - 1]
    for (const p of phases) if (t < p.end) { ph = p; break }
    let c = ph.c0, r = ph.r0
    if (t >= ph.start) {
      const f = Math.min(1, (t - ph.start) / (ph.end - ph.start))
      c = [ph.c0[0] + (ph.c1[0] - ph.c0[0]) * f, ph.c0[1] + (ph.c1[1] - ph.c0[1]) * f]
      r = ph.r0 + (ph.r1 - ph.r0) * f
    }
    return { center: c, radius: r, next_center: ph.c1, next_radius: ph.r1, shrink_start: ph.start, shrink_end: ph.end, dps: ph.dps }
  }

  const randOk = (cx: number, cy: number, rad: number, tries = 200): number[] | null => {
    for (let k = 0; k < tries; k++) {
      const a = R() * Math.PI * 2, rr = Math.sqrt(R()) * rad
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr
      const c = nav.cell(x, y)
      if (c >= 0 && nav.ok[c] && nav.s[c] - world.ground(x, y) < 0.5) return [x, y, nav.s[c]]
    }
    return null
  }

  // ---- spawn mechs
  const mainSlot = Math.floor(R() * 16)
  const tiers = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3]
  // shuffle tiers to slots
  const spawnPts: number[][] = []
  for (let i = 0; i < 16; i++) {
    let p: number[] | null = null
    for (let k = 0; k < 400 && !p; k++) {
      const q = randOk(Z.start_center[0], Z.start_center[1], Z.start_radius * C.match.spawn_zone_fraction, 1)
      if (q && spawnPts.every((s) => Math.hypot(s[0] - q[0], s[1] - q[1]) > C.match.spawn_min_separation * (k < 300 ? 1 : 0.5))) p = q
    }
    spawnPts.push(p ?? randOk(0, 0, 300)!)
  }
  let ti = 0
  for (let i = 0; i < 16; i++) {
    const house = i !== mainSlot
    const ms = clone(C.mech), ws = clone(C.weapons)
    mechs.push({
      id: i, pos: spawnPts[i].slice(), vel: [0, 0, 0], aim: [R() * 6 - 3, 0], hp: ms.hp, maxHp: ms.hp, energy: ms.energy, spendT: -9, combatT: -99,
      weapons: [{ kind: "gun", cooldown: 0, ammo: ws.gun.mag, reload: 0, charge: 0, charging: false }, null], cubes: 0, upgrades: [], ms, ws, alive: true, deathT: 0, place: 0, kills: 0,
      grounded: true, ctrl: { move: [0, 0], boost: false, jump: false, aim: [0, 0], fire: [false, false], reload: false }, offer: null, offerQ: 0, seen: new Map(), house, tier: house ? tiers[ti++] : -1, ai: {},
      events: [], sounds: [], beams: [], shortUntil: 0, equipUntil: [0, 0], lastAttacker: -1, lastAttackT: -99, missed: 0,
    })
  }
  const main = mechs[mainSlot]
  const ST = { shots: 0, gunHits: 0, dealt: 0, taken: 0, laserShots: 0, laserHits: 0, takenBy: {} as Record<string, number>, deathNear: 0, killerTier: null as any, deathHunters: 0 }
  // ---- loot, crates, npcs
  const W = ["mortar", "laser", "lightning"]
  for (let i = 0; i < C.loot.floor_count; i++) { const p = randOk(Z.start_center[0], Z.start_center[1], Z.start_radius * 0.85); if (p) picks.push({ id: nextId.pick++, kind: W[Math.floor(R() * 3)], pos: p }) }
  for (let i = 0; i < C.crates.count; i++) { const p = randOk(Z.start_center[0], Z.start_center[1], Z.start_radius * 0.85); if (p) crates.push({ id: nextId.crate++, pos: p, hp: C.crates.hp }) }
  for (let i = 0; i < C.npc.count; i++) { const p = randOk(Z.start_center[0], Z.start_center[1], Z.start_radius * 0.8); if (p) npcs.push({ id: nextId.npc++, pos: p.slice(), home: p.slice(), hp: C.npc.hp, target: -1, cool: 0, wander: p.slice(), wt: 0, vel: [0, 0, 0], aggroT: -99 }) }

  const hello: Hello = clone(HELLO)
  hello.slot = mainSlot
  hello.seed = (opts.seed * 2654435761) >>> 0
  const bot = opts.mainFactory(hello, world, nav)

  // ---- geometry helpers
  const scaleOf = (m: Mech) => 1 + C.cubes.size_per_cube * m.cubes
  const radOf = (m: Mech) => m.ms.radius * scaleOf(m)
  const hOf = (m: Mech) => m.ms.height * scaleOf(m)
  const colBlocked = (x: number, y: number, z0: number, z1: number) => {
    const k = world.cellOf(x, y)
    if (k < 0) return true
    if (world.ground(x, y) > z0) return true
    for (const [b, tp] of [[world.b0[k], world.t0[k]], [world.b1[k], world.t1[k]], [world.b2[k], world.t2[k]]]) if (b === b && b < z1 && tp > z0) return true
    return false
  }
  const support = (x: number, y: number, zf: number, step: number) => {
    const k = world.cellOf(x, y)
    let s = world.ground(x, y)
    if (k < 0) return s
    for (const [b, tp] of [[world.b0[k], world.t0[k]], [world.b1[k], world.t1[k]], [world.b2[k], world.t2[k]]]) if (b === b && tp <= zf + step + 0.01 && tp > s) s = tp
    return s
  }
  const bodyBlocked = (x: number, y: number, zf: number, r: number, h: number, step: number) => {
    if (!world.inBounds(x, y, r)) return true
    for (let a = 0; a < 9; a++) {
      const px = a === 8 ? x : x + Math.cos((a * Math.PI) / 4) * r * 0.9
      const py = a === 8 ? y : y + Math.sin((a * Math.PI) / 4) * r * 0.9
      if (colBlocked(px, py, zf + step, zf + h)) return true
    }
    return false
  }

  const inZone = (p: number[]) => { const z = zoneNow(); return Math.hypot(p[0] - z.center[0], p[1] - z.center[1]) <= z.radius }

  const canSee = (a: Mech, bx: number, by: number, bz: number, bh: number) => {
    const d = Math.hypot(bx - a.pos[0], by - a.pos[1])
    const near = C.vision.near_range + (a.ms.near_range_bonus ?? 0)
    const far = C.vision.range + (a.ms.vision_bonus ?? 0)
    if (d > far) return false
    if (d > near) {
      const yaw = Math.atan2(by - a.pos[1], bx - a.pos[0])
      if (Math.abs(wrap(yaw - a.aim[0])) > (C.vision.fov_deg * Math.PI) / 360) return false
    }
    const ez = a.pos[2] + a.ms.eye_height * scaleOf(a)
    return world.los(a.pos[0], a.pos[1], ez, bx, by, bz + bh * 0.5, 1.0) || world.los(a.pos[0], a.pos[1], ez, bx, by, bz + bh, 1.0)
  }

  const sound = (kind: string, p: number[], src: number) => {
    const rng_ = C.sound.range[kind] ?? 100
    for (const m of [main]) {
      if (!m.alive || m.id === src) continue
      const d = Math.hypot(p[0] - m.pos[0], p[1] - m.pos[1])
      if (d > rng_ * m.ms.hearing ** 0 ) continue
      const b = Math.atan2(p[1] - m.pos[1], p[0] - m.pos[0]) + gauss(R) * ((C.sound.bearing_noise_deg * m.ms.hearing * Math.PI) / 180)
      m.sounds.push({ kind, bearing: +wrap(b).toFixed(3), dist: d < C.sound.near ? "near" : d < C.sound.mid ? "mid" : "far", age: 0.05 })
    }
  }

  // ---- damage
  const killMech = (m: Mech, by: number) => {
    m.alive = false
    m.deathT = t
    m.hp = 0
    m.place = aliveCount // provisional; resolved at end of tick
    say(`mech ${m.id}${m === main ? " (MAIN)" : ""} died, by ${by}`)
    if (m === main) { ST.deathNear = mechs.filter((o) => o.alive && o !== m && Math.hypot(o.pos[0] - m.pos[0], o.pos[1] - m.pos[1]) < 120).length; ST.killerTier = mechs[by]?.tier ?? (by >= 100 ? 'npc' : 'zone'); ST.deathHunters = Math.min(15, 1 + (15 - mechs.filter((o) => o.alive && o.house).length) + (t > 200 ? 2 : 0) + (t > 290 ? 15 : 0)) }
    const k = mechs[by]
    if (k && by !== m.id) { k.kills++; k.events.push({ type: "kill", target: m.id }) }
    const n = m.cubes + C.cubes.death_drop_extra
    for (let i = 0; i < n; i++) cubes.push({ id: nextId.cube++, pos: [m.pos[0] + (R() - 0.5) * 6, m.pos[1] + (R() - 0.5) * 6, m.pos[2]] })
    for (const w of m.weapons) if (w && w.kind !== "gun") picks.push({ id: nextId.pick++, kind: w.kind, pos: [m.pos[0] + (R() - 0.5) * 3, m.pos[1] + (R() - 0.5) * 3, m.pos[2]], wpn: { ...w, charging: false, charge: 0 } })
    sound("death", m.pos, m.id)
  }
  const dmgMult = (a: Mech | undefined) => (a ? 1 + C.cubes.damage_per_cube * Math.min(a.cubes, C.cubes.stat_cap) : 1)
  const damageMech = (m: Mech, amount: number, by: number, weapon: string, from: number[]) => {
    if (!m.alive) return
    const att = mechs[by]
    let a = amount
    let rear = false
    if (weapon !== "zone") {
      const yaw = Math.atan2(from[1] - m.pos[1], from[0] - m.pos[0])
      if (Math.abs(wrap(yaw - m.aim[0])) > (m.ms.front_arc_deg * Math.PI) / 360) { rear = true; a *= m.ms.rear_mult }
      a *= 1 - Math.min(0.9, m.ms.armor)
      if (by === m.id) a *= m.ms.self_damage_mult
    }
    m.hp -= a
    m.combatT = t
    if (m === main) { ST.taken += a; const k = weapon + (att ? ':t' + att.tier : ''); ST.takenBy[k] = (ST.takenBy[k] ?? 0) + a }
    if (by === main.id && m !== main) { ST.dealt += a; if (weapon === 'gun') ST.gunHits++; if (weapon === 'laser') ST.laserHits++ }
    if (att && by !== m.id) { att.combatT = t; att.events.push({ type: "hit", target: m.id, amount: +a.toFixed(2), weapon, ...(rear ? { rear } : {}) }) }
    const bearing = weapon === "zone" ? null : +Math.atan2(from[1] - m.pos[1], from[0] - m.pos[0]).toFixed(3)
    m.events.push({ type: "damaged", amount: +a.toFixed(2), weapon, bearing, by: weapon === "zone" ? null : by, ...(rear ? { rear } : {}) })
    if (by >= 0 && by < 16 && by !== m.id) { m.lastAttacker = by; m.lastAttackT = t }
    if (m.hp <= 0) killMech(m, by)
  }
  const damageNpc = (n: NPC, amount: number, by: number) => {
    if (n.hp <= 0) return
    n.hp -= amount
    n.target = by; n.aggroT = t
    const att = mechs[by]
    if (att) { att.combatT = t; att.events.push({ type: "hit", target: n.id, amount, weapon: "npc" }) }
    if (n.hp <= 0) for (let i = 0; i < C.npc.cubes; i++) cubes.push({ id: nextId.cube++, pos: [n.pos[0] + (R() - 0.5) * 3, n.pos[1] + (R() - 0.5) * 3, n.pos[2]] })
  }
  const damageCrate = (c: Crate, amount: number, by: number) => {
    if (c.hp <= 0) return
    c.hp -= amount
    const att = mechs[by]
    if (att) att.events.push({ type: "hit", target: c.id, amount, weapon: "gun" })
    if (c.hp <= 0) {
      cubes.push({ id: nextId.cube++, pos: c.pos.slice() })
      if (R() < C.loot.crate_weapon_chance) picks.push({ id: nextId.pick++, kind: W[Math.floor(R() * 3)], pos: [c.pos[0] + 1, c.pos[1], c.pos[2]] })
      sound("crate", c.pos, -1)
    }
  }

  // ray vs actors: returns nearest hit along segment from o dir d length L
  type Hit = { kind: "mech" | "npc" | "crate"; ref: any; s: number } | null
  const rayActors = (o: number[], d: number[], L: number, owner: number, rad = 0): Hit => {
    let best: Hit = null
    const test = (cx: number, cy: number, z0: number, h: number, r: number, kind: any, ref: any) => {
      // closest approach in xy
      const fx = o[0] - cx, fy = o[1] - cy
      const a = d[0] * d[0] + d[1] * d[1]
      const rr = r + rad
      let s0: number, s1: number
      if (a < 1e-9) { if (fx * fx + fy * fy > rr * rr) return; s0 = 0; s1 = L }
      else {
        const b = 2 * (fx * d[0] + fy * d[1]), c = fx * fx + fy * fy - rr * rr
        const disc = b * b - 4 * a * c
        if (disc < 0) return
        const q = Math.sqrt(disc)
        s0 = (-b - q) / (2 * a); s1 = (-b + q) / (2 * a)
      }
      // z slab
      if (Math.abs(d[2]) > 1e-9) {
        let z0s = (z0 - o[2]) / d[2], z1s = (z0 + h - o[2]) / d[2]
        if (z0s > z1s) [z0s, z1s] = [z1s, z0s]
        s0 = Math.max(s0, z0s); s1 = Math.min(s1, z1s)
      } else if (o[2] < z0 || o[2] > z0 + h) return
      if (s1 < s0 || s1 < 0 || s0 > L) return
      const s = Math.max(0, s0)
      if (!best || s < best.s) best = { kind, ref, s }
    }
    for (const m of mechs) if (m.alive && m.id !== owner) test(m.pos[0], m.pos[1], m.pos[2], hOf(m), radOf(m), "mech", m)
    for (const n of npcs) if (n.hp > 0) test(n.pos[0], n.pos[1], n.pos[2], C.npc.height, C.npc.radius, "npc", n)
    for (const c of crates) if (c.hp > 0) test(c.pos[0], c.pos[1], c.pos[2], C.crates.height, C.crates.radius, "crate", c)
    return best
  }
  const aimDir = (m: Mech) => [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
  const shotOrigin = (m: Mech, h: number) => {
    const d = aimDir(m)
    const base = [m.pos[0], m.pos[1], m.pos[2] + h]
    const want = radOf(m) + 0.5
    const hit = world.rayHit(base[0], base[1], base[2], base[0] + d[0] * want, base[1] + d[1] * want, base[2] + d[2] * want, 0.3)
    const s = Math.max(0, Math.min(want, hit - 0.2))
    return [base[0] + d[0] * s, base[1] + d[1] * s, base[2] + d[2] * s]
  }

  const explode = (p: number[], owner: number, direct: any) => {
    const ws = mechs[owner]?.ws.mortar ?? C.weapons.mortar
    const dm = dmgMult(mechs[owner])
    sound("explosion", p, -1)
    for (const m of mechs) {
      if (!m.alive) continue
      const cz = m.pos[2] + hOf(m) / 2
      const d = Math.max(0, Math.hypot(m.pos[0] - p[0], m.pos[1] - p[1], cz - p[2]) - radOf(m))
      let amt = 0
      if (direct === m) amt += ws.damage
      if (d <= ws.splash_radius && world.los(p[0], p[1], p[2] + 0.3, m.pos[0], m.pos[1], cz, 0.7)) {
        const f = 1 - (1 - ws.splash_edge) * (d / ws.splash_radius)
        amt += ws.splash * f
        // knock
        const kx = m.pos[0] - p[0], ky = m.pos[1] - p[1], kl = Math.hypot(kx, ky) || 1
        m.vel[0] += (kx / kl) * ws.knock * f; m.vel[1] += (ky / kl) * ws.knock * f; m.vel[2] += ws.knock_up * f
        m.grounded = false
        m.energy = Math.max(0, m.energy - ws.drain * f)
        if (m.id !== owner) m.events.push({ type: "effect", effect: "concuss", by: owner })
      }
      if (amt > 0) damageMech(m, amt * dm, owner, "mortar", p)
    }
    for (const n of npcs) if (n.hp > 0 && Math.hypot(n.pos[0] - p[0], n.pos[1] - p[1]) < ws.splash_radius + 1.8) damageNpc(n, ws.splash * dm * 0.6, owner)
    for (const c of crates) if (c.hp > 0 && Math.hypot(c.pos[0] - p[0], c.pos[1] - p[1]) < ws.splash_radius + 1.4) damageCrate(c, ws.splash * dm * 0.6, owner)
  }

  // ---- weapon firing
  const fireWeapons = (m: Mech) => {
    for (let s = 0; s < 2; s++) {
      const w = m.weapons[s]
      if (!w) continue
      w.cooldown = Math.max(0, w.cooldown - DT)
      if (w.kind === "gun") {
        if (w.reload > 0) { w.reload -= DT; if (w.reload <= 0) { w.reload = 0; w.ammo = m.ws.gun.mag } }
        if (m.ctrl.reload && w.reload <= 0 && w.ammo < m.ws.gun.mag) { w.reload = m.ws.gun.reload; sound("reload", m.pos, m.id) }
      }
      const trig = m.ctrl.fire[s] && t >= m.equipUntil[s]
      const ws = m.ws[w.kind]
      if (w.kind === "laser") {
        if (trig && !w.charging && w.cooldown <= 0 && t >= m.shortUntil) { w.charging = true; w.charge = 0; sound("laser_charge", m.pos, m.id) }
        if (w.charging) {
          w.charge += DT
          const release = (!trig && w.charge >= ws.min_charge) || w.charge >= ws.charge + ws.hold_s
          if (release) {
            const f = Math.min(1, w.charge / ws.charge)
            const dmg = ws.damage * (ws.min_frac + (1 - ws.min_frac) * f) * dmgMult(m)
            const o = shotOrigin(m, m.ms.muzzle_height * scaleOf(m)), d = aimDir(m)
            const L = world.rayHit(o[0], o[1], o[2], o[0] + d[0] * ws.range, o[1] + d[1] * ws.range, o[2] + d[2] * ws.range, 0.7)
            const h = rayActors(o, d, L, m.id)
            const end = h ? h.s : L
            const ep = [o[0] + d[0] * end, o[1] + d[1] * end, o[2] + d[2] * end]
            if (h?.kind === "mech") damageMech(h.ref, dmg * (h.ref.weapons.some((x: Wpn | null) => x?.kind === "mortar") ? 1 + ws.cookoff : 1), m.id, "laser", o)
            else if (h?.kind === "npc") damageNpc(h.ref, dmg, m.id)
            else if (h?.kind === "crate") damageCrate(h.ref, dmg, m.id)
            if (main.alive && m !== main && (canSee(main, o[0], o[1], o[2] - 7, 9) || canSee(main, ep[0], ep[1], ep[2] - 4, 8))) main.beams.push({ by: m.id, kind: "laser", path: [o, ep], age: 0.05 })
            sound("laser", m.pos, m.id)
            if (m === main) ST.laserShots++
            w.charging = false; w.charge = 0; w.cooldown = ws.cooldown
          }
        }
        continue
      }
      if (!trig || w.cooldown > 0) continue
      if (w.kind === "gun") {
        if (w.reload > 0) continue
        if (w.ammo <= 0) { w.reload = m.ws.gun.reload; continue }
        w.ammo--
        w.cooldown = ws.cooldown
        if (w.ammo <= 0) w.reload = ws.reload
        const o = shotOrigin(m, m.ms.muzzle_height * scaleOf(m))
        const sp = (ws.spread_deg * Math.PI) / 180
        const yaw = m.aim[0] + gauss(R) * sp, pit = m.aim[1] + gauss(R) * sp
        const d = [Math.cos(pit) * Math.cos(yaw), Math.cos(pit) * Math.sin(yaw), Math.sin(pit)]
        projs.push({ kind: "gun", pos: o, vel: d.map((v) => v * ws.speed), owner: m.id, dmg: ws.damage * dmgMult(m), travel: 0, range: ws.range, ttl: 5 })
        sound("gun", m.pos, m.id)
        if (m === main) ST.shots++
      } else if (w.kind === "mortar") {
        w.cooldown = ws.cooldown
        const o = shotOrigin(m, m.ms.height * scaleOf(m) + 0.5), d = aimDir(m)
        projs.push({ kind: "mortar", pos: o, vel: d.map((v) => v * ws.speed), owner: m.id, dmg: ws.damage, travel: 0, range: 1e9, ttl: ws.ttl })
        sound("mortar", m.pos, m.id)
      } else if (w.kind === "lightning") {
        if (m.energy < ws.energy) continue
        m.energy -= ws.energy; m.spendT = t
        w.cooldown = ws.cooldown
        const o = [m.pos[0], m.pos[1], m.pos[2] + m.ms.muzzle_height * scaleOf(m)]
        const cone = (ws.cone_deg * Math.PI) / 180
        const cands: { kind: string; ref: any; p: number[] }[] = []
        for (const x of mechs) if (x.alive && x !== m) cands.push({ kind: "mech", ref: x, p: [x.pos[0], x.pos[1], x.pos[2] + hOf(x) / 2] })
        for (const n of npcs) if (n.hp > 0) cands.push({ kind: "npc", ref: n, p: [n.pos[0], n.pos[1], n.pos[2] + 1.75] })
        for (const c of crates) if (c.hp > 0) cands.push({ kind: "crate", ref: c, p: [c.pos[0], c.pos[1], c.pos[2] + 1.2] })
        let first: any = null, fd = Infinity
        for (const c of cands) {
          const d = Math.hypot(c.p[0] - o[0], c.p[1] - o[1], c.p[2] - o[2])
          if (d > ws.range || d >= fd) continue
          if (Math.abs(wrap(Math.atan2(c.p[1] - o[1], c.p[0] - o[0]) - m.aim[0])) > cone) continue
          if (!world.los(o[0], o[1], o[2], c.p[0], c.p[1], c.p[2], 0.8)) continue
          first = c; fd = d
        }
        sound("lightning", m.pos, m.id)
        const path = [o]
        if (first) {
          const hitList = [first]
          let cur = first, dmg = ws.damage * dmgMult(m)
          for (let j = 0; j <= ws.chain; j++) {
            path.push(cur.p)
            if (cur.kind === "mech") {
              damageMech(cur.ref, dmg, m.id, "lightning", path[path.length - 2])
              if (cur.ref.weapons.some((x: Wpn | null) => x?.kind === "laser")) { cur.ref.shortUntil = t + ws.short_s; for (const x of cur.ref.weapons) if (x?.kind === "laser") { x.charging = false; x.charge = 0 } }
            } else if (cur.kind === "npc") damageNpc(cur.ref, dmg, m.id)
            else damageCrate(cur.ref, dmg, m.id)
            dmg *= ws.chain_falloff
            let nx: any = null, nd = Infinity
            for (const c of cands) {
              if (hitList.includes(c)) continue
              const d = Math.hypot(c.p[0] - cur.p[0], c.p[1] - cur.p[1], c.p[2] - cur.p[2])
              if (d < ws.chain_range && d < nd) { nd = d; nx = c }
            }
            if (!nx) break
            hitList.push(nx); cur = nx
          }
        }
        if (main.alive && m !== main && Math.hypot(m.pos[0] - main.pos[0], m.pos[1] - main.pos[1]) < 200) main.beams.push({ by: m.id, kind: "lightning", path, age: 0.05 })
      }
    }
  }

  // ---- movement
  const moveMech = (m: Mech) => {
    const c = m.ctrl
    // aim slew
    const tr = m.ms.turn_rate * DT, pr = m.ms.pitch_rate * DT
    const dy = wrap(c.aim[0] - m.aim[0])
    m.aim[0] = wrap(m.aim[0] + Math.max(-tr, Math.min(tr, dy)))
    const tp = Math.max(m.ms.min_pitch, Math.min(m.ms.max_pitch, c.aim[1]))
    m.aim[1] += Math.max(-pr, Math.min(pr, tp - m.aim[1]))
    let mvx = c.move[0], mvy = c.move[1]
    const ml = Math.hypot(mvx, mvy)
    if (ml > 1) { mvx /= ml; mvy /= ml }
    const charging = m.weapons.some((w) => w?.charging)
    let spd = m.ms.walk_speed
    let spent = false
    if (c.boost && m.grounded && ml > 0.05 && m.energy > 0) { spd = m.ms.boost_speed; m.energy -= m.ms.boost_drain * DT; spent = true }
    if (charging) spd *= m.ms.charge_move_mult
    const tvx = mvx * spd, tvy = mvy * spd
    const acc = (m.grounded ? m.ms.ground_accel : m.ms.air_accel) * DT
    const ddx = tvx - m.vel[0], ddy = tvy - m.vel[1], dl = Math.hypot(ddx, ddy)
    if (dl <= acc) { m.vel[0] = tvx; m.vel[1] = tvy } else { m.vel[0] += (ddx / dl) * acc; m.vel[1] += (ddy / dl) * acc }
    if (c.jump && m.grounded) { m.vel[2] = m.ms.jump_speed; m.grounded = false }
    if (!m.grounded) {
      m.vel[2] -= m.ms.gravity * DT
      if (c.boost && m.energy > 0) { m.vel[2] = Math.min(m.ms.max_rise_speed, m.vel[2] + m.ms.jet_accel * DT); m.energy -= m.ms.jet_drain * DT; spent = true; if (tick % 10 === 0) sound("jet", m.pos, m.id) }
    }
    if (spent) m.spendT = t
    else if (t - m.spendT > m.ms.energy_regen_delay) m.energy = Math.min(m.ms.energy, m.energy + m.ms.energy_regen * DT)
    m.energy = Math.max(0, m.energy)
    const r = radOf(m), h = hOf(m)
    let [x, y, zf] = m.pos
    const nx = x + m.vel[0] * DT, ny = y + m.vel[1] * DT
    const step = m.ms.step_up
    if (!bodyBlocked(nx, ny, zf, r, h, step)) { x = nx; y = ny }
    else if (!bodyBlocked(nx, y, zf, r, h, step)) { x = nx; m.vel[1] = 0 }
    else if (!bodyBlocked(x, ny, zf, r, h, step)) { y = ny; m.vel[0] = 0 }
    else { m.vel[0] = 0; m.vel[1] = 0 }
    const sup = support(x, y, zf + 0.01, step)
    if (m.grounded) {
      if (sup >= zf - 0.6) zf = sup
      else m.grounded = false
    }
    if (!m.grounded) {
      let nz = zf + m.vel[2] * DT
      // ceiling
      if (m.vel[2] > 0 && colBlocked(x, y, nz + h - 0.1, nz + h)) { nz = zf; m.vel[2] = 0 }
      const sup2 = support(x, y, Math.max(zf, nz), Math.max(step, zf - nz + 0.01))
      if (nz <= sup2) { nz = sup2; m.vel[2] = 0; m.grounded = true }
      zf = nz
    } else m.vel[2] = 0
    m.pos = [x, y, zf]
    if (m.grounded && Math.hypot(m.vel[0], m.vel[1]) > C.sound.step_speed && tick % 12 === 0) sound(c.boost ? "boost" : "step", m.pos, m.id)
  }

  // ---- upgrades
  const offerFor = (m: Mech) => {
    const held = new Set(m.weapons.filter(Boolean).map((w) => w!.kind))
    const elig = C.upgrades.filter((u: any) => (!u.requires || held.has(u.requires)) && m.upgrades.filter((x) => x === u.id).length < u.max)
    const ch: any[] = []
    while (ch.length < 3 && elig.length) ch.push(elig.splice(Math.floor(R() * elig.length), 1)[0])
    if (!ch.length) return null
    return { id: tick, expires: t + C.bot.offer_timeout_s, choices: ch.map((u: any) => ({ id: u.id, name: u.name, desc: u.desc })) }
  }
  const applyUpg = (m: Mech, id: string) => {
    const u = C.upgrades.find((x: any) => x.id === id)
    if (!u) return
    m.upgrades.push(id)
    for (const e of u.effects) {
      const [root, a, b] = e.path.split(".")
      const obj = root === "mech" ? m.ms : m.ws[a]
      const key = root === "mech" ? a : b
      if (e.mul !== undefined) obj[key] *= e.mul
      if (e.add !== undefined) obj[key] += e.add
      if (root === "mech" && key === "hp") { const old = m.maxHp; m.maxHp = m.ms.hp * (1 + C.cubes.hp_per_cube * Math.min(m.cubes, C.cubes.stat_cap)); m.hp += m.maxHp - old }
    }
    m.events.push({ type: "upgrade", id })
  }
  const gainCube = (m: Mech, n = 1) => {
    for (let i = 0; i < n; i++) {
      m.cubes++
      const old = m.maxHp
      m.maxHp = m.ms.hp * (1 + C.cubes.hp_per_cube * Math.min(m.cubes, C.cubes.stat_cap))
      m.hp += m.maxHp - old
      if (C.cubes.upgrade_thresholds.includes(m.cubes)) m.offerQ++
    }
    m.events.push({ type: "pickup", cubes: m.cubes })
  }

  // ---- observation for main
  const wObs = (m: Mech, w: Wpn | null) => w && ({ kind: w.kind, cooldown: +w.cooldown.toFixed(3), ...(w.kind === "gun" ? { ammo: w.ammo, reload: +Math.max(0, w.reload).toFixed(3) } : {}), ...(w.kind === "laser" ? { charge: +w.charge.toFixed(3) } : {}), stats: { ...m.ws[w.kind] } })
  const buildObs = (m: Mech): Observation => {
    const mlist: any[] = []
    for (const o of mechs) {
      if (o === m || !o.alive) continue
      if (canSee(m, o.pos[0], o.pos[1], o.pos[2], hOf(o))) m.seen.set(o.id, t)
      const st = m.seen.get(o.id)
      if (st !== undefined && t - st <= C.vision.memory_s)
        mlist.push({ id: o.id, kind: "mech", pos: o.pos.map((v) => +v.toFixed(2)), vel: o.vel.map((v) => +v.toFixed(2)), aim: o.aim.map((v) => +v.toFixed(3)), hp: +o.hp.toFixed(2), max_hp: +o.maxHp.toFixed(2), cubes: o.cubes, weapons: o.weapons.filter(Boolean).map((w) => w!.kind), charging: o.weapons.some((w) => w?.charging) })
    }
    for (const n of npcs) if (n.hp > 0 && canSee(m, n.pos[0], n.pos[1], n.pos[2], C.npc.height)) mlist.push({ id: n.id, kind: "npc", pos: n.pos, vel: n.vel, aim: [0, 0], hp: n.hp, max_hp: C.npc.hp })
    const vis = (p: number[], h: number) => canSee(m, p[0], p[1], p[2], h)
    const z = zoneNow()
    const ob: any = {
      type: "obs", tick, t: +t.toFixed(2), alive: aliveCount,
      self: { id: m.id, pos: m.pos.slice(), vel: m.vel.slice(), aim: m.aim.slice(), hp: m.hp, max_hp: m.maxHp, energy: m.energy, max_energy: m.ms.energy, grounded: m.grounded, cubes: m.cubes, upgrades: m.upgrades.slice(), in_zone: inZone(m.pos), weapons: [wObs(m, m.weapons[0]), wObs(m, m.weapons[1])], stats: { ...m.ms, eye_height: m.ms.eye_height * scaleOf(m), muzzle_height: m.ms.muzzle_height * scaleOf(m) } },
      mechs: mlist,
      projectiles: projs.filter((p) => p.owner !== m.id && Math.hypot(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]) < 200).map((p, i) => ({ id: i, kind: p.kind === "npcb" ? "npc" : p.kind, pos: p.pos, vel: p.vel })),
      crates: crates.filter((c) => c.hp > 0 && vis(c.pos, 2.4)).map((c) => ({ id: c.id, pos: c.pos, hp: c.hp })),
      cubes: cubes.filter((c) => vis(c.pos, 1)).map((c) => ({ id: c.id, pos: c.pos })),
      pickups: picks.filter((c) => vis(c.pos, 1)).map((c) => ({ id: c.id, kind: c.kind, pos: c.pos })),
      sounds: m.sounds, beams: m.beams, events: m.events,
      drops: drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: d.pos, radius: C.drops.radius, lands_in: Math.max(0, d.landT - t), capture_s: C.drops.capture_s, progress: d.progress, holder: d.holder })),
      zone: z, offer: m.offer,
    }
    m.sounds = []; m.beams = []; m.events = []
    return ob
  }

  // ---- house AI
  const squad = { mainPos: null as number[] | null, mainT: -99, mainVel: [0, 0, 0] }
  const HC = { noise: [0.1, 0.06, 0.035, 0.018], lead: [0.3, 0.7, 0.9, 1.0], react: [1, 0.7, 0.4, 0.25], engageNear: 30, hunt0: 1, laserRate: 1, ...(JSON.parse(process.env.HOUSE ?? "{}")) }
  const AIM_NOISE = HC.noise, LEAD = HC.lead, REACT = HC.react
  const houseThink = (m: Mech) => {
    const ai = m.ai
    const c = m.ctrl
    c.fire = [false, false]; c.jump = false; c.boost = false; c.reload = false; c.take = undefined; c.drop = undefined
    if (m.offer) c.pick = Math.floor(R() * m.offer.choices.length)
    const z = zoneNow()
    const [x, y, zf] = m.pos
    // take nearby pickups
    for (const p of picks) {
      if (Math.hypot(p.pos[0] - x, p.pos[1] - y) < 3.6 && Math.abs(p.pos[2] - zf) < 3.5 && !m.weapons.some((w) => w?.kind === p.kind) && !m.weapons[1]) { c.take = p.id; break }
    }
    const hunterRank = ai.rank as number
    const houseAlive = mechs.filter((o) => o.alive && o.house).length
    const deadHouse = 15 - houseAlive
    const H = opts.houseAll ? 15 : Math.min(15, HC.hunt0 + deadHouse + (t > 200 ? 2 : 0) + (t > 290 ? 15 : 0))
    const isHunter = hunterRank < H
    const seesMain = main.alive && canSee(m, main.pos[0], main.pos[1], main.pos[2], hOf(main))
    const provoked = t - m.lastAttackT < 12 && m.lastAttacker === main.id
    const engage = main.alive && (isHunter || provoked || (seesMain && Math.hypot(main.pos[0] - x, main.pos[1] - y) < HC.engageNear))
    // goal
    let goal: number[] | null = null
    const zr = Math.max(5, z.next_radius * 0.8)
    const inSafe = (p: number[]) => Math.hypot(p[0] - z.next_center[0], p[1] - z.next_center[1]) < zr
    if (engage && squad.mainPos && t - squad.mainT < 30) goal = squad.mainPos
    else if (engage && isHunter && main.alive) goal = [main.pos[0] + (R() - 0.5) * 40, main.pos[1] + (R() - 0.5) * 40]
    if (!goal) {
      if (!m.weapons[1] && t < 120) {
        let bp: Pick | null = null, bd = 150
        for (const p of picks) { const d = Math.hypot(p.pos[0] - x, p.pos[1] - y); if (d < bd && Math.abs(p.pos[2] - zf) < 3) { bd = d; bp = p } }
        if (bp) goal = bp.pos
      }
      if (!goal) {
        if (!ai.roam || Math.hypot(ai.roam[0] - x, ai.roam[1] - y) < 8 || !inSafe(ai.roam) || t - ai.roamT > 40) {
          const p = randOk(z.next_center[0], z.next_center[1], zr * 0.9, 40)
          ai.roam = p ?? z.next_center; ai.roamT = t
        }
        goal = ai.roam
      }
    }
    // fight
    let mv = [0, 0]
    const tgt = engage && seesMain ? main : null
    if (tgt) {
      if (ai.sawT === undefined || ai.sawT < 0) ai.sawT = t
    } else ai.sawT = -1
    const reacting = tgt && t - ai.sawT >= REACT[m.tier]
    const d = Math.hypot(main.pos[0] - x, main.pos[1] - y)
    if (tgt) {
      const hasLight = m.weapons.some((w) => w?.kind === "lightning")
      const hasLaser = m.weapons.some((w) => w?.kind === "laser")
      const pref = hasLight ? 25 : hasLaser ? 90 : 60
      const toT = Math.atan2(main.pos[1] - y, main.pos[0] - x)
      if (!ai.sw || t > ai.swT) { ai.sw = R() < 0.5 ? -1 : 1; ai.swT = t + 0.5 + R() * 1.2 }
      const radial = d > pref * 1.2 ? 1 : d < pref * 0.6 ? -0.7 : 0
      const strafe = m.tier >= 1 ? 1 : 0.3
      mv = [Math.cos(toT + Math.PI / 2 * ai.sw) * strafe + Math.cos(toT) * radial, Math.sin(toT + Math.PI / 2 * ai.sw) * strafe + Math.sin(toT) * radial]
      if (m.tier >= 2 && m.hp < m.maxHp * 0.25 && d > 30) mv = [-Math.cos(toT), -Math.sin(toT)]
      const ah = nav.cell(x + mv[0] * 3, y + mv[1] * 3)
      if (ah < 0 || !nav.ok[ah]) { ai.sw = -ai.sw; mv = [Math.cos(toT), Math.sin(toT)] }
      c.boost = m.tier >= 2 && m.energy > 50 && R() < 0.3
    } else if (goal) {
      if (!ai.path || t - ai.pathT > 2 || Math.hypot(ai.pg[0] - goal[0], ai.pg[1] - goal[1]) > 10) {
        ai.path = nav.path(x, y, zf, goal[0], goal[1], undefined, 15000); ai.pathT = t; ai.pg = goal.slice(); ai.wp = 0
      }
      const p = ai.path
      if (p && p.length) {
        while (ai.wp < p.length - 1 && Math.hypot(p[ai.wp][0] - x, p[ai.wp][1] - y) < 3) ai.wp++
        mv = [p[ai.wp][0] - x, p[ai.wp][1] - y]
      } else mv = [goal[0] - x, goal[1] - y]
      if (Math.hypot(goal[0] - x, goal[1] - y) < 3) mv = [0, 0]
      if (!inZone(m.pos)) c.boost = m.energy > 10
    }
    // stuck
    const sp = Math.hypot(m.vel[0], m.vel[1])
    if (Math.hypot(mv[0], mv[1]) > 0.1 && sp < 1) ai.stuck = (ai.stuck ?? 0) + 0.1; else ai.stuck = 0
    if (ai.stuck > 0.8) { c.jump = true; ai.jetT = t + 0.7; ai.path = null; ai.stuck = 0 }
    if (ai.jetT > t && !m.grounded) c.boost = true
    c.move = mv
    // aim
    if (tgt) {
      const W0 = m.weapons
      const tz = main.pos[2] + hOf(main) / 2
      const mz = m.pos[2] + m.ms.muzzle_height * scaleOf(m)
      const o = [x, y, mz]
      const ti = intercept(o, [main.pos[0], main.pos[1], tz], main.vel.map((v) => v * LEAD[m.tier]), m.ws.gun.speed) ?? 0
      const ap = [main.pos[0] + main.vel[0] * ti * LEAD[m.tier], main.pos[1] + main.vel[1] * ti * LEAD[m.tier], tz]
      if (!ai.noiseT || t > ai.noiseT) { ai.ny = gauss(R) * AIM_NOISE[m.tier]; ai.np = gauss(R) * AIM_NOISE[m.tier] * 0.5; ai.noiseT = t + 0.4 }
      const yawG = Math.atan2(ap[1] - y, ap[0] - x) + ai.ny
      const pitG = Math.atan2(ap[2] - mz, Math.hypot(ap[0] - x, ap[1] - y)) + ai.np
      const yawL = Math.atan2(main.pos[1] - y, main.pos[0] - x) + ai.ny, pitL = Math.atan2(tz - mz, d) + ai.np
      const laser = W0.findIndex((w) => w?.kind === "laser")
      const charging = laser >= 0 && W0[laser]!.charging
      c.aim = charging && W0[laser]!.charge > 0.4 ? [yawL, pitL] : [yawG, pitG]
      const err = Math.abs(wrap(m.aim[0] - c.aim[0]))
      const los = world.los(x, y, mz, main.pos[0], main.pos[1], tz, 1)
      if (reacting && los) {
        const g = W0.findIndex((w) => w?.kind === "gun")
        if (g >= 0 && err < 0.05 && d < m.ws.gun.range) c.fire[g] = true
        if (laser >= 0) {
          const L = W0[laser]!
          if (!L.charging && L.cooldown <= 0 && d < 270) c.fire[laser] = true
          if (L.charging) c.fire[laser] = !(L.charge >= m.ws.laser.charge && err < 0.03)
        }
        const li = W0.findIndex((w) => w?.kind === "lightning")
        if (li >= 0 && d < 44 && err < 0.4) c.fire[li] = true
        const mo = W0.findIndex((w) => w?.kind === "mortar")
        if (mo >= 0 && d > 30 && d < 220) {
          const pit = ballisticPitch(d, main.pos[2] - (zf + 9.5), m.ws.mortar.speed, m.ws.mortar.gravity, true)
          if (pit !== null && (W0[mo]!.cooldown <= 0)) { c.aim = [yawL, pit + ai.np]; if (Math.abs(m.aim[1] - c.aim[1]) < 0.04 && err < 0.04) c.fire[mo] = true }
        }
      } else if (laser >= 0 && W0[laser]!.charging) c.fire[laser] = W0[laser]!.charge < m.ws.laser.charge + 1.5
    } else {
      // face movement or main's known pos
      if (engage && squad.mainPos) c.aim = [Math.atan2(squad.mainPos[1] - y, squad.mainPos[0] - x), 0]
      else if (Math.hypot(mv[0], mv[1]) > 0.1) c.aim = [Math.atan2(mv[1], mv[0]), 0]
      // npc self-defense
      for (const n of npcs) if (n.hp > 0 && n.target === m.id && Math.hypot(n.pos[0] - x, n.pos[1] - y) < 80) {
        c.aim = [Math.atan2(n.pos[1] - y, n.pos[0] - x), Math.atan2(n.pos[2] + 1.75 - (zf + 7), Math.hypot(n.pos[0] - x, n.pos[1] - y))]
        if (Math.abs(wrap(m.aim[0] - c.aim[0])) < 0.05) c.fire[0] = true
        break
      }
      const g = m.weapons[0]
      if (g && g.kind === "gun" && g.ammo < 6) c.reload = true
    }
  }

  // hunter ranks: weakest first
  {
    const hs = mechs.filter((m) => m.house).sort((a, b) => a.tier - b.tier || a.id - b.id)
    hs.forEach((m, i) => (m.ai.rank = i))
  }

  // ---- main loop
  const totalTicks = C.match.duration_s * C.match.tick_hz
  let mainDecisionMs = 0
  while (tick < totalTicks) {
    if (tick % C.match.decide_every === 0) {
      // squad vision
      if (main.alive) for (const m of mechs) if (m.house && m.alive && canSee(m, main.pos[0], main.pos[1], main.pos[2], hOf(main))) { squad.mainPos = main.pos.slice(); squad.mainT = t; break }
      // offers
      for (const m of mechs) {
        if (!m.alive) continue
        if (m.offer && t >= m.offer.expires) { applyUpg(m, m.offer.choices[0].id); m.offer = null }
        if (!m.offer && m.offerQ > 0) { m.offerQ--; m.offer = offerFor(m) }
      }
      for (const m of mechs) {
        if (!m.alive) continue
        if (m.house) houseThink(m)
        else {
          const ob = buildObs(m)
          const t0 = performance.now()
          let a: any = {}
          try { a = bot.act(ob) ?? {} } catch (e) { if (opts.verbose) console.error(e); a = {} }
          mainDecisionMs = Math.max(mainDecisionMs, performance.now() - t0)
          const c = m.ctrl
          c.move = a.move ?? [0, 0]; c.boost = !!a.boost; c.jump = !!a.jump; c.aim = a.aim ?? c.aim; c.fire = a.fire ?? [false, false]; c.reload = !!a.reload
          c.pick = a.pick; c.take = a.take; c.drop = a.drop
        }
        const c = m.ctrl
        if (c.pick !== undefined && m.offer && m.offer.choices[c.pick]) { applyUpg(m, m.offer.choices[c.pick].id); m.offer = null }
        c.pick = undefined
        if (c.take !== undefined) {
          const pi = picks.findIndex((p) => p.id === c.take)
          const p = picks[pi]
          if (!p) m.events.push({ type: "take_failed", id: c.take, reason: "gone" })
          else if (Math.hypot(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]) > C.loot.pickup_radius || Math.abs(p.pos[2] - m.pos[2]) > 4) m.events.push({ type: "take_failed", id: c.take, reason: "range" })
          else if (m.weapons.some((w) => w?.kind === p.kind)) m.events.push({ type: "take_failed", id: c.take, reason: "have" })
          else {
            let slot = m.weapons[0] === null ? 0 : m.weapons[1] === null ? 1 : -1
            if (slot < 0 && c.drop !== undefined && m.weapons[c.drop] && !m.weapons[c.drop]!.charging) {
              slot = c.drop
              const old = m.weapons[slot]!
              const nid = nextId.pick++
              picks.push({ id: nid, kind: old.kind, pos: m.pos.slice(), wpn: old })
              m.events.push({ type: "dropped", id: nid, kind: old.kind, slot })
            }
            if (slot < 0) m.events.push({ type: "take_failed", id: c.take, reason: "full" })
            else {
              picks.splice(picks.indexOf(p), 1)
              const ws = m.ws[p.kind]
              m.weapons[slot] = p.wpn ? { ...p.wpn, charging: false, charge: 0 } : { kind: p.kind, cooldown: 0, ammo: ws.mag ?? 0, reload: 0, charge: 0, charging: false }
              m.equipUntil[slot] = t + Math.max(C.loot.equip_s, ws.cooldown ?? 0)
              m.events.push({ type: "took", id: p.id, kind: p.kind, slot })
            }
          }
          c.take = undefined; c.drop = undefined
        }
      }
    }
    // physics
    for (const m of mechs) if (m.alive) moveMech(m)
    // separation
    for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
      const a = mechs[i], b = mechs[j]
      if (!a.alive || !b.alive) continue
      const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], d = Math.hypot(dx, dy), md = radOf(a) + radOf(b)
      if (d < md && d > 1e-3 && Math.abs(a.pos[2] - b.pos[2]) < 9) {
        const push = (md - d) / 2
        const na = [a.pos[0] - (dx / d) * push, a.pos[1] - (dy / d) * push], nb = [b.pos[0] + (dx / d) * push, b.pos[1] + (dy / d) * push]
        if (!bodyBlocked(na[0], na[1], a.pos[2], radOf(a), hOf(a), 1.2)) { a.pos[0] = na[0]; a.pos[1] = na[1] }
        if (!bodyBlocked(nb[0], nb[1], b.pos[2], radOf(b), hOf(b), 1.2)) { b.pos[0] = nb[0]; b.pos[1] = nb[1] }
      }
    }
    for (const m of mechs) if (m.alive) fireWeapons(m)
    // projectiles
    for (let i = projs.length - 1; i >= 0; i--) {
      const p = projs[i]
      const o = p.pos
      if (p.kind === "mortar") p.vel[2] -= C.weapons.mortar.gravity * DT
      const step = p.vel.map((v) => v * DT)
      const L = Math.hypot(step[0], step[1], step[2])
      const d = step.map((v) => v / L)
      let maxL = L
      if (p.kind !== "mortar") maxL = Math.min(L, p.range - p.travel)
      const wl = world.rayHit(o[0], o[1], o[2], o[0] + d[0] * maxL, o[1] + d[1] * maxL, o[2] + d[2] * maxL, 0.6)
      const h = rayActors(o, d, wl, p.owner, C.projectile.gun_radius)
      const end = h ? h.s : wl
      const ep = [o[0] + d[0] * end, o[1] + d[1] * end, o[2] + d[2] * end]
      let dead = false
      if (p.kind === "mortar") {
        if (h || wl < maxL - 1e-6) { explode(ep, p.owner, h?.kind === "mech" ? h.ref : null); dead = true }
      } else if (h) {
        if (h.kind === "mech") damageMech(h.ref, p.dmg, p.owner, p.kind === "npcb" ? "npc" : "gun", o)
        else if (h.kind === "npc" && p.kind !== "npcb") damageNpc(h.ref, p.dmg, p.owner)
        else if (h.kind === "crate") damageCrate(h.ref, p.dmg, p.owner)
        dead = true
      } else if (wl < maxL - 1e-6) dead = true
      p.travel += L
      p.ttl -= DT
      if (p.travel >= p.range || p.ttl <= 0) dead = true
      if (dead) projs.splice(i, 1)
      else p.pos = ep
    }
    // npcs
    if (tick % 2 === 0) for (const n of npcs) {
      if (n.hp <= 0) continue
      const dHome = Math.hypot(n.pos[0] - n.home[0], n.pos[1] - n.home[1])
      let tgt = n.target >= 0 ? mechs[n.target] : null
      if (tgt && (!tgt.alive || Math.hypot(tgt.pos[0] - n.pos[0], tgt.pos[1] - n.pos[1]) > C.npc.deaggro_range || dHome > C.npc.chase_leash)) { tgt = null; n.target = -1 }
      if (!tgt && dHome < C.npc.leash) {
        let bd = C.npc.aggro_range
        for (const m of mechs) {
          if (!m.alive) continue
          const d = Math.hypot(m.pos[0] - n.pos[0], m.pos[1] - n.pos[1])
          if (d < bd && world.los(n.pos[0], n.pos[1], n.pos[2] + 3, m.pos[0], m.pos[1], m.pos[2] + 4.5, 1)) { bd = d; tgt = m }
        }
        if (tgt) n.target = tgt.id
      }
      let goal = n.wander
      if (tgt) goal = tgt.pos
      else if (Math.hypot(n.wander[0] - n.pos[0], n.wander[1] - n.pos[1]) < 2 || t > n.wt) { const a = R() * 6.28, r = R() * C.npc.leash; n.wander = [n.home[0] + Math.cos(a) * r, n.home[1] + Math.sin(a) * r, 0]; n.wt = t + 10 }
      const gx = goal[0] - n.pos[0], gy = goal[1] - n.pos[1], gl = Math.hypot(gx, gy)
      if (gl > (tgt ? 15 : 1)) {
        const nx = n.pos[0] + (gx / gl) * C.npc.speed * DT * 2, ny = n.pos[1] + (gy / gl) * C.npc.speed * DT * 2
        const sup = support(nx, ny, n.pos[2], 1.2)
        if (!bodyBlocked(nx, ny, n.pos[2], 1.8, 3.5, 1.2) && sup > n.pos[2] - 3) { n.pos = [nx, ny, sup]; n.vel = [(gx / gl) * C.npc.speed, (gy / gl) * C.npc.speed, 0] }
      } else n.vel = [0, 0, 0]
      n.cool -= DT * 2
      if (tgt && n.cool <= 0) {
        const o = [n.pos[0], n.pos[1], n.pos[2] + 3]
        const tp = [tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5]
        if (world.los(o[0], o[1], o[2], tp[0], tp[1], tp[2], 1)) {
          const ti = intercept(o, tp, tgt.vel, C.npc.projectile_speed) ?? 0
          const ap = [tp[0] + tgt.vel[0] * ti, tp[1] + tgt.vel[1] * ti, tp[2]]
          const sp = (C.npc.spread_deg * Math.PI) / 180
          const yaw = Math.atan2(ap[1] - o[1], ap[0] - o[0]) + gauss(R) * sp, pit = Math.atan2(ap[2] - o[2], Math.hypot(ap[0] - o[0], ap[1] - o[1])) + gauss(R) * sp
          const dd = [Math.cos(pit) * Math.cos(yaw), Math.cos(pit) * Math.sin(yaw), Math.sin(pit)]
          const o2 = [o[0] + dd[0] * 2.2, o[1] + dd[1] * 2.2, o[2] + dd[2] * 2.2]
          projs.push({ kind: "npcb", pos: o2, vel: dd.map((v) => v * C.npc.projectile_speed), owner: n.id, dmg: C.npc.damage, travel: 0, range: 200, ttl: 3 })
          sound("npc_gun", n.pos, -1)
          n.cool = C.npc.cooldown
        }
      }
    }
    // regen, zone
    const z = zoneNow()
    for (const m of mechs) {
      if (!m.alive) continue
      const iz = Math.hypot(m.pos[0] - z.center[0], m.pos[1] - z.center[1]) <= z.radius
      if (!iz) { if (tick % 2 === 0) damageMech(m, z.dps * DT * 2, -1, "zone", m.pos); m.combatT = t }
      else if (t - m.combatT > m.ms.regen_delay && m.hp < m.maxHp) m.hp = Math.min(m.maxHp, m.hp + m.ms.regen_per_s * DT)
    }
    // cubes
    for (let i = cubes.length - 1; i >= 0; i--) {
      const cb = cubes[i]
      let best: Mech | null = null, bd = C.cubes.pickup_radius
      for (const m of mechs) {
        if (!m.alive) continue
        const d = Math.hypot(m.pos[0] - cb.pos[0], m.pos[1] - cb.pos[1])
        if (d <= bd && Math.abs(m.pos[2] - cb.pos[2]) < 4) { bd = d; best = m }
      }
      if (best) { gainCube(best); cubes.splice(i, 1) }
    }
    // drops
    for (const tm of C.drops.times) if (Math.abs(t - tm) < DT / 2) {
      const zz = zoneNow()
      const p = randOk(zz.next_center[0], zz.next_center[1], zz.next_radius * C.drops.spread) ?? [zz.next_center[0], zz.next_center[1], 0]
      drops.push({ id: nextId.drop++, pos: p, callT: t, landT: t + C.drops.fall_s, holder: null, progress: 0, taken: false })
    }
    for (const d of drops) {
      if (d.taken || t < d.landT) continue
      if (Math.abs(t - d.landT) < DT / 2) sound("drop", d.pos, -1)
      const inside = mechs.filter((m) => m.alive && Math.hypot(m.pos[0] - d.pos[0], m.pos[1] - d.pos[1]) < C.drops.radius)
      if (inside.length === 1) {
        if (d.holder !== inside[0].id) { d.holder = inside[0].id; d.progress = 0 }
        d.progress += DT
        if (d.progress >= C.drops.capture_s) {
          const m = inside[0]
          d.taken = true
          gainCube(m, C.drops.cubes)
          m.hp = m.maxHp; m.energy = m.ms.energy
          m.events.push({ type: "drop", id: d.id, cubes: m.cubes })
          say(`drop ${d.id} taken by ${m.id}`)
        }
      } else if (inside.length === 0) { d.holder = null; d.progress = 0 }
    }
    // resolve placements for deaths this tick
    const died = mechs.filter((m) => !m.alive && m.place > 0 && m.deathT === t && m.ai.placed !== true)
    if (died.length) {
      const pl = aliveCount - died.length + 1
      for (const m of died) { m.place = pl; m.ai.placed = true }
      aliveCount -= died.length
    }
    t += DT
    tick++
    if (aliveCount <= 1 || !main.alive) break
  }
  // end: if main alive at timeout rank by hp
  if (main.alive) {
    const alive = mechs.filter((m) => m.alive).sort((a, b) => b.hp - a.hp)
    main.place = alive.indexOf(main) + 1
  }
  const houseDeaths = mechs.filter((m) => m.house && !m.alive).length
  return { seed: opts.seed, place: main.place, score: 16 - main.place, kills: main.kills, t: +t.toFixed(1), houseDeaths, cubes: main.cubes, maxMs: +mainDecisionMs.toFixed(1), st: ST, weapons: main.weapons.filter(Boolean).map((w) => w!.kind), log }
}

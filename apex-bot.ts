import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  log,
  type Action,
  type Config,
  type Hello,
  type ItemObs,
  type Observation,
  type OfferChoice,
  type PickupObs,
  type Vec2,
  type Vec3,
} from "./mechfight.ts";
import type { World } from "./world.ts";
import type { Nav } from "./nav.ts";
import { ballisticPitch, intercept, wrap } from "./geom.ts";

type StrategyProfile = "auto" | "practice_swarm" | "royale_ffa" | "voronoi_ghost";

export interface BotParams {
  profile: StrategyProfile;
  budgetMs: number;

  // Survival & 5s Regen Firewall
  retreatHp: number;
  reengageHp: number;
  restHp: number;
  finishHp: number;
  fearCount: number;
  regenGuardS: number;

  // Voronoi Ghost & Combat Ranges
  minVoronoiClearance: number;
  fightRange: number;
  lightRange: number;
  kiteRange: number;
  hostileRange: number;
  closeRange: number;
  grudgeS: number;

  // Cover, Rooftops & Ring-Rim Body-Blocking
  zoneMargin: number;
  coverSearch: number;
  trees: boolean;
  rimPhaseRadius: number;

  // 10-Cube Snowball Economy
  lootRadius: number;
  crateRadius: number;
  npcFarmRadius: number;
  farmUntil: number;
  targetCubes: number;
  combatHealCubeRange: number;
  cubeCap: number;
  dropRange: number;
  laserScore: number;
  lightScore: number;
  mortarScore: number;

  // Movement & Aim
  strafeMin: number;
  strafeMax: number;
  retreatJink: number;
  aimLead: number;
}

const DEFAULT_P: BotParams = {
  profile: "auto",
  budgetMs: 4.0,

  retreatHp: 0.48,
  reengageHp: 0.85,
  restHp: 0.76,
  finishHp: 250.0,
  fearCount: 2,
  regenGuardS: 2.0,

  minVoronoiClearance: 75.0,
  fightRange: 106.0,
  lightRange: 28.0,
  kiteRange: 64.0,
  hostileRange: 56.0,
  closeRange: 40.0,
  grudgeS: 10.0,

  zoneMargin: 18.0,
  coverSearch: 52.0,
  trees: true,
  rimPhaseRadius: 145.0,

  lootRadius: 185.0,
  crateRadius: 120.0,
  npcFarmRadius: 125.0,
  farmUntil: 225.0,
  targetCubes: 10,
  combatHealCubeRange: 38.0,
  cubeCap: 10,
  dropRange: 420.0,
  laserScore: 5.0,
  lightScore: 2.6,
  mortarScore: 1.9,

  strafeMin: 0.5,
  strafeMax: 1.3,
  retreatJink: 0.65,
  aimLead: 0.9,
};

const UPGRADE_RANK = new Map<string, number>([
  ["nanites", 0],
  ["armor", 1],
  ["plating", 2],
  ["servos", 3],
  ["laser_damage", 4],
  ["laser_charge", 5],
  ["gun_rate", 6],
  ["gun_damage", 7],
  ["lightning_efficiency", 8],
  ["lightning_range", 9],
  ["gyros", 10],
  ["gun_mag", 11],
  ["reactor", 12],
  ["capacitor", 13],
  ["jets", 14],
  ["sensors", 15],
  ["gun_velocity", 16],
  ["lightning_chain", 17],
  ["laser_pierce", 18],
  ["mortar_reload", 19],
  ["mortar_splash", 20],
  ["mortar_velocity", 21],
]);

const TAU = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;
const COS16 = new Float64Array(16);
const SIN16 = new Float64Array(16);
for (let i = 0; i < 16; i++) {
  COS16[i] = Math.cos((i * TAU) / 16);
  SIN16[i] = Math.sin((i * TAU) / 16);
}

interface RooftopEntry {
  id: number;
  cx: number;
  cy: number;
  topZ: number;
  rad: number;
}

interface TrackedMech {
  id: number;
  pos: Vec3;
  vel: Vec3;
  aim: Vec2;
  hp: number;
  maxHp: number;
  weapons: string[];
  charging: boolean;
  seen: number;
  vis: boolean;
  cubes: number;
}

interface TrackedItem {
  id: number;
  pos: Vec3;
  kind?: string;
  seen: number;
}

class SeededRng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
}

const HIDE_MAP = new URL("./arena/v2/hidemap.gz", import.meta.url);
const HIDE_MAP_HEADER_SIZE = 24;
const HIDE_MAP_CELL_SIZE = 3;
const HIDE_MAP_NO_CLASS = 255;
const DEFAULT_EXPOSURE = 8;
const HIDE_MAP_NAV_CELL_METERS = 2;

interface HideMap {
  cells: Buffer;
  width: number;
  height: number;
  metersPerCell: number;
}

function loadHideMap(world: World): HideMap | null {
  let raw: Buffer;
  try {
    raw = gunzipSync(readFileSync(HIDE_MAP));
  } catch {
    return null;
  }
  if (raw.length < HIDE_MAP_HEADER_SIZE || raw.toString("ascii", 0, 4) !== "HM3\n") {
    return null;
  }
  const navWidth = raw.readUInt32LE(4);
  const navHeight = raw.readUInt32LE(8);
  const stride = raw.readUInt32LE(12);
  const width = raw.readUInt32LE(16);
  const height = raw.readUInt32LE(20);
  const metersPerCell = stride * HIDE_MAP_NAV_CELL_METERS;
  const expectedNavWidth = Math.ceil((world.maxX - Math.floor(world.minX)) / HIDE_MAP_NAV_CELL_METERS);
  const expectedNavHeight = Math.ceil((world.maxY - Math.floor(world.minY)) / HIDE_MAP_NAV_CELL_METERS);
  if (
    stride === 0 || width === 0 || height === 0 ||
    navWidth !== expectedNavWidth || navHeight !== expectedNavHeight ||
    width !== Math.ceil(navWidth / stride) || height !== Math.ceil(navHeight / stride) ||
    raw.length !== HIDE_MAP_HEADER_SIZE + width * height * HIDE_MAP_CELL_SIZE
  ) {
    return null;
  }
  return { cells: raw.subarray(HIDE_MAP_HEADER_SIZE), width, height, metersPerCell };
}

class Arena {
  readonly rooftops: RooftopEntry[] = [];
  private readonly hideMap: HideMap | null;
  private readonly hideOriginX: number;
  private readonly hideOriginY: number;
  private readonly world: World;
  private readonly nav: Nav;

  constructor(world: World, nav: Nav) {
    this.world = world;
    this.nav = nav;
    this.hideMap = loadHideMap(world);
    this.hideOriginX = Math.floor(world.minX);
    this.hideOriginY = Math.floor(world.minY);

    let nextRoofId = 1;
    for (const { ring, top: topZ, base: baseZ } of world.prisms) {
      if (ring.length < 6) continue;
      const h = topZ - baseZ;
      if (h < 3.5 || h > 22.0) continue;

      let sx = 0,
        sy = 0,
        minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      const n = ring.length >> 1;
      for (let i = 0; i < ring.length; i += 2) {
        const rx = ring[i];
        const ry = ring[i + 1];
        sx += rx;
        sy += ry;
        if (rx < minX) minX = rx;
        if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry;
        if (ry > maxY) maxY = ry;
      }
      const rad = Math.min(maxX - minX, maxY - minY) * 0.5;
      if (rad >= 4.5) {
        this.rooftops.push({ id: nextRoofId++, cx: sx / n, cy: sy / n, topZ, rad });
      }
    }
  }

  cell(x: number, y: number): number {
    return this.nav.cell(x, y);
  }

  walkable(cell: number): boolean {
    return this.nav.ok[cell] === 1;
  }

  floor(cell: number): number {
    return this.nav.s[cell] ?? 0;
  }

  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.world.los(ax, ay, az, bx, by, bz, 1);
  }

  treeClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.world.treeClear(ax, ay, az, bx, by, bz);
  }

  staticExposure(x: number, y: number): number {
    const map = this.hideMap;
    if (map === null) return DEFAULT_EXPOSURE;
    const column = Math.floor((x - this.hideOriginX) / map.metersPerCell);
    const row = Math.floor((y - this.hideOriginY) / map.metersPerCell);
    if (column < 0 || column >= map.width || row < 0 || row >= map.height) {
      return DEFAULT_EXPOSURE;
    }
    const offset = (row * map.width + column) * HIDE_MAP_CELL_SIZE;
    if (map.cells[offset] === HIDE_MAP_NO_CLASS) return DEFAULT_EXPOSURE;
    // HM3 stores the square root of the visible fraction in the second cell byte.
    const visibility = map.cells[offset + 1] / 255;
    return 16 * visibility * visibility;
  }

  navNextWaypoint(x: number, y: number, z: number, gx: number, gy: number): Vec2 | null {
    const path = this.nav.path(x, y, z, gx, gy, undefined, 6000);
    if (!path?.length) return null;
    return path.find(([wx, wy]) => Math.hypot(wx - x, wy - y) > 2.5) ?? path[path.length - 1];
  }
}

export class Bot {
  static readonly botName = "Apex-ZeroLatency-Hybrid";

  private P: BotParams;
  private noBudget: boolean;
  private tickStart = 0.0;

  private C: Config;
  private rng: SeededRng;
  private meId: number;
  private arena: Arena;

  private tracks = new Map<number, TrackedMech>();
  private npcs = new Map<number, TrackedMech>();
  private pickups = new Map<number, TrackedItem>();
  private crates = new Map<number, TrackedItem>();
  private cubes = new Map<number, TrackedItem>();
  private failedTake = new Map<number, number>();
  private lastAttack = new Map<number, number>();
  private npcAttack = new Map<number, number>();
  private failedRoofs = new Map<number, number>();

  // Preallocated scratch buffers (zero per-tick heap churn)
  private enemiesBuf: TrackedMech[] = [];
  private visibleBuf: TrackedMech[] = [];
  private seeingMeBuf: TrackedMech[] = [];
  private losCache = new Map<number, boolean>();

  private enemyVsEnemyEvents = 0;
  private activeRegime: StrategyProfile;

  private mode = "loot";
  private healing = false;
  private cover: Vec2 | null = null;
  private coverT = -99.0;
  private anchor: Vec2 | null = null;
  private anchorPhase = -1.0;
  private anchorCheckedAt = -99.0;
  private wander: Vec2 | null = null;
  private wanderT = -99.0;

  private strafeDir = 1;
  private strafeUntil = 0.0;
  private retreatJinkDir = 1;
  private retreatJinkUntil = 0.0;
  private stuckT = 0.0;
  private unstickUntil = 0.0;
  private roofClimbAttempts = 0;
  private roofClimbWindowStart = -99.0;
  private lastT = 0.0;
  private lastDamagedT = -99.0;
  private lastTargetId = -1;
  private scanPhase: number;
  private recentDamage: Array<[number, number]> = [];
  private dmgBearings: Array<[number, number]> = [];

  constructor(hello: Hello, world: World, nav: Nav, params?: Partial<BotParams>) {
    this.P = { ...DEFAULT_P, ...(params ?? {}) };
    this.noBudget = Boolean(process.env.MECH_NO_BUDGET);

    this.C = hello.config;
    this.rng = new SeededRng(Number(hello.seed ?? 1) || 1);
    this.meId = Number(hello.slot);
    this.arena = new Arena(world, nav);
    this.activeRegime =
      this.P.profile === "auto" ? "practice_swarm" : this.P.profile;
    this.scanPhase = this.rng.next() * TAU;
  }

  private elapsedMs(): number {
    return performance.now() - this.tickStart;
  }

  private overBudget(reserveMs = 0.0): boolean {
    if (this.noBudget) return false;
    return this.elapsedMs() > this.P.budgetMs - reserveMs;
  }

  private weaponScore(kind?: string): number {
    if (kind === "laser") return this.P.laserScore;
    if (kind === "lightning") return this.P.lightScore;
    if (kind === "mortar") return this.P.mortarScore;
    return 0.0;
  }

  private safeCircle(obs: Observation, eta: number): [Vec2, number] {
    const z = obs.zone;
    const tt = obs.t + eta;
    if (tt <= z.shrink_start) {
      return [[z.center[0], z.center[1]], Number(z.radius)];
    }
    if (tt >= z.shrink_end) {
      return [[z.next_center[0], z.next_center[1]], Number(z.next_radius)];
    }
    const start = Math.max(obs.t, z.shrink_start);
    const f = (tt - start) / Math.max(1e-3, z.shrink_end - start);
    return [
      [
        z.center[0] + (z.next_center[0] - z.center[0]) * f,
        z.center[1] + (z.next_center[1] - z.center[1]) * f,
      ],
      Number(z.radius + (z.next_radius - z.radius) * f),
    ];
  }

  private goalCircle(obs: Observation, x: number, y: number): [Vec2, number] {
    const z = obs.zone;
    const dNext = Math.hypot(x - z.next_center[0], y - z.next_center[1]);
    const walkSpd = obs.self.stats.walk_speed ?? this.C.mech.walk_speed;
    const travel =
      Math.max(0.0, dNext - z.next_radius + this.P.zoneMargin) /
      Math.max(1.0, walkSpd);
    if (obs.t + travel + 20.0 >= z.shrink_start) {
      return [[z.next_center[0], z.next_center[1]], Number(z.next_radius)];
    }
    return [[z.center[0], z.center[1]], Number(z.radius)];
  }

  private inCircle(
    px: number,
    py: number,
    cx: number,
    cy: number,
    radius: number,
    margin: number
  ): boolean {
    const r = Math.max(2.0, radius - margin);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  }

  private clampToCircle(
    px: number,
    py: number,
    cx: number,
    cy: number,
    radius: number,
    margin: number
  ): Vec2 {
    const dx = px - cx;
    const dy = py - cy;
    const d = Math.hypot(dx, dy);
    const r = Math.max(1.0, radius - margin);
    if (d <= r || d < 1e-6) return [px, py];
    return [cx + (dx / d) * r, cy + (dy / d) * r];
  }

  private visibleFrom(
    ex: number,
    ey: number,
    ez: number,
    x: number,
    y: number,
    z: number,
    h: number
  ): boolean {
    // Collision-free 53-bit safe integer key across all 4 coordinates (ex, ey, x, y)
    const qex = (Math.trunc(ex * 0.25) + 4096) & 0x1fff;
    const qey = (Math.trunc(ey * 0.25) + 4096) & 0x1fff;
    const qx = (Math.trunc(x * 0.25) + 4096) & 0x1fff;
    const qy = (Math.trunc(y * 0.25) + 4096) & 0x1fff;
    const key = ((qex * 8192 + qey) * 67108864) + (qx * 8192 + qy);

    const cached = this.losCache.get(key);
    if (cached !== undefined) return cached;

    const tzMid = z + h * 0.5;
    let res =
      this.arena.clear(ex, ey, ez, x, y, tzMid) &&
      (!this.P.trees || this.arena.treeClear(ex, ey, ez, x, y, tzMid));
    if (!res) {
      const tzTop = z + h;
      res =
        this.arena.clear(ex, ey, ez, x, y, tzTop) &&
        (!this.P.trees || this.arena.treeClear(ex, ey, ez, x, y, tzTop));
    }
    this.losCache.set(key, res);
    return res;
  }

  private dpsOf(weapons: string[], d: number, cubesN: number): number {
    let v = 0.0;
    for (let i = 0; i < weapons.length; i++) {
      const w = weapons[i];
      if (w === "gun" && d < 230.0) {
        v += 187.5 * (d < 60.0 ? 0.75 : d < 120.0 ? 0.5 : 0.3);
      } else if (w === "laser" && d < 280.0) {
        v += 145.0;
      } else if (w === "lightning" && d < 45.0) {
        v += 215.0;
      } else if (w === "mortar" && d > 25.0 && d < 230.0) {
        v += 65.0;
      }
    }
    return v * (1.0 + 0.04 * Math.min(10, cubesN));
  }

  private segmentWalkable(
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / 3.5));
    let prevZ = this.arena.floor(this.arena.cell(x0, y0));
    const invSteps = 1.0 / steps;
    for (let s = 1; s <= steps; s++) {
      const f = s * invSteps;
      const n = this.arena.cell(x0 + dx * f, y0 + dy * f);
      if (!this.arena.walkable(n)) return false;
      const fz = this.arena.floor(n);
      if (fz - prevZ > 1.8) return false;
      prevZ = fz;
    }
    return true;
  }

  private steer(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    threats?: TrackedMech[]
  ): Vec2 {
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return [0.0, 0.0];
    const ux = dx / L;
    const uy = dy / L;

    const probeDir = (cx: number, cy: number): [number, number] => {
      let prevS = z;
      let clearSteps = 0;
      for (const r of [2.5, 5.0, 8.5, 13.0]) {
        const px = x + cx * r;
        const py = y + cy * r;
        const n = this.arena.cell(px, py);
        if (!this.arena.walkable(n) || this.arena.floor(n) - prevS > 1.8) break;
        prevS = this.arena.floor(n);
        clearSteps += 1;
      }
      const endX = x + cx * (clearSteps * 3.0);
      const endY = y + cy * (clearSteps * 3.0);
      const expPen = this.arena.staticExposure(endX, endY) * 0.08;
      let threatPen = 0.0;
      if (threats) {
        for (let i = 0; i < threats.length; i++) {
          const e = threats[i];
          const ed = Math.hypot(e.pos[0] - endX, e.pos[1] - endY);
          if (ed < 65.0) threatPen += (65.0 - ed) * 0.06;
        }
      }
      return [clearSteps, expPen + threatPen];
    };

    const [c0, p0] = probeDir(ux, uy);
    if (c0 === 4 && p0 < 0.8) return [ux, uy];

    let bestX = ux;
    let bestY = uy;
    let bs = -Infinity;
    for (let i = 0; i < 16; i++) {
      const cx = COS16[i];
      const cy = SIN16[i];
      const [c, pen] = probeDir(cx, cy);
      if (c === 0) continue;
      const align = cx * ux + cy * uy;
      const sc = c * 1.15 + align * 1.6 - pen;
      if (sc > bs) {
        bs = sc;
        bestX = cx;
        bestY = cy;
      }
    }
    return [bestX, bestY];
  }

  private goTo(
    x: number,
    y: number,
    z: number,
    gx: number,
    gy: number,
    threats?: TrackedMech[]
  ): Vec2 {
    const dist = Math.hypot(gx - x, gy - y);
    if (dist > 55.0) {
      const wp = this.arena.navNextWaypoint(x, y, z, gx, gy);
      if (wp !== null) {
        return this.steer(x, y, z, wp[0] - x, wp[1] - y, threats);
      }
    }
    return this.steer(x, y, z, gx - x, gy - y, threats);
  }

  private findCover(
    obs: Observation,
    threats: TrackedMech[],
    x: number,
    y: number,
    z: number,
    h: number,
    maxR: number
  ): Vec2 | null {
    const [zc, zr] = this.safeCircle(obs, 10.0);
    let t0: TrackedMech | null = null,
      t1: TrackedMech | null = null,
      t2: TrackedMech | null = null;
    let d0 = Infinity,
      d1 = Infinity,
      d2 = Infinity;
    for (let i = 0; i < threats.length; i++) {
      const e = threats[i];
      const d = Math.hypot(e.pos[0] - x, e.pos[1] - y);
      if (d < d0) {
        t2 = t1;
        d2 = d1;
        t1 = t0;
        d1 = d0;
        t0 = e;
        d0 = d;
      } else if (d < d1) {
        t2 = t1;
        d2 = d1;
        t1 = e;
        d1 = d;
      } else if (d < d2) {
        t2 = e;
        d2 = d;
      }
    }
    const maxAllowedExposure = t1 !== null ? 1.0 : 0.0;

    let best: Vec2 | null = null;
    let bs = Infinity;

    for (let rad = 8.0; rad <= maxR; rad += 8.0) {
      if (this.overBudget(1.0)) break;
      for (let a = 0; a < 10; a++) {
        const ang = (a / 10.0) * TAU + rad * 0.37;
        const px = x + Math.cos(ang) * rad;
        const py = y + Math.sin(ang) * rad;
        const cell = this.arena.cell(px, py);
        if (!this.arena.walkable(cell)) continue;
        const pz = this.arena.floor(cell);
        if (Math.abs(pz - z) > 7.0 || !this.inCircle(px, py, zc[0], zc[1], zr, 8.0)) {
          continue;
        }

        const direct = this.segmentWalkable(x, y, px, py);
        if (!direct && rad > 22.0) continue;

        let minThreatDist = Infinity;
        let exposed = 0.0;
        for (const e of [t0, t1, t2]) {
          if (e === null) continue;
          const d = Math.hypot(e.pos[0] - px, e.pos[1] - py);
          if (d < minThreatDist) minThreatDist = d;
          if (this.visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8.0, px, py, pz, h)) {
            exposed += d < 95.0 ? 1.0 : 0.5;
          }
        }
        if (exposed > maxAllowedExposure) continue;

        const staticExp = this.arena.staticExposure(px, py);
        const sc =
          rad -
          Math.min(minThreatDist, 90.0) * 0.3 +
          exposed * 42.0 +
          staticExp * 0.8 +
          (direct ? 0.0 : 8.0);
        if (sc < bs) {
          bs = sc;
          best = [px, py];
        }
      }
      if (best !== null && bs < -6.0) break;
    }
    return best;
  }

  private findZoneAnchor(
    obs: Observation,
    enemies: TrackedMech[],
    t: number
  ): Vec2 | null {
    const [x, y, z] = obs.self.pos;
    const [cx, cy] = obs.zone.next_center;
    const radius = Number(obs.zone.next_radius);
    const mechH = Number(this.C.mech.height);

    const useRim = radius <= this.P.rimPhaseRadius && enemies.length >= 2;
    let antiAngle = 0.0;
    if (useRim) {
      let exAvg = 0.0;
      let eyAvg = 0.0;
      let cnt = 0;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (Math.hypot(e.pos[0] - cx, e.pos[1] - cy) < radius + 140.0) {
          exAvg += e.pos[0];
          eyAvg += e.pos[1];
          cnt++;
        }
      }
      if (cnt > 0) {
        antiAngle = Math.atan2(cy - eyAvg / cnt, cx - exAvg / cnt);
      }
    }

    let best: Vec2 | null = null;
    let bestScore = Infinity;

    for (let i = 0; i < this.arena.rooftops.length; i++) {
      const roof = this.arena.rooftops[i];
      const failUntil = this.failedRoofs.get(roof.id);
      if (failUntil !== undefined && t < failUntil) continue;
      if (Math.hypot(roof.cx - cx, roof.cy - cy) > Math.max(8.0, radius - 10.0)) {
        continue;
      }
      const dMe = Math.hypot(roof.cx - x, roof.cy - y);
      if (dMe > 165.0) continue;
      let score = dMe * 0.14 - 22.0;
      for (let j = 0; j < enemies.length; j++) {
        const e = enemies[j];
        const d = Math.hypot(roof.cx - e.pos[0], roof.cy - e.pos[1]);
        if (
          d < 120.0 &&
          this.visibleFrom(
            e.pos[0],
            e.pos[1],
            e.pos[2] + 8.0,
            roof.cx,
            roof.cy,
            roof.topZ,
            mechH
          )
        ) {
          score += (120.0 - d) * 0.65;
        }
      }
      if (score < bestScore) {
        bestScore = score;
        best = [roof.cx, roof.cy];
      }
    }

    const extent = Math.min(68.0, radius * 0.78);
    const fractions = useRim ? [0.65, 0.82] : [0.0, 0.45, 0.78];
    for (const fraction of fractions) {
      if (this.overBudget(1.0) && best !== null) break;
      const steps = fraction === 0.0 ? 1 : 8;
      for (let i = 0; i < steps; i++) {
        const angle = useRim ? antiAngle + (i - 4) * 0.35 : (i * TAU) / steps;
        const px = cx + Math.cos(angle) * extent * fraction;
        const py = cy + Math.sin(angle) * extent * fraction;
        const cell = this.arena.cell(px, py);
        if (!this.arena.walkable(cell)) continue;
        const floor = this.arena.floor(cell);
        const staticExp = this.arena.staticExposure(px, py);
        const rimBonus = useRim ? -10.0 * Math.cos(angle - antiAngle) : 0.0;
        let score =
          Math.hypot(px - x, py - y) * 0.14 +
          staticExp * 1.15 +
          Math.abs(floor - z) * 0.2 +
          rimBonus;

        for (let j = 0; j < enemies.length; j++) {
          const e = enemies[j];
          const d = Math.hypot(px - e.pos[0], py - e.pos[1]);
          if (
            d < 115.0 &&
            this.visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8.0, px, py, floor, mechH)
          ) {
            score += (115.0 - d) * 0.85;
          }
        }
        if (score < bestScore) {
          bestScore = score;
          best = [px, py];
        }
      }
    }
    return best;
  }

  private sidestepProjectiles(
    obs: Observation,
    movement: Vec2,
    boosting: boolean,
    height: number,
    radius: number
  ): Vec2 {
    if (!obs.self.grounded || obs.projectiles.length === 0) return movement;
    const [x, y, z] = obs.self.pos;
    const stats = obs.self.stats;
    const speed = boosting
      ? (stats.boost_speed ?? this.C.mech.boost_speed)
      : (stats.walk_speed ?? this.C.mech.walk_speed);
    const [vx0, vy0] = obs.self.vel;
    const accel = stats.ground_accel ?? this.C.mech.ground_accel;

    const imminent: Array<[number, number, number, number]> = [];
    const mortarCfg = this.C.weapons.mortar;

    for (let i = 0; i < obs.projectiles.length; i++) {
      const p = obs.projectiles[i];
      const dx = p.pos[0] - x;
      const dy = p.pos[1] - y;
      if (Math.abs(dx) + Math.abs(dy) > 135.0) continue;
      const rvx = p.vel[0] - vx0;
      const rvy = p.vel[1] - vy0;
      const tHit = -(dx * rvx + dy * rvy) / Math.max(1.0, rvx * rvx + rvy * rvy);
      if (tHit < 0.06 || tHit > 0.48) continue;

      const isMortar = p.kind === "mortar";
      const padding = radius + (isMortar ? mortarCfg.splash_radius : 0.75);
      const alt =
        p.pos[2] +
        p.vel[2] * tHit -
        (isMortar ? 0.5 * mortarCfg.gravity * tHit * tHit : 0.0);
      if (alt < z - 1.0 || alt > z + height + (isMortar ? 3.5 : 0.6)) continue;
      if (Math.hypot(dx + rvx * tHit, dy + rvy * tHit) > padding + 5.0) continue;
      imminent.push([
        dx + p.vel[0] * tHit,
        dy + p.vel[1] * tHit,
        tHit,
        padding,
      ]);
    }

    if (imminent.length === 0) return movement;
    const [zc, zr] = this.safeCircle(obs, 1.0);
    const length = Math.hypot(movement[0], movement[1]);
    const baseAngle =
      length > 0.1 ? Math.atan2(movement[1], movement[0]) : obs.self.aim[0];

    let best: Vec2 = movement;
    let lowestCost = Infinity;

    for (const offset of [0.0, -0.6, 0.6, -1.15, 1.15, -1.75, 1.75]) {
      const dirX = Math.cos(baseAngle + offset);
      const dirY = Math.sin(baseAngle + offset);
      const px = x + dirX * 4.0;
      const py = y + dirY * 4.0;
      if (!this.segmentWalkable(x, y, px, py)) continue;

      let danger =
        Math.abs(offset) * 0.7 +
        Math.max(0.0, Math.hypot(px - zc[0], py - zc[1]) - zr) * 1.5;
      const dvx = speed * dirX - vx0;
      const dvy = speed * dirY - vy0;
      const ramp = Math.hypot(dvx, dvy) / Math.max(1.0, accel);

      for (const [ix, iy, tHit, padding] of imminent) {
        const frac =
          ramp < tHit ? tHit - ramp / 2.0 : (tHit * tHit) / (2.0 * ramp);
        const pdx = vx0 * tHit + dvx * frac - ix;
        const pdy = vy0 * tHit + dvy * frac - iy;
        danger += Math.max(0.0, padding - Math.hypot(pdx, pdy)) * 2.4;
      }

      if (danger < lowestCost) {
        lowestCost = danger;
        best = [dirX, dirY];
      }
    }
    return best;
  }

  private pickUpgrade(choices: OfferChoice[]): number {
    let bestIdx = 0;
    let bestRank = 999;
    for (let i = 0; i < choices.length; i++) {
      const rank = UPGRADE_RANK.get(choices[i].id) ?? 100;
      if (rank < bestRank) {
        bestRank = rank;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  act(obs: Observation): Action {
    this.tickStart = performance.now();
    this.losCache.clear();

    const t = Number(obs.t);
    const dt = Math.max(0.05, t - this.lastT);
    this.lastT = t;

    const me = obs.self;
    const [x, y, z] = me.pos;
    const scale = 1.0 + Number(this.C.cubes.size_per_cube) * me.cubes;
    const myH = Number(this.C.mech.height) * scale;
    const myR = Number(this.C.mech.radius) * scale;
    const muzZ = z + (me.stats.muzzle_height ?? 7.0 * scale);
    const hpF = me.hp / Math.max(1.0, me.max_hp);
    const action: Action = { tick: obs.tick };

    // 1. Sensor Update & False-Positive-Free Regime Detection
    for (const tr of this.tracks.values()) tr.vis = false;
    for (const tr of this.npcs.values()) tr.vis = false;

    const zCenter = obs.zone.center;
    const zRad = Number(obs.zone.radius);

    for (let i = 0; i < obs.mechs.length; i++) {
      const m = obs.mechs[i];
      const mid = Number(m.id);
      if (m.kind === "mech") {
        if (mid === this.meId) continue;
        const prev = this.tracks.get(mid);
        const newHp = Number(m.hp ?? 1400.0);
        if (
          prev !== undefined &&
          newHp < prev.hp - 15.0 &&
          t - this.lastDamagedT > 0.5 &&
          this.inCircle(m.pos[0], m.pos[1], zCenter[0], zCenter[1], zRad, 2.0)
        ) {
          this.enemyVsEnemyEvents += 1;
        }
        this.tracks.set(mid, {
          id: mid,
          pos: [m.pos[0], m.pos[1], m.pos[2]],
          vel: [m.vel[0], m.vel[1], m.vel[2]],
          aim: [m.aim[0], m.aim[1]],
          hp: newHp,
          maxHp: Number(m.max_hp ?? 1400.0),
          weapons: m.weapons ?? [],
          charging: Boolean(m.charging ?? false),
          seen: t,
          vis: true,
          cubes: Number(m.cubes ?? 0),
        });
      } else {
        this.npcs.set(mid, {
          id: mid,
          pos: [m.pos[0], m.pos[1], m.pos[2]],
          vel: [m.vel[0], m.vel[1], m.vel[2]],
          aim: [m.aim[0], m.aim[1]],
          hp: Number(m.hp ?? 350.0),
          maxHp: Number(m.max_hp ?? 350.0),
          weapons: [],
          charging: false,
          seen: t,
          vis: true,
          cubes: 0,
        });
      }
    }

    for (const [k, v] of this.tracks) {
      if (t - v.seen > 22.0) this.tracks.delete(k);
    }
    for (const [k, v] of this.npcs) {
      if (t - v.seen > 3.0) this.npcs.delete(k);
    }

    const syncItems = (store: Map<number, TrackedItem>, items: (ItemObs | PickupObs)[]) => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        store.set(Number(it.id), {
          id: Number(it.id),
          pos: [it.pos[0], it.pos[1], it.pos[2]],
          kind: "kind" in it ? it.kind : undefined,
          seen: t,
        });
      }
      for (const [iid, it] of store) {
        if (it.seen === t) continue;
        if (
          Math.hypot(it.pos[0] - x, it.pos[1] - y) < 25.0 &&
          Math.abs(it.pos[2] - z) < 6.0
        ) {
          store.delete(iid);
        } else if (t - it.seen > 90.0) {
          store.delete(iid);
        }
      }
    };

    syncItems(this.pickups, obs.pickups);
    syncItems(this.crates, obs.crates);
    syncItems(this.cubes, obs.cubes);

    for (let i = 0; i < obs.events.length; i++) {
      const ev = obs.events[i];
      if (ev.type === "damaged" && ev.by != null) {
        this.lastDamagedT = t;
        const byId = Number(ev.by);
        if (byId < 16) {
          this.lastAttack.set(byId, t);
          this.recentDamage.push([Number(ev.amount), t]);
        } else {
          this.npcAttack.set(byId, t);
        }
        if (ev.bearing != null) {
          this.dmgBearings.push([Number(ev.bearing), t]);
        }
      } else if (ev.type === "take_failed") {
        this.failedTake.set(Number(ev.id), t);
      } else if (ev.type === "kill") {
        const tid = Number(ev.target);
        if ("by" in ev && typeof ev.by === "number" && ev.by !== this.meId && ev.by < 16) {
          this.enemyVsEnemyEvents += 3;
        }
        this.tracks.delete(tid);
        this.lastAttack.delete(tid);
      }
    }

    this.activeRegime =
      this.P.profile === "auto"
        ? this.enemyVsEnemyEvents >= 3
          ? "royale_ffa"
          : "practice_swarm"
        : this.P.profile;

    while (this.dmgBearings.length > 0 && t - this.dmgBearings[0][1] >= 4.0) {
      this.dmgBearings.shift();
    }
    while (this.recentDamage.length > 0 && t - this.recentDamage[0][1] > 1.2) {
      this.recentDamage.shift();
    }

    // 2. Upgrade Selection
    if (obs.offer) {
      action.pick = this.pickUpgrade(obs.offer.choices);
    }

    // 3. Weapon Inventory & Loot Pickup
    const W = me.weapons;
    const slotOf = (kind: string): number => {
      if (W[0] !== null && W[0].kind === kind) return 0;
      if (W[1] !== null && W[1].kind === kind) return 1;
      return -1;
    };

    const gunS = slotOf("gun");
    const laserS = slotOf("laser");
    const lightS = slotOf("lightning");
    const mortarS = slotOf("mortar");
    const fire: [boolean, boolean] = [false, false];

    const reach = Number(this.C.loot.pickup_radius);
    for (let i = 0; i < obs.pickups.length; i++) {
      const p = obs.pickups[i];
      const pid = Number(p.id);
      if (
        Math.hypot(p.pos[0] - x, p.pos[1] - y) > reach - 0.25 ||
        Math.abs(p.pos[2] - z) > 3.8
      ) {
        continue;
      }
      const failT = this.failedTake.get(pid);
      if (failT !== undefined && t - failT < 2.0) continue;
      if (slotOf(p.kind) >= 0) continue;

      const empty = W[0] === null ? 0 : W[1] === null ? 1 : -1;
      if (empty >= 0) {
        if (p.kind !== "gun") {
          action.take = pid;
          break;
        }
        continue;
      }

      const other = gunS === 0 ? 1 : 0;
      const ow = W[other];
      if (
        ow !== null &&
        this.weaponScore(p.kind) > this.weaponScore(ow.kind) + 0.3 &&
        !(ow.kind === "laser" && (ow.charge ?? 0.0) > 0.0)
      ) {
        action.take = pid;
        action.drop = other;
        break;
      }
    }

    // 4. Regime-Aware Target Selection (Zero-Allocation Scratch Lists)
    const enemies = this.enemiesBuf;
    const visible = this.visibleBuf;
    const seeingMe = this.seeingMeBuf;
    enemies.length = 0;
    visible.length = 0;
    seeingMe.length = 0;

    for (const e of this.tracks.values()) {
      if (t - e.seen < 6.0) {
        enemies.push(e);
        if (e.vis) {
          visible.push(e);
          const d = Math.hypot(e.pos[0] - x, e.pos[1] - y, e.pos[2] - z);
          if (
            d < 140.0 &&
            this.visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8.0, x, y, z, myH)
          ) {
            seeingMe.push(e);
          }
        }
      }
    }

    const myWeapons: string[] = [];
    if (W[0] !== null) myWeapons.push(W[0].kind);
    if (W[1] !== null) myWeapons.push(W[1].kind);

    let target: TrackedMech | null = null;
    let bestTargetScore = Infinity;
    const voronoiAllowed =
      this.activeRegime === "royale_ffa" ||
      this.activeRegime === "voronoi_ghost";

    for (let i = 0; i < visible.length; i++) {
      const e = visible[i];
      const d = Math.hypot(e.pos[0] - x, e.pos[1] - y, e.pos[2] - z);
      const losOk = this.arena.clear(
        x,
        y,
        muzZ,
        e.pos[0],
        e.pos[1],
        e.pos[2] + 4.5
      );
      const toMe = Math.atan2(y - e.pos[1], x - e.pos[0]);
      const facingMe = Math.abs(wrap(e.aim[0] - toMe)) < 0.5;
      const aimedAtMe =
        losOk && d < 220.0 && Math.abs(wrap(e.aim[0] - toMe)) < 0.16;
      const approaching =
        e.vel[0] * Math.cos(toMe) + e.vel[1] * Math.sin(toMe) > 2.5;

      let rv = 200.0;
      if (voronoiAllowed) {
        for (let j = 0; j < enemies.length; j++) {
          const other = enemies[j];
          if (other.id === e.id) continue;
          const nd = Math.hypot(other.pos[0] - e.pos[0], other.pos[1] - e.pos[1]);
          if (nd < rv) rv = nd;
        }
      }

      const grudgeTs = this.lastAttack.get(e.id);
      const isGrudge = grudgeTs !== undefined && t - grudgeTs < this.P.grudgeS;

      const selfDefense =
        isGrudge ||
        d < this.P.closeRange ||
        (facingMe && approaching && d < this.P.hostileRange) ||
        aimedAtMe;

      const swarmCleanFinish =
        this.activeRegime === "practice_swarm" &&
        e.hp < 320.0 &&
        d < 85.0 &&
        losOk &&
        hpF > 0.72 &&
        seeingMe.length <= 1;

      const voronoiHunt =
        voronoiAllowed &&
        rv >= this.P.minVoronoiClearance &&
        hpF > 0.60 &&
        seeingMe.length <= 1 &&
        (e.hp < e.maxHp * 0.72 ||
          (!facingMe && d < 155.0 && W[1] !== null) ||
          (losOk && d < 130.0 && W[1] !== null));

      const safeMortarHarass =
        mortarS >= 0 &&
        !losOk &&
        d > 28.0 &&
        d < 220.0 &&
        hpF > 0.62 &&
        seeingMe.length === 0;

      if (
        !selfDefense &&
        !swarmCleanFinish &&
        !voronoiHunt &&
        !safeMortarHarass
      ) {
        continue;
      }

      const ability = Math.max(
        40.0,
        this.dpsOf(myWeapons, d, Number(me.cubes))
      );
      const ttk = e.hp / ability;
      const voronoiBonus = voronoiAllowed ? Math.min(4.5, rv / 35.0) : 0.0;
      let score =
        ttk +
        d / 55.0 -
        voronoiBonus +
        (losOk ? 0.0 : mortarS >= 0 ? 1.2 : 5.0);
      if (isGrudge) score -= 2.0;
      if (e.id === this.lastTargetId) score -= 0.7;

      if (score < bestTargetScore) {
        bestTargetScore = score;
        target = e;
      }
    }

    this.lastTargetId = target !== null ? target.id : -1;

    // 5. Mode State Machine
    let incomingDps = 0.0;
    for (let i = 0; i < visible.length; i++) {
      const e = visible[i];
      const gTs = this.lastAttack.get(e.id);
      if ((gTs !== undefined && t - gTs < this.P.grudgeS) || seeingMe.includes(e)) {
        const d = Math.hypot(e.pos[0] - x, e.pos[1] - y, e.pos[2] - z);
        incomingDps += this.dpsOf(e.weapons, d, e.cubes);
      }
    }

    const myArmor = me.stats.armor ?? 0.0;
    let obsDmgSum = 0.0;
    for (let i = 0; i < this.recentDamage.length; i++) {
      obsDmgSum += this.recentDamage[i][0];
    }
    const observedDps = obsDmgSum / 1.2;
    const ttdMe =
      me.hp / Math.max(1.0, incomingDps * (1.0 - myArmor), observedDps);

    const targetDist =
      target !== null
        ? Math.hypot(target.pos[0] - x, target.pos[1] - y, target.pos[2] - z)
        : Infinity;
    const ttkTarget =
      target !== null
        ? target.hp /
          Math.max(1.0, this.dpsOf(myWeapons, targetDist, Number(me.cubes)))
        : Infinity;
    const winningDuel = target !== null && ttkTarget < ttdMe * 0.65;

    const outnumbered = seeingMe.length >= this.P.fearCount && !winningDuel;
    const lowHp = hpF < this.P.retreatHp && !winningDuel;
    let laserDisadvantage = false;
    if (laserS < 0 && lightS < 0) {
      for (let i = 0; i < seeingMe.length; i++) {
        const e = seeingMe[i];
        const d = Math.hypot(e.pos[0] - x, e.pos[1] - y, e.pos[2] - z);
        if (e.weapons.includes("laser") && e.hp > 280.0 && d > 48.0 && d < 275.0) {
          laserDisadvantage = true;
          break;
        }
      }
    }

    if (
      this.healing &&
      (hpF >= this.P.reengageHp || (enemies.length === 0 && hpF > 0.78))
    ) {
      this.healing = false;
    }
    if (
      (lowHp || outnumbered || (observedDps > 170.0 && hpF < 0.76)) &&
      enemies.length > 0
    ) {
      this.healing = true;
    }
    if (this.healing && winningDuel && hpF > 0.52 && !outnumbered) {
      this.healing = false;
    }

    const canFinish =
      target !== null &&
      target.hp < this.P.finishHp &&
      targetDist < 115.0 &&
      hpF > 0.18 &&
      ttdMe > Math.max(1.3, ttkTarget * 1.7) &&
      seeingMe.length < 3;

    if ((this.healing || laserDisadvantage) && !canFinish) {
      this.mode = "retreat";
    } else if (target !== null) {
      this.mode = "fight";
    } else {
      this.mode = "loot";
    }

    let npcAngry = false;
    for (const ts of this.npcAttack.values()) {
      if (t - ts < 4.0) {
        npcAngry = true;
        break;
      }
    }
    const [zc10, zr10] = this.safeCircle(obs, 10.0);
    if (
      this.mode === "loot" &&
      !npcAngry &&
      t - this.lastDamagedT > 1.5 &&
      hpF < this.P.restHp &&
      seeingMe.length === 0 &&
      this.inCircle(x, y, zc10[0], zc10[1], zr10, this.P.zoneMargin * 0.5)
    ) {
      this.mode = "rest";
    }

    const [zc8, zr8] = this.safeCircle(obs, 8.0);
    const outsideNextBy = Math.hypot(x - zc8[0], y - zc8[1]) - zr8;
    const finalDist = Math.hypot(
      x - obs.zone.next_center[0],
      y - obs.zone.next_center[1]
    );
    const walkSpd = me.stats.walk_speed ?? this.C.mech.walk_speed;
    const headingToFinal =
      obs.zone.next_radius === 0 &&
      t + (finalDist / Math.max(1.0, walkSpd)) * 1.3 + 8.0 >=
        obs.zone.shrink_start;

    if (
      !me.in_zone ||
      headingToFinal ||
      (outsideNextBy > 0.0 &&
        (t > 260.0 || outsideNextBy * obs.zone.dps > me.hp * 2.0))
    ) {
      this.mode = "zone";
    }

    // 6. Movement, 10-Cube Snowball & Rooftop/Rim Positioning
    let mv: Vec2 = [0.0, 0.0];
    let boost = false;
    let jump = false;
    let wantFace: number | null = null;

    const [gc, gr] = this.goalCircle(obs, x, y);
    const [sc, sr] = this.safeCircle(obs, 5.0);

    if (this.mode === "retreat") {
      const threats = enemies.length > 0 ? enemies : visible;
      const alreadyHidden =
        seeingMe.length === 0 &&
        this.inCircle(x, y, sc[0], sc[1], sr, 6.0) &&
        threats.every(
          (e) =>
            !this.visibleFrom(
              e.pos[0],
              e.pos[1],
              e.pos[2] + 8.0,
              x,
              y,
              z,
              myH
            )
        );

      if (alreadyHidden) {
        this.cover = [x, y];
        this.coverT = t;
      } else if (
        !this.cover ||
        t - this.coverT > 1.75 ||
        (t - this.lastDamagedT < 0.35 &&
          Math.hypot(this.cover[0] - x, this.cover[1] - y) < 2.0)
      ) {
        this.cover = this.findCover(
          obs,
          threats,
          x,
          y,
          z,
          myH,
          this.P.coverSearch
        );
        this.coverT = t;
      }

      let nearest: TrackedMech | null = null;
      let nearestD = Infinity;
      for (let i = 0; i < threats.length; i++) {
        const e = threats[i];
        const d = Math.hypot(e.pos[0] - x, e.pos[1] - y);
        if (d < nearestD) {
          nearestD = d;
          nearest = e;
        }
      }

      if (this.cover) {
        const d = Math.hypot(this.cover[0] - x, this.cover[1] - y);
        if (d > 1.5) {
          mv = this.goTo(x, y, z, this.cover[0], this.cover[1], threats);
        }
        boost = d > 4.0 && me.energy > 15.0;
      } else {
        let ax = 0.0;
        let ay = 0.0;
        for (let i = 0; i < threats.length; i++) {
          const e = threats[i];
          const d = Math.max(5.0, Math.hypot(e.pos[0] - x, e.pos[1] - y));
          const w =
            (this.lastAttack.has(e.id) ? 1.4 : 0.8) * Math.min(2.0, 70.0 / d);
          ax += ((x - e.pos[0]) / d) * w;
          ay += ((y - e.pos[1]) / d) * w;
        }
        const escapePt = this.clampToCircle(
          x + ax * 35.0,
          y + ay * 35.0,
          sc[0],
          sc[1],
          sr,
          this.P.zoneMargin
        );
        mv = this.goTo(x, y, z, escapePt[0], escapePt[1], threats);
        boost = me.energy > 15.0;
      }

      if (nearest !== null) {
        wantFace = Math.atan2(nearest.pos[1] - y, nearest.pos[0] - x);
        if (seeingMe.length > 0 || t - this.lastDamagedT < 0.5) {
          if (t > this.retreatJinkUntil) {
            this.retreatJinkDir = this.rng.next() < 0.5 ? -1 : 1;
            this.retreatJinkUntil =
              t +
              this.P.strafeMin +
              this.rng.next() * (this.P.strafeMax - this.P.strafeMin);
          }
          const ml = Math.hypot(mv[0], mv[1]);
          const perp = wantFace + HALF_PI * this.retreatJinkDir;
          const jx = Math.cos(perp) * this.P.retreatJink;
          const jy = Math.sin(perp) * this.P.retreatJink;
          mv =
            ml < 0.1
              ? [jx, jy]
              : this.steer(x, y, z, mv[0] / ml + jx, mv[1] / ml + jy, threats);
        }
      }
    } else if (this.mode === "fight" && target !== null) {
      const d = Math.hypot(target.pos[0] - x, target.pos[1] - y);
      const toT = Math.atan2(target.pos[1] - y, target.pos[0] - x);
      const targetHasLight = target.weapons.includes("lightning");
      const targetHasLaser = target.weapons.includes("laser");
      const lightRangeCfg = Number(this.C.weapons.lightning.range);

      let pref =
        lightS >= 0 && me.energy > 20.0 ? this.P.lightRange : this.P.fightRange;
      if (targetHasLight && !(lightS >= 0 && me.energy > 25.0)) {
        pref = Math.max(pref, this.P.kiteRange);
      }
      if (lightS >= 0 && laserS < 0 && targetHasLaser && me.energy > 18.0) {
        pref = lightRangeCfg * 0.65;
      }

      if (t > this.strafeUntil) {
        this.strafeDir = this.rng.next() < 0.5 ? -1 : 1;
        this.strafeUntil =
          t +
          this.P.strafeMin +
          this.rng.next() * (this.P.strafeMax - this.P.strafeMin);
      }

      const losT = this.arena.clear(
        x,
        y,
        muzZ,
        target.pos[0],
        target.pos[1],
        target.pos[2] + 4.5
      );
      if (!losT && mortarS >= 0 && d > 28.0 && d < 220.0) {
        mv = [0.0, 0.0];
      } else if (!losT && d > 15.0) {
        mv = this.goTo(x, y, z, target.pos[0], target.pos[1], visible);
      } else {
        let radial = Math.max(-2.5, Math.min(1.0, (d - pref) / 18.0));
        if (targetHasLight && lightS < 0 && d < lightRangeCfg + 8.0) {
          radial = -2.8;
        }
        const perp = toT + HALF_PI * this.strafeDir;
        mv = [
          Math.cos(perp) + Math.cos(toT) * radial,
          Math.sin(perp) + Math.sin(toT) * radial,
        ];

        for (let i = 0; i < visible.length; i++) {
          const e = visible[i];
          if (e.id === target.id) continue;
          const dd = Math.hypot(e.pos[0] - x, e.pos[1] - y);
          if (dd > 1.0 && dd < 95.0) {
            const w = ((95.0 - dd) / 95.0) * 2.2;
            mv[0] += ((x - e.pos[0]) / dd) * w;
            mv[1] += ((y - e.pos[1]) / dd) * w;
          }
        }
        mv = this.steer(x, y, z, mv[0], mv[1], visible);
      }

      if (!this.inCircle(x, y, sc[0], sc[1], sr, this.P.zoneMargin * 0.5)) {
        mv = [sc[0] - x, sc[1] - y];
      }

      boost =
        me.energy > 22.0 &&
        ((targetHasLight && lightS < 0 && d < this.P.kiteRange) ||
          (lightS >= 0 && targetHasLaser && d > lightRangeCfg * 0.8));
    } else if (this.mode === "rest") {
      if (enemies.length > 0) {
        if (!this.cover || t - this.coverT > 1.8) {
          this.cover = this.findCover(
            obs,
            enemies,
            x,
            y,
            z,
            myH,
            this.P.coverSearch
          );
          this.coverT = t;
        }
        if (
          this.cover &&
          Math.hypot(this.cover[0] - x, this.cover[1] - y) > 1.5
        ) {
          mv = this.goTo(x, y, z, this.cover[0], this.cover[1], enemies);
        }
        let latest = enemies[0];
        for (let i = 1; i < enemies.length; i++) {
          if (enemies[i].seen > latest.seen) latest = enemies[i];
        }
        wantFace = Math.atan2(latest.pos[1] - y, latest.pos[0] - x);
      }
    } else if (this.mode === "zone") {
      const g: Vec2 =
        obs.zone.next_radius === 0
          ? [obs.zone.next_center[0], obs.zone.next_center[1]]
          : this.clampToCircle(
              x,
              y,
              gc[0],
              gc[1],
              gr,
              Math.min(this.P.zoneMargin, gr * 0.3)
            );
      mv = this.goTo(x, y, z, g[0], g[1], visible);
      boost = me.energy > 12.0 && (!headingToFinal || finalDist > 8.0);
    } else if (this.mode === "loot") {
      let goal: Vec2 | null = null;
      let bestGoalScore = Infinity;
      let targetCrate: TrackedItem | null = null;
      let targetNpc: TrackedMech | null = null;

      const consider = (
        px: number,
        py: number,
        val: number,
        crate: TrackedItem | null = null,
        npc: TrackedMech | null = null
      ) => {
        if (!this.inCircle(px, py, gc[0], gc[1], gr, this.P.zoneMargin * 0.5)) {
          return;
        }
        const d = Math.hypot(px - x, py - y);
        const s = d / val;
        if (s < bestGoalScore) {
          bestGoalScore = s;
          goal = [px, py];
          targetCrate = crate;
          targetNpc = npc;
        }
      };

      const haveSecond = W[0] !== null && W[1] !== null;

      if (me.cubes < this.P.cubeCap) {
        for (const c of this.cubes.values()) {
          if (Math.abs(c.pos[2] - z) < 5.0) {
            consider(c.pos[0], c.pos[1], hpF < 0.85 ? 9.0 : 7.2);
          }
        }
      }

      if (
        t < this.P.farmUntil &&
        me.cubes < this.P.targetCubes &&
        hpF > 0.55 &&
        seeingMe.length <= 1
      ) {
        for (const c of this.crates.values()) {
          if (
            t - c.seen > 1.5 ||
            Math.abs(c.pos[2] - z) > 5.0 ||
            Math.hypot(c.pos[0] - x, c.pos[1] - y) > this.P.crateRadius
          ) {
            continue;
          }
          if (
            enemies.some(
              (e) => Math.hypot(e.pos[0] - c.pos[0], e.pos[1] - c.pos[1]) < 45.0
            )
          ) {
            continue;
          }
          consider(c.pos[0], c.pos[1], 5.0, c, null);
        }
        for (const n of this.npcs.values()) {
          if (!n.vis || Math.hypot(n.pos[0] - x, n.pos[1] - y) > this.P.npcFarmRadius) {
            continue;
          }
          if (
            enemies.some(
              (e) => Math.hypot(e.pos[0] - n.pos[0], e.pos[1] - n.pos[1]) < 50.0
            )
          ) {
            continue;
          }
          consider(n.pos[0], n.pos[1], 5.6, null, n);
        }
      }

      for (const p of this.pickups.values()) {
        const failT = this.failedTake.get(p.id);
        if (failT !== undefined && t - failT < 5.0) continue;
        if (p.kind && slotOf(p.kind) >= 0) continue;
        const d = Math.hypot(p.pos[0] - x, p.pos[1] - y);
        if (d > this.P.lootRadius || Math.abs(p.pos[2] - z) > 4.0) continue;

        let v = haveSecond ? 0.0 : 3.0 + this.weaponScore(p.kind);
        if (haveSecond) {
          const other = gunS === 0 ? 1 : 0;
          const ow = W[other];
          if (
            this.weaponScore(p.kind) >
            this.weaponScore(ow?.kind) + 0.3
          ) {
            v = 2.2;
          }
        }
        if (v > 0.0) consider(p.pos[0], p.pos[1], v);
      }

      for (const dr of obs.drops ?? []) {
        if (dr.holder !== null && dr.holder !== this.meId) continue;
        const dd = Math.hypot(dr.pos[0] - x, dr.pos[1] - y);
        if (dd > this.P.dropRange) continue;
        const travel = dd / Math.max(1.0, walkSpd);
        if (dr.lands_in > travel + 6.0) continue;
        const [dc, drad] = this.safeCircle(
          obs,
          Math.max(travel, dr.lands_in) + dr.capture_s + 2.0
        );
        if (!this.inCircle(dr.pos[0], dr.pos[1], dc[0], dc[1], drad, 6.0)) {
          continue;
        }
        if (
          enemies.some(
            (e) =>
              Math.hypot(e.pos[0] - dr.pos[0], e.pos[1] - dr.pos[1]) < 45.0
          )
        ) {
          continue;
        }
        consider(dr.pos[0], dr.pos[1], hpF < 0.8 ? 7.8 : 6.0);
      }

      let usingAnchor = false;
      if (
        goal === null &&
        obs.zone.next_radius > 0 &&
        obs.zone.next_radius <= 380
      ) {
        const threatened =
          this.anchor !== null &&
          enemies.some(
            (e) =>
              Math.hypot(
                e.pos[0] - this.anchor![0],
                e.pos[1] - this.anchor![1]
              ) < 60.0
          );
        if (
          obs.zone.shrink_end !== this.anchorPhase ||
          t - this.anchorCheckedAt > (threatened ? 2.5 : 9.0)
        ) {
          this.anchor = this.findZoneAnchor(obs, enemies, t);
          this.anchorPhase = Number(obs.zone.shrink_end);
          this.anchorCheckedAt = t;
        }
        if (this.anchor !== null) {
          goal = this.anchor;
          usingAnchor = true;
        }
      }

      if (goal === null) {
        if (
          !this.wander ||
          t - this.wanderT > 14.0 ||
          Math.hypot(this.wander[0] - x, this.wander[1] - y) < 6.0 ||
          !this.inCircle(
            this.wander[0],
            this.wander[1],
            gc[0],
            gc[1],
            gr,
            this.P.zoneMargin
          )
        ) {
          let bestW: Vec2 | null = null;
          let bestScore = -Infinity;
          for (let i = 0; i < 16; i++) {
            const a = this.rng.next() * TAU;
            const rr =
              Math.sqrt(this.rng.next()) *
              Math.max(5.0, gr - this.P.zoneMargin);
            const px = gc[0] + Math.cos(a) * rr;
            const py = gc[1] + Math.sin(a) * rr;
            const cell = this.arena.cell(px, py);
            if (!this.arena.walkable(cell)) continue;
            let minEnemyDist = 220.0;
            for (let j = 0; j < enemies.length; j++) {
              const ed = Math.hypot(
                enemies[j].pos[0] - px,
                enemies[j].pos[1] - py
              );
              if (ed < minEnemyDist) minEnemyDist = ed;
            }
            const sc2 =
              minEnemyDist * 1.5 -
              this.arena.staticExposure(px, py) * 1.2 +
              this.rng.next() * 10.0;
            if (sc2 > bestScore) {
              bestScore = sc2;
              bestW = [px, py];
            }
          }
          if (bestW !== null) this.wander = bestW;
          this.wanderT = t;
        }
        goal = this.wander;
      }

      if (goal !== null) {
        mv = this.goTo(x, y, z, goal[0], goal[1], visible);
        const stopDist = targetCrate ? 8.0 : targetNpc ? 22.0 : 1.5;
        const dg = Math.hypot(goal[0] - x, goal[1] - y);
        if (dg < stopDist) {
          mv = [0.0, 0.0];
        } else if ((targetCrate || targetNpc) && me.energy > 35.0 && dg > 18.0) {
          boost = true;
        }
      }

      for (let i = 0; i < visible.length; i++) {
        const e = visible[i];
        const d = Math.hypot(e.pos[0] - x, e.pos[1] - y);
        if (d > 1.0 && d < 75.0) {
          const w = ((75.0 - d) / 75.0) * 1.9;
          const ml0 = Math.hypot(mv[0], mv[1]) || 1.0;
          mv = this.steer(
            x,
            y,
            z,
            mv[0] / ml0 + ((x - e.pos[0]) / d) * w,
            mv[1] / ml0 + ((y - e.pos[1]) / d) * w,
            visible
          );
        }
      }

      if (
        usingAnchor &&
        this.anchor !== null &&
        me.grounded &&
        seeingMe.length === 0 &&
        t - this.lastDamagedT > 2.0 &&
        Math.hypot(this.anchor[0] - x, this.anchor[1] - y) < 3.0 &&
        this.inCircle(x, y, sc[0], sc[1], sr, 5.0)
      ) {
        this.mode = "hide";
        mv = [0.0, 0.0];
      }

      if (
        this.mode === "loot" &&
        gunS >= 0 &&
        (targetCrate !== null || targetNpc !== null)
      ) {
        const objPos = targetCrate ? targetCrate.pos : targetNpc!.pos;
        const objH = targetCrate ? 1.2 : 1.75;
        const tx = objPos[0];
        const ty = objPos[1];
        const tz = objPos[2] + objH;
        const dObj = Math.hypot(tx - x, ty - y);
        if (this.arena.clear(x, y, muzZ, tx, ty, tz)) {
          wantFace = Math.atan2(ty - y, tx - x);
          const g = W[gunS];
          if (
            g !== null &&
            Math.abs(wrap(me.aim[0] - wantFace)) < 0.08 &&
            (g.ammo ?? 1) > 0 &&
            (g.reload ?? 0.0) <= 0.0 &&
            dObj < 85.0
          ) {
            fire[gunS] = true;
          }
        }
      }
    }

    // 6b. In-Combat Cube Healing Vacuum
    if (
      (this.mode === "fight" || this.mode === "retreat") &&
      me.in_zone &&
      me.cubes < this.P.cubeCap &&
      seeingMe.length < 2
    ) {
      let nearestCube: TrackedItem | null = null;
      let bestCubeDist = this.P.combatHealCubeRange;
      for (const c of this.cubes.values()) {
        if (
          Math.abs(c.pos[2] - z) > 4.5 ||
          !this.inCircle(c.pos[0], c.pos[1], sc[0], sc[1], sr, 6.0)
        ) {
          continue;
        }
        const d = Math.hypot(c.pos[0] - x, c.pos[1] - y);
        if (
          d < bestCubeDist &&
          this.segmentWalkable(x, y, c.pos[0], c.pos[1])
        ) {
          bestCubeDist = d;
          nearestCube = c;
        }
      }
      if (nearestCube !== null) {
        mv = [nearestCube.pos[0] - x, nearestCube.pos[1] - y];
        if (me.energy > 30.0) boost = true;
      }
    }

    // 7. Universal Charging-Laser LOS Break & Projectile Sidestep
    const chargingLasers = visible.filter(
      (e) =>
        e.charging &&
        Math.abs(wrap(e.aim[0] - Math.atan2(y - e.pos[1], x - e.pos[0]))) <
          0.25 &&
        this.visibleFrom(e.pos[0], e.pos[1], e.pos[2] + 8.0, x, y, z, myH)
    );
    if (chargingLasers.length > 0 && !this.overBudget(0.6)) {
      const reachD = me.energy > 15.0 ? 9.0 : 5.5;
      let bestDodge: Vec2 | null = null;
      let bestDev = Infinity;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12.0) * TAU;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const st = this.steer(x, y, z, ca, sa);
        if (Math.abs(st[0] - ca) > 0.01 || Math.abs(st[1] - sa) > 0.01) {
          continue;
        }
        const px = x + ca * reachD;
        const py = y + sa * reachD;
        if (
          chargingLasers.every(
            (e) =>
              !this.visibleFrom(
                e.pos[0],
                e.pos[1],
                e.pos[2] + 8.0,
                px,
                py,
                z,
                myH
              )
          )
        ) {
          const dev = Math.abs(wrap(a - Math.atan2(mv[1], mv[0])));
          if (dev < bestDev) {
            bestDev = dev;
            bestDodge = [ca, sa];
          }
        }
      }
      if (bestDodge !== null) {
        mv = bestDodge;
        boost = me.energy > 6.0;
      }
    }

    if (this.mode === "fight" || this.mode === "retreat") {
      mv = this.sidestepProjectiles(obs, mv, boost, myH, myR);
    }

    // 8. Obstacle & Rooftop Jump-Jet Unsticking (with 20s Unreachable-Roof Blacklist)
    const spd = Math.hypot(me.vel[0], me.vel[1]);
    if (Math.hypot(mv[0], mv[1]) > 0.1 && spd < 1.5 && me.grounded) {
      this.stuckT += dt;
    } else {
      this.stuckT = Math.max(0.0, this.stuckT - dt);
    }

    let targetRoof: RooftopEntry | null = null;
    if (
      (this.mode === "loot" || this.mode === "hide") &&
      this.anchor !== null &&
      Math.hypot(this.anchor[0] - x, this.anchor[1] - y) < 16.0
    ) {
      for (let i = 0; i < this.arena.rooftops.length; i++) {
        const r = this.arena.rooftops[i];
        if (
          Math.hypot(r.cx - this.anchor[0], r.cy - this.anchor[1]) < 2.0 &&
          r.topZ > z + 2.0
        ) {
          targetRoof = r;
          break;
        }
      }
    }

    if (this.stuckT > 0.65 || targetRoof !== null) {
      if (targetRoof !== null && t >= this.unstickUntil) {
        if (t - this.roofClimbWindowStart > 6.0) {
          this.roofClimbWindowStart = t;
          this.roofClimbAttempts = 1;
        } else {
          this.roofClimbAttempts += 1;
          if (this.roofClimbAttempts >= 3) {
            this.failedRoofs.set(targetRoof.id, t + 20.0);
            this.anchor = null;
            this.anchorPhase = -1.0;
            this.roofClimbAttempts = 0;
          }
        }
      }
      this.unstickUntil = t + 0.85;
      this.stuckT = 0.0;
      this.strafeDir = -this.strafeDir;
    }
    if (t < this.unstickUntil) {
      jump = Boolean(me.grounded);
      boost = !me.grounded && me.energy > 8.0;
    }

    // 9. Aiming, Regen-Timer Firewall & Firing
    let aimYaw = Number(me.aim[0]);
    let aimPitch = 0.0;

    let fireTarget = target;
    if (fireTarget === null && this.mode === "retreat") {
      let bestRetreatD = Infinity;
      for (let i = 0; i < visible.length; i++) {
        const e = visible[i];
        if (
          this.arena.clear(x, y, muzZ, e.pos[0], e.pos[1], e.pos[2] + 4.5)
        ) {
          const d = Math.hypot(e.pos[0] - x, e.pos[1] - y, e.pos[2] - z);
          if (d < bestRetreatD) {
            bestRetreatD = d;
            fireTarget = e;
          }
        }
      }
    }

    if (
      fireTarget !== null &&
      (this.mode === "fight" ||
        this.mode === "retreat" ||
        this.mode === "zone")
    ) {
      const tScale =
        1.0 + Number(this.C.cubes.size_per_cube) * fireTarget.cubes;
      const tp: Vec3 = [
        fireTarget.pos[0],
        fireTarget.pos[1],
        fireTarget.pos[2] + Number(this.C.mech.height) * 0.5 * tScale,
      ];
      const tv = fireTarget.vel;
      const d3 = Math.hypot(tp[0] - x, tp[1] - y, tp[2] - muzZ);
      const losT = this.arena.clear(x, y, muzZ, tp[0], tp[1], tp[2]);

      const protectRegen =
        hpF < 0.78 &&
        t - this.lastDamagedT > this.P.regenGuardS &&
        fireTarget.hp > 220.0 &&
        d3 > 52.0;

      let usedMortar = false;
      if (
        mortarS >= 0 &&
        (!losT || d3 > 45.0) &&
        d3 > 25.0 &&
        d3 < 230.0 &&
        W[mortarS]!.cooldown <= 0.15
      ) {
        const ms = W[mortarS]!.stats;
        const launchZ = z + myH + 0.5;
        const targetZ = fireTarget.pos[2] + (losT ? 2.0 : 0.5);
        let tof =
          Math.hypot(fireTarget.pos[0] - x, fireTarget.pos[1] - y) /
          (ms.speed * 0.7);
        let px = fireTarget.pos[0];
        let py = fireTarget.pos[1];
        let pit: number | null = null;

        for (let iter = 0; iter < 3; iter++) {
          px = fireTarget.pos[0] + tv[0] * tof;
          py = fireTarget.pos[1] + tv[1] * tof;
          const dhp = Math.hypot(px - x, py - y);
          pit = ballisticPitch(
            dhp,
            targetZ - launchZ,
            ms.speed,
            ms.gravity,
            losT
          );
          if (pit === null) break;
          tof = dhp / (Math.cos(pit) * ms.speed);
        }

        const launchYaw = Math.atan2(py - y, px - x);
        const muzzleClear =
          pit !== null &&
          this.arena.clear(
            x,
            y,
            launchZ,
            x + Math.cos(launchYaw) * 12.0,
            y + Math.sin(launchYaw) * 12.0,
            launchZ + Math.tan(pit) * 12.0
          );
        if (pit !== null && pit < this.C.mech.max_pitch && muzzleClear) {
          aimYaw = launchYaw;
          aimPitch = pit;
          usedMortar = true;
          if (
            Math.abs(wrap(me.aim[0] - aimYaw)) < 0.035 &&
            Math.abs(wrap(me.aim[1] - aimPitch)) < 0.035
          ) {
            fire[mortarS] = true;
          }
        }
      }

      if (!usedMortar) {
        let aimPt: Vec3 = tp;
        if (gunS >= 0) {
          const ti = intercept(
            [x, y, muzZ],
            tp,
            [tv[0] * this.P.aimLead, tv[1] * this.P.aimLead, tv[2] * 0.3],
            W[gunS]!.stats.speed
          );
          if (ti !== null) {
            aimPt = [
              tp[0] + tv[0] * ti * this.P.aimLead,
              tp[1] + tv[1] * ti * this.P.aimLead,
              tp[2] + tv[2] * 0.3 * ti,
            ];
          }
        }

        aimYaw = Math.atan2(aimPt[1] - y, aimPt[0] - x);
        aimPitch = Math.atan2(
          aimPt[2] - muzZ,
          Math.hypot(aimPt[0] - x, aimPt[1] - y)
        );

        const tol = Math.max(0.01, 2.2 / Math.max(1.0, d3));
        if (
          gunS >= 0 &&
          !protectRegen &&
          losT &&
          d3 < W[gunS]!.stats.range &&
          Math.abs(wrap(me.aim[0] - aimYaw)) < tol * 1.2 &&
          Math.abs(wrap(me.aim[1] - aimPitch)) < tol
        ) {
          const g = W[gunS]!;
          if ((g.ammo ?? 1) > 0 && (g.reload ?? 0.0) <= 0.0) {
            fire[gunS] = true;
          }
        }

        if (laserS >= 0) {
          const L = W[laserS]!;
          const ls = L.stats;
          const chg = L.charge ?? 0.0;
          const dyaw = Math.atan2(tp[1] - y, tp[0] - x);
          const dp = Math.atan2(
            tp[2] - muzZ,
            Math.hypot(tp[0] - x, tp[1] - y)
          );
          const ltol = Math.max(0.008, 1.8 / Math.max(1.0, d3));
          const aimed =
            losT &&
            d3 < ls.range &&
            Math.abs(wrap(me.aim[0] - dyaw)) < ltol &&
            Math.abs(wrap(me.aim[1] - dp)) < ltol * 1.4;

          if (chg > 0.0) {
            const cubeMult =
              1.0 +
              Number(this.C.cubes.damage_per_cube) *
                Math.min(me.cubes, Number(this.C.cubes.stat_cap));
            const cookoffMult = fireTarget.weapons.includes("mortar")
              ? 1.0 + (ls.cookoff ?? 0.6)
              : 1.0;
            const fullDmg = ls.damage * cubeMult * cookoffMult;
            const neededCharge =
              ((fireTarget.hp / Math.max(1.0, fullDmg) - ls.min_frac) /
                (1.0 - ls.min_frac)) *
              ls.charge;
            const releaseAt =
              neededCharge < ls.charge * 0.85
                ? Math.min(
                    ls.charge,
                    Math.max(
                      ls.min_charge,
                      neededCharge * 1.15,
                      ls.charge * 0.45
                    )
                  )
                : ls.charge;
            const readyToRelease = chg >= releaseAt - 0.02 && aimed;
            const aboutToAutoFire = chg > ls.charge + ls.hold_s - 0.25;
            fire[laserS] = !(readyToRelease || aboutToAutoFire);
            aimYaw = dyaw;
            aimPitch = dp;
          } else if (
            L.cooldown <= 0.1 &&
            !protectRegen &&
            losT &&
            d3 < ls.range &&
            !(
              fireTarget.weapons.includes("lightning") &&
              d3 < this.C.weapons.lightning.range + 8.0
            )
          ) {
            fire[laserS] = true;
          }
        }

        if (lightS >= 0) {
          const ls = W[lightS]!.stats;
          const dyaw = Math.atan2(tp[1] - y, tp[0] - x);
          if (
            losT &&
            d3 < ls.range * 0.95 &&
            Math.abs(wrap(me.aim[0] - dyaw)) <
              ((ls.cone_deg * Math.PI) / 180.0) * 0.7 &&
            me.energy >= ls.energy &&
            W[lightS]!.cooldown <= 0.1
          ) {
            fire[lightS] = true;
          }
        }
      }
    } else {
      if (wantFace !== null) {
        aimYaw = wantFace;
      } else if (this.dmgBearings.length > 0) {
        aimYaw = this.dmgBearings[this.dmgBearings.length - 1][0];
      } else {
        let loudBearing: number | null = null;
        for (let i = 0; i < obs.sounds.length; i++) {
          const s = obs.sounds[i];
          if (s.kind !== "step" && s.kind !== "death" && s.kind !== "drop") {
            loudBearing = Number(s.bearing);
            break;
          }
        }
        if (loudBearing !== null) {
          aimYaw = loudBearing;
        } else {
          this.scanPhase += dt * 1.35;
          const base =
            Math.hypot(mv[0], mv[1]) > 0.1
              ? Math.atan2(mv[1], mv[0])
              : Number(me.aim[0]);
          aimYaw = base + Math.sin(this.scanPhase) * 1.35;
        }
      }

      if (
        gunS >= 0 &&
        seeingMe.length === 0 &&
        t - this.lastDamagedT > 1.5
      ) {
        const g = W[gunS]!;
        if (
          (g.ammo ?? 12) <= Math.trunc(g.stats.mag * 0.4) &&
          (g.reload ?? 0.0) <= 0.0
        ) {
          action.reload = true;
        }
      }

      if (laserS >= 0 && (W[laserS]!.charge ?? 0.0) > 0.0) {
        fire[laserS] = false;
      }
    }

    // 10. Finalize Action Output
    const ml = Math.hypot(mv[0], mv[1]);
    action.move = ml > 1e-6 ? [mv[0] / ml, mv[1] / ml] : [0.0, 0.0];
    action.boost = boost;
    action.jump = jump;
    action.aim = [
      wrap(aimYaw),
      Math.max(
        Number(this.C.mech.min_pitch),
        Math.min(Number(this.C.mech.max_pitch), aimPitch)
      ),
    ];
    action.fire = fire;

    if (!this.noBudget && obs.tick % 20 === 0) {
      log(
        `${this.activeRegime}:${this.mode} | hp:${Math.round(me.hp)} | c:${me.cubes} | ${this.elapsedMs().toFixed(2)}ms`
      );
    }
    return action;
  }
}

export type BotHandler = ((obs: Observation) => Action) & {
  act: (obs: Observation) => Action;
  instance: Bot;
};

export function makeBot(
  hello: Hello,
  world: World,
  nav: Nav,
  params?: Partial<BotParams>
): BotHandler {
  const bot = new Bot(hello, world, nav, params);
  const handler = ((obs: Observation) => bot.act(obs)) as BotHandler;
  handler.act = (obs: Observation) => bot.act(obs);
  handler.instance = bot;
  return handler;
}

export default makeBot;

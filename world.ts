// Static world model: terrain heightfield + rasterized prisms on a 1 m grid.
import { readFileSync } from "node:fs"
import { join } from "node:path"

export type V3 = [number, number, number]

function pointInRing(x: number, y: number, r: number[]): boolean {
  let inside = false
  const n = r.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export class World {
  // terrain vertex grid
  tMinX: number
  tMinY: number
  tnx: number
  tny: number
  terr: Float32Array
  // 1 m cell grid aligned with terrain vertices: cell (i,j) covers [tMinX+i, tMinX+i+1)
  nx: number
  ny: number
  // up to 3 intervals per cell; NaN = none
  b0: Float32Array
  t0: Float32Array
  b1: Float32Array
  t1: Float32Array
  b2: Float32Array
  t2: Float32Array
  gc: Float32Array // ground at cell center
  surf: Float32Array // walking surface height at cell center (ground or low-clearance roof top)
  maxTop: Float32Array // highest solid top in cell (or ground)
  minX: number
  maxX: number
  minY: number
  maxY: number
  trees: { x: number; y: number; z: number; h: number; cr: number; cb: number; tr: number; cx: number; cy: number }[] = []

  constructor(dir: string) {
    const w = JSON.parse(readFileSync(join(dir, "v2/world.json"), "utf8"))
    const t = w.terrain
    this.tMinX = t.minX
    this.tMinY = t.minY
    this.tnx = t.nx
    this.tny = t.ny
    const buf = readFileSync(join(dir, "v2/" + (t.file ?? "terrain.i16")))
    const n = t.nx * t.ny
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, Math.min(n, Math.floor(buf.byteLength / 2)))
    this.terr = new Float32Array(n)
    const sc = t.scale ?? 0.01
    for (let k = 0; k < i16.length; k++) this.terr[k] = i16[k] * sc
    this.minX = w.bounds.minX
    this.maxX = w.bounds.maxX
    this.minY = w.bounds.minY
    this.maxY = w.bounds.maxY
    this.nx = t.nx - 1
    this.ny = t.ny - 1
    const N = this.nx * this.ny
    const mk = () => new Float32Array(N).fill(NaN)
    this.b0 = mk(); this.t0 = mk(); this.b1 = mk(); this.t1 = mk(); this.b2 = mk(); this.t2 = mk()
    this.gc = new Float32Array(N)
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) this.gc[j * this.nx + i] = this.ground(this.tMinX + i + 0.5, this.tMinY + j + 0.5)
    for (const p of w.prisms) this.addPrism(p)
    this.surf = new Float32Array(N)
    this.maxTop = new Float32Array(N)
    for (let k = 0; k < N; k++) {
      const g = this.gc[k]
      let s = g
      let mt = g
      const B = [this.b0[k], this.b1[k], this.b2[k]], T = [this.t0[k], this.t1[k], this.t2[k]]
      // walking surface: lowest solid top that we cannot pass under starting from ground
      // iterate: if an interval's base < s + 9 (head) and top > s, we stand on its top
      for (let pass = 0; pass < 3; pass++)
        for (let q = 0; q < 3; q++) {
          if (!(T[q] === T[q])) continue
          if (T[q] > mt) mt = T[q]
          if (T[q] > s && B[q] < s + 9) s = T[q]
        }
      this.surf[k] = s
      this.maxTop[k] = mt
    }
    if (w.rules?.canopyDensity != null) this.canopyDensity = w.rules.canopyDensity
    if (w.rules?.canopyBlockT != null) this.canopyBlockT = w.rules.canopyBlockT
    const tr = w.trees
    if (tr && tr.fields && tr.data) {
      const f = tr.fields as string[]
      const L = f.length
      const ix = (nm: string) => f.indexOf(nm)
      const [X, Y, Z, H, CR, CB, TR, CX, CY] = ["x", "y", "z", "height", "crownR", "crownBase", "trunkR", "crownX", "crownY"].map(ix)
      for (let k = 0; k + L <= tr.data.length; k += L) {
        const d = tr.data
        this.trees.push({ x: d[k + X], y: d[k + Y], z: d[k + Z], h: d[k + H], cr: d[k + CR], cb: d[k + CB], tr: d[k + TR], cx: CX >= 0 ? d[k + CX] : d[k + X], cy: CY >= 0 ? d[k + CY] : d[k + Y] })
      }
    }
  }

  private addPrism(p: { base: number; top: number; ring: number[]; holes: number[][] }) {
    const r = p.ring
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let k = 0; k < r.length; k += 2) {
      x0 = Math.min(x0, r[k]); x1 = Math.max(x1, r[k]); y0 = Math.min(y0, r[k + 1]); y1 = Math.max(y1, r[k + 1])
    }
    const i0 = Math.max(0, Math.floor(x0 - this.tMinX)), i1 = Math.min(this.nx - 1, Math.floor(x1 - this.tMinX))
    const j0 = Math.max(0, Math.floor(y0 - this.tMinY)), j1 = Math.min(this.ny - 1, Math.floor(y1 - this.tMinY))
    const holes = (p.holes ?? []).filter((h) => h && h.length >= 6)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cx = this.tMinX + i + 0.5, cy = this.tMinY + j + 0.5
        if (!pointInRing(cx, cy, r)) continue
        if (holes.some((h) => pointInRing(cx, cy, h))) continue
        const k = j * this.nx + i
        this.insert(k, p.base, p.top)
      }
  }

  private insert(k: number, b: number, t: number) {
    if (!(this.b0[k] === this.b0[k])) { this.b0[k] = b; this.t0[k] = t; return }
    // merge overlapping into slot 0 if possible
    if (b <= this.t0[k] && t >= this.b0[k]) { this.b0[k] = Math.min(b, this.b0[k]); this.t0[k] = Math.max(t, this.t0[k]); return }
    if (!(this.b1[k] === this.b1[k])) { this.b1[k] = b; this.t1[k] = t; return }
    if (b <= this.t1[k] && t >= this.b1[k]) { this.b1[k] = Math.min(b, this.b1[k]); this.t1[k] = Math.max(t, this.t1[k]); return }
    if (!(this.b2[k] === this.b2[k])) { this.b2[k] = b; this.t2[k] = t; return }
    this.b2[k] = Math.min(b, this.b2[k]); this.t2[k] = Math.max(t, this.t2[k])
  }

  ground(x: number, y: number): number {
    let fx = x - this.tMinX, fy = y - this.tMinY
    if (fx < 0) fx = 0
    if (fy < 0) fy = 0
    if (fx > this.tnx - 1.001) fx = this.tnx - 1.001
    if (fy > this.tny - 1.001) fy = this.tny - 1.001
    const i = Math.floor(fx), j = Math.floor(fy)
    const ax = fx - i, ay = fy - j
    const k = j * this.tnx + i
    const a = this.terr[k], b = this.terr[k + 1], c = this.terr[k + this.tnx], d = this.terr[k + this.tnx + 1]
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay
  }

  cellOf(x: number, y: number): number {
    const i = Math.floor(x - this.tMinX), j = Math.floor(y - this.tMinY)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1
    return j * this.nx + i
  }

  /** walking surface height near (x,y) given current feet z (pick the surface under/at z) */
  surfaceAt(x: number, y: number): number {
    const k = this.cellOf(x, y)
    if (k < 0) return this.ground(x, y)
    const s = this.surf[k]
    // if surf is the ground use bilinear ground
    return s === this.gc[k] ? this.ground(x, y) : s
  }

  solidCell(k: number, z: number): boolean {
    if (z < this.gc[k]) return true
    const b0 = this.b0[k]
    if (b0 === b0 && z >= b0 && z <= this.t0[k]) return true
    const b1 = this.b1[k]
    if (b1 === b1 && z >= b1 && z <= this.t1[k]) return true
    const b2 = this.b2[k]
    if (b2 === b2 && z >= b2 && z <= this.t2[k]) return true
    return false
  }

  solid(x: number, y: number, z: number): boolean {
    const k = this.cellOf(x, y)
    if (k < 0) return true
    if (this.gc[k] === this.surf[k] && this.maxTop[k] === this.gc[k]) return z < this.ground(x, y)
    return this.solidCell(k, z)
  }

  /** true if segment a->b is free of terrain/buildings (trees ignored). step in meters. */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 0.7): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (L < 1e-6) return true
    const n = Math.ceil(L / step)
    const sx = dx / n, sy = dy / n, sz = dz / n
    let x = ax, y = ay, z = az
    for (let s = 1; s < n; s++) {
      x += sx; y += sy; z += sz
      const k = this.cellOf(x, y)
      if (k < 0) return false
      if (z > this.maxTop[k] + 0.01 && z > this.gc[k] + 3) continue
      if (this.solid(x, y, z)) return false
    }
    return true
  }

  // ---- tree vision (protocol §8 + track viewer): trunks block sight, crowns attenuate it.
  // transmittance = exp(-canopyDensity * metres of crown crossed); visible if >= canopyBlockT. Shots ignore trees.
  canopyDensity = 0.35
  canopyBlockT = 0.25
  private treeGrid: Int32Array[] | null = null
  private treeStamp: Uint32Array | null = null
  private stampN = 0
  private tg = { minX: 0, minY: 0, nx: 0, ny: 0, cs: 8 }
  private tc: Float64Array | null = null // per tree: cx, cy, cz, cr, rz, x, y, z0, top, tr

  private buildTreeGrid() {
    const n = this.trees.length, cs = this.tg.cs
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const tc = new Float64Array(n * 10)
    for (let i = 0; i < n; i++) {
      const t = this.trees[i]
      const cz = t.z + (t.cb + t.h) / 2, rz = Math.max((t.h - t.cb) / 2, 0.5), top = t.z + Math.max(t.cb + 0.5 * (t.h - t.cb), 3)
      tc.set([t.cx, t.cy, cz, t.cr, rz, t.x, t.y, t.z - 1, top, t.tr], i * 10)
      minX = Math.min(minX, t.cx - t.cr, t.x - t.tr); minY = Math.min(minY, t.cy - t.cr, t.y - t.tr)
      maxX = Math.max(maxX, t.cx + t.cr, t.x + t.tr); maxY = Math.max(maxY, t.cy + t.cr, t.y + t.tr)
    }
    const nx = Math.max(1, Math.ceil((maxX - minX) / cs) + 1), ny = Math.max(1, Math.ceil((maxY - minY) / cs) + 1)
    const cells: number[][] = Array.from({ length: nx * ny }, () => [])
    for (let i = 0; i < n; i++) {
      const t = this.trees[i]
      const x0 = Math.floor((Math.min(t.cx - t.cr, t.x - t.tr) - minX) / cs), x1 = Math.floor((Math.max(t.cx + t.cr, t.x + t.tr) - minX) / cs)
      const y0 = Math.floor((Math.min(t.cy - t.cr, t.y - t.tr) - minY) / cs), y1 = Math.floor((Math.max(t.cy + t.cr, t.y + t.tr) - minY) / cs)
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) cells[gy * nx + gx].push(i)
    }
    this.tg = { minX, minY, nx, ny, cs }
    this.treeGrid = cells.map((c) => Int32Array.from(c))
    this.treeStamp = new Uint32Array(n)
    this.tc = tc
  }

  /** true if trees do not block sight along a->b (buildings not checked: combine with los()). */
  treeClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    if (!this.trees.length) return true
    if (!this.treeGrid) this.buildTreeGrid()
    const { minX, minY, nx, ny, cs } = this.tg
    const tc = this.tc!, stamp = this.treeStamp!, grid = this.treeGrid!
    const s = ++this.stampN
    const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const maxCrown = Math.log(1 / this.canopyBlockT) / this.canopyDensity
    let crown = 0
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (cs * 0.5)))
    for (let k = 0; k <= steps; k++) {
      const f = k / steps
      const gx = Math.floor((ax + dx * f - minX) / cs), gy = Math.floor((ay + dy * f - minY) / cs)
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const cx = gx + ox, cy = gy + oy
        if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) continue
        const cell = cy * nx + cx
        const list = grid[cell]
        for (let j = 0; j < list.length; j++) {
          const i = list[j]
          if (stamp[i] === s) continue
          stamp[i] = s
          const o = i * 10
          // trunk: vertical cylinder
          const tx = tc[o + 5] - ax, ty = tc[o + 6] - ay, d2 = dx * dx + dy * dy
          const ft = d2 > 0 ? Math.max(0, Math.min(1, (tx * dx + ty * dy) / d2)) : 0
          const qx = dx * ft - tx, qy = dy * ft - ty, tr = tc[o + 9]
          if (qx * qx + qy * qy < tr * tr) { const zz = az + dz * ft; if (zz > tc[o + 7] && zz < tc[o + 8]) return false }
          // crown: ellipsoid
          const cr = tc[o + 3], rz = tc[o + 4]
          const sx = (ax - tc[o]) / cr, sy = (ay - tc[o + 1]) / cr, sz = (az - tc[o + 2]) / rz
          const ux = dx / cr, uy = dy / cr, uz = dz / rz
          const A = ux * ux + uy * uy + uz * uz, B = 2 * (sx * ux + sy * uy + sz * uz), Cc = sx * sx + sy * sy + sz * sz - 1
          const disc = B * B - 4 * A * Cc
          if (disc > 0 && A > 0) {
            const q = Math.sqrt(disc), t0 = Math.max(0, (-B - q) / (2 * A)), t1 = Math.min(1, (-B + q) / (2 * A))
            if (t1 > t0) { crown += (t1 - t0) * L; if (crown > maxCrown) return false }
          }
        }
      }
    }
    return true
  }

  /** distance along segment until first solid hit, or L if clear */
  rayHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, step = 0.7): number {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (L < 1e-6) return 0
    const n = Math.ceil(L / step)
    const sx = dx / n, sy = dy / n, sz = dz / n
    let x = ax, y = ay, z = az
    for (let s = 1; s <= n; s++) {
      x += sx; y += sy; z += sz
      const k = this.cellOf(x, y)
      if (k < 0) return (s / n) * L
      if (z > this.maxTop[k] + 0.01 && z > this.gc[k] + 3) continue
      if (this.solid(x, y, z)) return (s / n) * L
    }
    return L
  }

  inBounds(x: number, y: number, margin = 3): boolean {
    return x > this.minX + margin && x < this.maxX - margin && y > this.minY + margin && y < this.maxY - margin
  }
}

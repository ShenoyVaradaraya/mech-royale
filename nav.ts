// 2 m navigation grid with A* over the walking surface.
import { World } from "./world.ts"

const CS = 2

export class Nav {
  w: World
  nx: number
  ny: number
  ox: number
  oy: number
  s: Float32Array // surface height at nav cell center
  ok: Uint8Array // standable
  // A* scratch
  private g: Float32Array
  private came: Int32Array
  private stamp: Uint32Array
  private closed: Uint32Array
  private gen = 1
  private heap: Int32Array
  private hf: Float32Array

  constructor(w: World) {
    this.w = w
    this.ox = w.tMinX
    this.oy = w.tMinY
    this.nx = Math.floor(w.nx / CS)
    this.ny = Math.floor(w.ny / CS)
    const N = this.nx * this.ny
    // max filter of 1 m surface, radius 3 cells
    const R = 3
    const W = w.nx, H = w.ny
    const tmp = new Float32Array(W * H)
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        let m = -1e9
        for (let d = -R; d <= R; d++) {
          const ii = i + d
          if (ii < 0 || ii >= W) { m = 1e9; continue }
          const v = w.surf[j * W + ii]
          if (v > m) m = v
        }
        tmp[j * W + i] = m
      }
    const mf = new Float32Array(W * H)
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        let m = -1e9
        for (let d = -R; d <= R; d++) {
          const jj = j + d
          if (jj < 0 || jj >= H) { m = 1e9; continue }
          const v = tmp[jj * W + i]
          if (v > m) m = v
        }
        mf[j * W + i] = m
      }
    this.s = new Float32Array(N)
    this.ok = new Uint8Array(N)
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        const ci = i * CS + 1, cj = j * CS + 1
        const k1 = cj * W + ci
        const x = this.ox + ci, y = this.oy + cj
        const sv = w.surf[k1] === w.gc[k1] ? w.ground(x, y) : w.surf[k1]
        const k = j * this.nx + i
        this.s[k] = sv
        const inb = w.inBounds(x, y, 4)
        this.ok[k] = inb && mf[k1] - sv <= 1.6 ? 1 : 0
      }
    this.g = new Float32Array(N)
    this.came = new Int32Array(N)
    this.stamp = new Uint32Array(N)
    this.closed = new Uint32Array(N)
    this.heap = new Int32Array(N + 8)
    this.hf = new Float32Array(N)
  }

  cell(x: number, y: number): number {
    const i = Math.floor((x - this.ox) / CS), j = Math.floor((y - this.oy) / CS)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1
    return j * this.nx + i
  }
  cx(k: number) { return this.ox + (k % this.nx) * CS + 1 }
  cy(k: number) { return this.oy + Math.floor(k / this.nx) * CS + 1 }

  /** nearest standable cell to (x,y), searching rings up to r cells; prefers surface near z if given */
  nearestOk(x: number, y: number, r = 12, z?: number): number {
    const c = this.cell(x, y)
    if (c >= 0 && this.ok[c] && (z === undefined || Math.abs(this.s[c] - z) < 3)) return c
    const i0 = Math.floor((x - this.ox) / CS), j0 = Math.floor((y - this.oy) / CS)
    let best = -1, bd = Infinity
    for (let rr = 1; rr <= r; rr++) {
      for (let dj = -rr; dj <= rr; dj++)
        for (let di = -rr; di <= rr; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== rr) continue
          const i = i0 + di, j = j0 + dj
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue
          const k = j * this.nx + i
          if (!this.ok[k]) continue
          let d = di * di + dj * dj
          if (z !== undefined) d += Math.abs(this.s[k] - z) > 3 ? 50 : 0
          if (d < bd) { bd = d; best = k }
        }
      if (best >= 0 && rr * rr > bd) break
    }
    return best
  }

  /**
   * A* from (sx,sy) to (tx,ty). cost(k) returns extra per-cell cost multiplier >= 0 (optional).
   * Returns list of [x,y] waypoints (cell centers) or null. maxExpand bounds work.
   */
  path(sx: number, sy: number, sz: number, tx: number, ty: number, cost?: (k: number) => number, maxExpand = 60000): [number, number][] | null {
    const s = this.nearestOk(sx, sy, 6, sz)
    const t = this.nearestOk(tx, ty, 15)
    if (s < 0 || t < 0) return null
    const gen = ++this.gen
    const nx = this.nx
    const tI = t % nx, tJ = Math.floor(t / nx)
    const h = (k: number) => {
      const di = Math.abs((k % nx) - tI), dj = Math.abs(Math.floor(k / nx) - tJ)
      return (Math.max(di, dj) + 0.4142 * Math.min(di, dj)) * CS
    }
    let hn = 0
    const heap = this.heap, hf = this.hf
    const push = (k: number, f: number) => {
      hf[k] = f
      let i = hn++
      heap[i] = k
      while (i > 0) {
        const p = (i - 1) >> 1
        if (hf[heap[p]] <= f) break
        heap[i] = heap[p]
        i = p
      }
      heap[i] = k
    }
    const pop = () => {
      const top = heap[0]
      const last = heap[--hn]
      let i = 0
      const f = hf[last]
      for (;;) {
        let c = 2 * i + 1
        if (c >= hn) break
        if (c + 1 < hn && hf[heap[c + 1]] < hf[heap[c]]) c++
        if (hf[heap[c]] >= f) break
        heap[i] = heap[c]
        i = c
      }
      heap[i] = last
      return top
    }
    this.g[s] = 0
    this.stamp[s] = gen
    this.came[s] = -1
    push(s, h(s))
    let expand = 0
    let found = false
    let bestK = s, bestH = h(s)
    const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    while (hn > 0) {
      const k = pop()
      if (this.closed[k] === gen) continue
      this.closed[k] = gen
      if (k === t) { found = true; break }
      const hk = h(k)
      if (hk < bestH) { bestH = hk; bestK = k }
      if (++expand > maxExpand) break
      const ki = k % nx, kj = Math.floor(k / nx)
      const sk = this.s[k]
      for (let d = 0; d < 8; d++) {
        const ii = ki + DI[d], jj = kj + DJ[d]
        if (ii < 0 || jj < 0 || ii >= nx || jj >= this.ny) continue
        const n = jj * nx + ii
        if (!this.ok[n] || this.closed[n] === gen) continue
        const diag = d >= 4
        const rise = this.s[n] - sk
        if (rise > (diag ? 2.0 : 1.6)) continue
        if (diag && (!this.ok[kj * nx + ii] || !this.ok[jj * nx + ki])) continue
        let c = diag ? CS * 1.4142 : CS
        if (rise < -3) c += 2 // dropping is fine but mildly discouraged
        if (cost) c *= 1 + cost(n)
        const ng = this.g[k] + c
        if (this.stamp[n] !== gen || ng < this.g[n]) {
          this.stamp[n] = gen
          this.g[n] = ng
          this.came[n] = k
          push(n, ng + h(n))
        }
      }
    }
    const end = found ? t : bestK
    const out: [number, number][] = []
    let k = end
    let guard = 0
    while (k >= 0 && guard++ < 100000) {
      out.push([this.cx(k), this.cy(k)])
      if (k === s) break
      k = this.came[k]
    }
    out.reverse()
    if (found) out.push([tx, ty])
    return this.smooth(out, sz)
  }

  /** drop waypoints we can walk straight past (cheap string pulling on standable cells) */
  smooth(p: [number, number][], _z: number): [number, number][] {
    if (p.length <= 2) return p
    const out: [number, number][] = [p[0]]
    let a = 0
    while (a < p.length - 1) {
      let b = Math.min(p.length - 1, a + 12)
      for (; b > a + 1; b--) if (this.walkable(p[a][0], p[a][1], p[b][0], p[b][1])) break
      out.push(p[b])
      a = b
    }
    return out
  }

  walkable(ax: number, ay: number, bx: number, by: number): boolean {
    const L = Math.hypot(bx - ax, by - ay)
    const n = Math.ceil(L / 1.0)
    let prev = this.cell(ax, ay)
    if (prev < 0) return false
    for (let i = 1; i <= n; i++) {
      const k = this.cell(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n)
      if (k < 0 || !this.ok[k]) return false
      if (k !== prev) {
        if (this.s[k] - this.s[prev] > 1.6) return false
        prev = k
      }
    }
    return true
  }
}

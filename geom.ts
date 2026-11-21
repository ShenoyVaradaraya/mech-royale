export const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}
export const hyp2 = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay)

/** time t>0 for projectile at speed s from origin o to hit target p + v t (3D), or null */
export function intercept(o: number[], p: number[], v: number[], s: number): number | null {
  const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2]
  const a = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - s * s
  const b = 2 * (dx * v[0] + dy * v[1] + dz * v[2])
  const c = dx * dx + dy * dy + dz * dz
  if (Math.abs(a) < 1e-9) return c > 0 && b < 0 ? -c / b : null
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const r = Math.sqrt(disc)
  const t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a)
  const t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2)
  return t > 0 ? t : null
}

/** pitch to hit horizontal distance d and height dz with speed v, gravity g. low arc if low=true */
export function ballisticPitch(d: number, dz: number, v: number, g: number, low = true): number | null {
  const v2 = v * v
  const disc = v2 * v2 - g * (g * d * d + 2 * dz * v2)
  if (disc < 0) return null
  const r = Math.sqrt(disc)
  const a = Math.atan2(v2 + (low ? -r : r), g * d)
  return a
}

/** simple deterministic RNG */
export function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

export function gauss(r: () => number) {
  const u = Math.max(1e-12, r()), v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

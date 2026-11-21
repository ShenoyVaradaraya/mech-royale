// Port of the kit example bot (python/example_bot.py) for calibration.
export function makeExample(hello: any) {
  const reach = hello.config.loot.pickup_radius
  return {
    act(obs: any) {
      const me = obs.self
      const [x, y, z] = me.pos
      const goal = obs.zone.next_center
      const act: any = {}
      if (obs.offer) act.pick = 0
      const near = obs.pickups.filter((p: any) => Math.hypot(p.pos[0] - x, p.pos[1] - y) < reach)
      if (me.weapons[1] === null && near.length && near[0].kind !== "gun") act.take = near[0].id
      const enemies = obs.mechs.filter((m: any) => m.kind === "mech").sort((a: any, b: any) => Math.hypot(a.pos[0] - x, a.pos[1] - y, a.pos[2] - z) - Math.hypot(b.pos[0] - x, b.pos[1] - y, b.pos[2] - z))
      const yaw = Math.atan2(goal[1] - y, goal[0] - x)
      Object.assign(act, { move: [Math.cos(yaw), Math.sin(yaw)], aim: [yaw, 0], boost: !me.in_zone, jump: obs.tick % 40 === 0 })
      if (enemies.length) {
        const t = enemies[0].pos
        act.aim = [Math.atan2(t[1] - y, t[0] - x), Math.atan2(t[2] - z - 2.5, Math.hypot(t[0] - x, t[1] - y, t[2] - z))]
        act.fire = [true, true]
      }
      return act
    },
  }
}

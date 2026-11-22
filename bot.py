"""Mech Royale practice baseline: take cover and break first contact."""
import math
from arena import Arena
import mechfight as mf


def angle_error(first, second):
    return abs(math.remainder(first - second, math.tau))


class Bot:
    name = "Corner Runner v1"

    def __init__(self, hello):
        self.map = Arena(hello["map"]["dir"])
        self.pickup_radius = hello["config"]["loot"]["pickup_radius"]
        self.path = []
        self.next_plan = 0
        self.last_threat = None
        self.last_seen = -100
        self.last_check = -1
        self.last_position = None
        self.jet_until = -1

    def act(self, obs):
        me, zone, now = obs["self"], obs["zone"], obs["t"]
        pos = me["pos"]
        x, y, z = pos
        stats = me["stats"]
        muzzle = (x, y, z + stats["muzzle_height"])
        enemies = (m for m in obs["mechs"] if m["kind"] == "mech")
        enemy = min(enemies, key=lambda m: math.dist(pos, m["pos"]), default=None)
        threat = None
        if enemy:
            ex, ey, ez = enemy["pos"]
            threat = (ex, ey, ez + 4.5 * (1 + .05 * enemy.get("cubes", 0)))
            self.last_seen = now
        elif now - self.last_seen < 3:
            threat = self.last_threat
        if now >= self.next_plan or bool(threat) != bool(self.last_threat):
            self.path = self.map.route(pos, zone, threat)
            self.next_plan = now + 1.2
        self.last_threat = threat

        while self.path and math.dist(pos[:2], self.path[0]) <= 2.8:
            self.path.pop(0)
        move = [0, 0]
        if self.path:
            dx, dy = self.path[0][0] - x, self.path[0][1] - y
            distance = math.hypot(dx, dy)
            move = [dx / distance, dy / distance]
        elif zone["next_radius"] < self.map.step and math.dist(pos[:2], zone["next_center"]) > 0.8:
            dx, dy = zone["next_center"][0] - x, zone["next_center"][1] - y
            distance = math.hypot(dx, dy)
            move = [dx / distance, dy / distance]
        moving = any(move)
        if now - self.last_check >= 0.8:
            if moving and self.last_position and math.dist(pos[:2], self.last_position) < 1.4:
                self.jet_until = now + 0.7
            self.last_check, self.last_position = now, pos[:2]
        jet = moving and now < self.jet_until and me["energy"] > 8
        exposed = threat is not None and self.map.clear(muzzle, threat)
        act = {"tick": obs["tick"], "move": move, "jump": jet and me["grounded"],
               "boost": jet or (moving and me["grounded"] and (exposed or not me["in_zone"]) and me["energy"] > 24)}
        weapons = me["weapons"]
        if weapons[1] is None:
            for item in obs["pickups"]:
                if (item["kind"] == "laser" and abs(item["pos"][2] - z) <= 4
                        and math.dist(pos[:2], item["pos"][:2]) <= self.pickup_radius):
                    act["take"] = item["id"]
                    break
        if obs.get("offer"):
            priorities = ["nanites", "servos", "plating", "armor", "jets", "reactor", "laser_damage", "gun_damage"]
            choices = obs["offer"]["choices"]
            act["pick"] = min(range(len(choices)), key=lambda i: priorities.index(choices[i]["id"])
                              if choices[i]["id"] in priorities else len(priorities))

        gun = weapons[0]
        act["reload"] = bool(gun and not exposed and gun["ammo"] < gun["stats"]["mag"])
        if enemy and exposed:
            laser = weapons[1]
            distance = math.dist(muzzle, threat)
            using_laser = (laser and distance <= laser["stats"]["range"] and
                           (not moving or laser.get("charge", 0) > 0 or not gun["ammo"]))
            flight = 0 if using_laser else distance / gun["stats"]["speed"]
            tx, ty, tz = [p + v * flight for p, v in zip(threat, enemy["vel"])]
            yaw = math.atan2(ty - y, tx - x)
            pitch = math.atan2(tz - muzzle[2], math.hypot(tx - x, ty - y))
            aligned = angle_error(yaw, me["aim"][0]) < .12 and abs(me["aim"][1] - pitch) < .12
            act["aim"] = [yaw, pitch]
            act["fire"] = [aligned and distance < gun["stats"]["range"],
                           bool(using_laser and laser.get("charge", 0) < laser["stats"]["charge"] and aligned)]
        elif threat:
            act["aim"] = [math.atan2(threat[1] - y, threat[0] - x), 0]
        else:
            bearings = [s for s in obs["sounds"] if s["kind"] in {"gun", "laser_charge", "mortar", "lightning"}]
            act["aim"] = [min(bearings, key=lambda s: s["age"])["bearing"] if bearings else math.remainder(now * 0.9, math.tau), 0]
        return act


if __name__ == "__main__":
    mf.run(Bot)

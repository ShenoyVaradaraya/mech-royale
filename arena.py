"""Coarse ground navigation on the campus map supplied at match start."""
import json
import math
from array import array
from collections import deque
from pathlib import Path


class Arena:
    step = 6

    def __init__(self, directory):
        folder = Path(directory) / "v2"
        world = json.loads((folder / "world.json").read_bytes())
        terrain = world["terrain"]
        heights = array("h", (folder / "terrain.i16").read_bytes())
        bounds = world["bounds"]
        self.x0 = math.ceil(bounds["minX"]) + 3
        self.y0 = math.ceil(bounds["minY"]) + 3
        self.width = int((bounds["maxX"] - self.x0 - 3) / self.step) + 1
        height = int((bounds["maxY"] - self.y0 - 3) / self.step) + 1
        self.points = [(self.x0 + i * self.step, self.y0 + j * self.step)
                       for j in range(height) for i in range(self.width)]
        self.floor = []
        for x, y in self.points:
            i = round((x - terrain["minX"]) / terrain["step"])
            j = round((y - terrain["minY"]) / terrain["step"])
            self.floor.append(heights[j * terrain["nx"] + i] * terrain["scale"])
        self.top = self.floor.copy()
        blocked = set()
        for solid in world["prisms"]:
            rings = [solid["ring"], *solid["holes"]]
            ymin, ymax = min(rings[0][1::2]), max(rings[0][1::2])
            for j in range(max(0, math.ceil((ymin - self.y0) / self.step)),
                           min(height, math.floor((ymax - self.y0) / self.step) + 1)):
                y = self.y0 + j * self.step
                cuts = []
                for ring in rings:
                    ax, ay = ring[-2:]
                    for bx, by in zip(ring[::2], ring[1::2]):
                        if (ay > y) != (by > y):
                            cuts.append(ax + (y - ay) * (bx - ax) / (by - ay))
                        ax, ay = bx, by
                cuts.sort()
                for left, right in zip(cuts[::2], cuts[1::2]):
                    for i in range(max(0, math.ceil((left - self.x0) / self.step)),
                                   min(self.width, math.floor((right - self.x0) / self.step) + 1)):
                        n = j * self.width + i
                        if solid["base"] < self.floor[n] + 9 and solid["top"] > self.floor[n] + 1.2:
                            blocked.add(n)
                            self.top[n] = max(self.top[n], solid["top"])
        self.edges = [[] for _ in self.points]
        self.cover = set()
        for n in range(len(self.points)):
            if n in blocked:
                continue
            i, j = n % self.width, n // self.width
            for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if not (0 <= i + di < self.width and 0 <= j + dj < height):
                    continue
                m = n + di + dj * self.width
                if m in blocked:
                    if self.top[m] > self.floor[n] + 8:
                        self.cover.add(n)
                elif abs(self.floor[m] - self.floor[n]) < self.step:
                    self.edges[n].append(m)

    def cell(self, pos):
        i = max(0, min(self.width - 1, round((pos[0] - self.x0) / self.step)))
        j = max(0, min(len(self.points) // self.width - 1, round((pos[1] - self.y0) / self.step)))
        return j * self.width + i

    def clear(self, a, b):
        """Sample solid heights between two positions at torso height."""
        steps = max(1, math.ceil(math.dist(a[:2], b[:2]) / self.step))
        dx, dy, dz = ((end - start) / steps for start, end in zip(a, b))
        x, y, z = a
        for _ in range(1, steps):
            x, y, z = x + dx, y + dy, z + dz
            if self.top[self.cell((x, y))] >= z:
                return False
        return True

    def route(self, pos, zone, threat):
        start = self.cell(pos)
        if not self.edges[start]:
            i, j = start % self.width, start // self.width
            nearby = [start + di + dj * self.width for dj in range(-3, 4) for di in range(-3, 4)
                      if 0 <= i + di < self.width and 0 <= j + dj < len(self.points) // self.width]
            start = min((n for n in nearby if self.edges[n]),
                        key=lambda n: math.dist(pos[:2], self.points[n]), default=start)
        parents = {start: None}
        queue = deque([(start, 0)])
        best, best_score = start, -math.inf
        safe_radius = max(0, zone["next_radius"] - 14)
        while queue:
            n, depth = queue.popleft()
            x, y = self.points[n]
            score = -2 * max(0, math.dist((x, y), zone["next_center"]) - safe_radius)
            score -= 4 * max(0, math.dist((x, y), zone["center"]) - zone["radius"] + 2)
            score += (18 if n in self.cover else 0) - depth * 0.85
            if threat:
                score += min(110, math.dist((x, y), threat[:2])) * 0.24
                # Ray tests only at building edges keep each planning pass bounded.
                if n in self.cover and not self.clear((x, y, self.floor[n] + 7), threat):
                    score += 60
            if score > best_score:
                best, best_score = n, score
            if depth < 13:
                for m in self.edges[n]:
                    if m not in parents:
                        parents[m] = n
                        queue.append((m, depth + 1))
        path = []
        while best != start:
            path.append(self.points[best])
            best = parents[best]
        if math.dist(pos[:2], self.points[start]) > self.step:
            path.append(self.points[start])
        return path[::-1]

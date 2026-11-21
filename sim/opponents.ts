export type Opponent = {
  name: string
  tier: number
  rangeScale: number
  strafeScale: number
  reactionScale: number
  aimNoiseScale: number
  boostChance: number
  lootRadius: number
}

// Shared squad rules, with independent decisions and different combat roles.
export const OPPONENTS: readonly Opponent[] = [
  { name: "scout", tier: 0, rangeScale: 0.95, strafeScale: 1.4, reactionScale: 0.9, aimNoiseScale: 1.15, boostChance: 0, lootRadius: 165 },
  { name: "recruit", tier: 0, rangeScale: 1, strafeScale: 1, reactionScale: 1.05, aimNoiseScale: 1, boostChance: 0, lootRadius: 145 },
  { name: "runner", tier: 0, rangeScale: 0.8, strafeScale: 1.2, reactionScale: 1, aimNoiseScale: 1.2, boostChance: 0.12, lootRadius: 130 },
  { name: "prospector", tier: 0, rangeScale: 1.12, strafeScale: 0.85, reactionScale: 1.1, aimNoiseScale: 0.95, boostChance: 0, lootRadius: 200 },
  { name: "pursuer", tier: 1, rangeScale: 0.84, strafeScale: 1, reactionScale: 0.85, aimNoiseScale: 1, boostChance: 0.1, lootRadius: 140 },
  { name: "skirmisher", tier: 1, rangeScale: 1, strafeScale: 1.2, reactionScale: 0.95, aimNoiseScale: 1.05, boostChance: 0, lootRadius: 150 },
  { name: "ranger", tier: 1, rangeScale: 1.25, strafeScale: 0.85, reactionScale: 1.1, aimNoiseScale: 0.9, boostChance: 0, lootRadius: 165 },
  { name: "outrider", tier: 1, rangeScale: 1.06, strafeScale: 1.4, reactionScale: 1.05, aimNoiseScale: 1.1, boostChance: 0.15, lootRadius: 125 },
  { name: "flanker", tier: 2, rangeScale: 0.93, strafeScale: 1.35, reactionScale: 1, aimNoiseScale: 1, boostChance: 0.35, lootRadius: 160 },
  { name: "brawler", tier: 2, rangeScale: 0.74, strafeScale: 0.8, reactionScale: 1, aimNoiseScale: 1.15, boostChance: 0.25, lootRadius: 135 },
  { name: "marksman", tier: 2, rangeScale: 1.21, strafeScale: 0.9, reactionScale: 1.1, aimNoiseScale: 0.8, boostChance: 0.2, lootRadius: 150 },
  { name: "vanguard", tier: 2, rangeScale: 1, strafeScale: 1.1, reactionScale: 0.85, aimNoiseScale: 0.95, boostChance: 0.32, lootRadius: 150 },
  { name: "interceptor", tier: 3, rangeScale: 0.9, strafeScale: 1.25, reactionScale: 0.85, aimNoiseScale: 1.05, boostChance: 0.38, lootRadius: 150 },
  { name: "sentinel", tier: 3, rangeScale: 1.13, strafeScale: 1, reactionScale: 1, aimNoiseScale: 0.9, boostChance: 0.25, lootRadius: 160 },
  { name: "duelist", tier: 3, rangeScale: 0.97, strafeScale: 1.15, reactionScale: 0.95, aimNoiseScale: 0.95, boostChance: 0.3, lootRadius: 145 },
  { name: "striker", tier: 3, rangeScale: 0.82, strafeScale: 0.85, reactionScale: 0.8, aimNoiseScale: 1, boostChance: 0.35, lootRadius: 135 },
]

export function assignOpponents(matchSeed: number, random: () => number, exactTiers = false): Opponent[] {
  const unsignedSeed = matchSeed >>> 0
  const expertCount = 4
  const excluded = exactTiers ? OPPONENTS.length - expertCount + unsignedSeed % expertCount : unsignedSeed % OPPONENTS.length
  const roster = OPPONENTS.filter((_, i) => i !== excluded)
  for (let i = roster.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[roster[i], roster[j]] = [roster[j], roster[i]]
  }
  return roster
}

# Mech Royale bot

TypeScript bot for the Builders Mech Royale track (mechfight/1 protocol). Runs with Bun in the provided Dockerfile.

- `main.ts` — entrypoint (loads map from `/arena`, builds nav grid)
- `bot.ts` — decision logic (targeting, combat, retreat/cover, loot, zone)
- `world.ts` / `nav.ts` — map rasterization, line of sight, A* navigation
- `sim/` — local approximate simulator + house-bot squad for offline evaluation (`node sim/eval.ts 20`)

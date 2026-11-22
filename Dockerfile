FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY apex-bot.ts geom.ts main.ts mechfight.ts nav.ts package.json world.ts ./
COPY arena ./arena
USER 65534:65534
ENTRYPOINT ["bun", "/bot/main.ts"]

FROM oven/bun:1.2.5 AS base

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install

FROM base
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3030
ENTRYPOINT ["bun", "src/server.ts"]
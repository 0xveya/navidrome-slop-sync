FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY public ./public
RUN bun run check && bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
USER bun
EXPOSE 3000
CMD ["bun", "src/server.ts"]

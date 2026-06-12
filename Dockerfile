# Single image: builds the client, runs the authoritative game server, and
# serves the static client from the same origin (the shape Discord's activity
# proxy expects — relative URLs only).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN corepack install
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm --filter @quori/client build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app/pnpm-workspace.yaml /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/engine/package.json packages/engine/
COPY --from=build /app/packages/protocol/package.json packages/protocol/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/client/package.json packages/client/
RUN corepack install
RUN pnpm install --prod --frozen-lockfile --filter @quori/server...
COPY --from=build /app/packages/engine/src packages/engine/src
COPY --from=build /app/packages/protocol/src packages/protocol/src
COPY --from=build /app/packages/server/src packages/server/src
COPY --from=build /app/packages/client/dist packages/client/dist
ENV PORT=5174
ENV CLIENT_DIST=/app/packages/client/dist
EXPOSE 5174
CMD ["pnpm", "--filter", "@quori/server", "start"]

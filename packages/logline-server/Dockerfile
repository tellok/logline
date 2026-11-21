FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS base
WORKDIR /app

FROM base AS dependencies
RUN npm install --global --ignore-scripts pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/logline-server/package.json packages/logline-server/package.json
RUN pnpm --filter logline-server install --prod --frozen-lockfile --ignore-scripts

FROM base AS server
ENV NODE_ENV=production PORT=4318
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/packages/logline-server ./packages/logline-server
COPY --chown=node:node packages/logline-server/src ./packages/logline-server/src
USER node
EXPOSE 4318
CMD ["node", "packages/logline-server/src/server.mjs"]

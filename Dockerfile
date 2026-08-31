# Countersign — the merchant server, as one image.
#
#   docker build -t countersign .
#   docker run --env-file .env -p 3000:3000 countersign
#
# Two stages: the first has the toolchain and builds dist/, the second has
# only the production dependencies and what the server reads at runtime —
# dist/, migrations/ (applied at boot) and assets/ (the landing page's media).
# The verifier CLI is built separately (`make cli`); it is for a laptop, not
# for this box.

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# Runs as the unprivileged user the base image ships with.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node assets ./assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1
CMD ["node", "dist/src/http/server.js"]

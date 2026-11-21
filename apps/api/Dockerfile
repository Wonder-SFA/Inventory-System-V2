FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.21.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-domain/package.json packages/shared-domain/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @iv2/api...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared-domain packages/shared-domain
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @iv2/shared-domain build \
  && pnpm --filter @iv2/db build \
  && pnpm --filter @iv2/api build

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared-domain/package.json ./packages/shared-domain/
COPY --from=build /app/packages/shared-domain/dist ./packages/shared-domain/dist
COPY --from=build /app/packages/shared-domain/node_modules ./packages/shared-domain/node_modules
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules

EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]

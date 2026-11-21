FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.21.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared-domain/package.json packages/shared-domain/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @iv2/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared-domain packages/shared-domain
COPY apps/web apps/web
RUN pnpm --filter @iv2/shared-domain build \
  && pnpm --filter @iv2/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# syntax=docker/dockerfile:1

# Mehrstufiger Build fuer das Backend.
#
# Monorepo-Besonderheit: @gto/shared ist eine Workspace-Abhaengigkeit und muss
# vor dem Backend gebaut werden. `pnpm deploy` schnuert daraus am Ende ein
# eigenstaendiges Verzeichnis mit ausschliesslich Produktions-Abhaengigkeiten.
#
# Node-Version passend zur .nvmrc (20.19.6).

# --- Basis ------------------------------------------------------------------
FROM node:20.19.6-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# --- Abhaengigkeiten --------------------------------------------------------
FROM base AS deps
# WICHTIG: Der Zielhost hat NODE_ENV=production in der Shell. Waere das hier
# gesetzt, wuerde pnpm die devDependencies ueberspringen und der TypeScript-
# Build fehlschlagen. Deshalb im Build-Stage bewusst development.
ENV NODE_ENV=development
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile --filter @gto/backend... --filter @gto/shared...

# --- Build ------------------------------------------------------------------
FROM deps AS build
ENV NODE_ENV=development
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN pnpm --filter @gto/shared build \
 && pnpm --filter @gto/backend build
# Eigenstaendiges Produktionsbuendel (nur prod-Abhaengigkeiten, inkl. shared).
RUN pnpm deploy --filter=@gto/backend --prod /bundle

# --- Laufzeit ---------------------------------------------------------------
FROM node:20.19.6-alpine AS runtime
ENV NODE_ENV=production
# Nicht als root laufen. node:alpine bringt den Benutzer "node" (uid 1000) mit.
WORKDIR /app
COPY --from=build --chown=node:node /bundle /app
# Migrationen liegen als SQL im Image, damit der Deploy sie einspielen kann.
COPY --from=build --chown=node:node /repo/apps/backend/drizzle /app/drizzle
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

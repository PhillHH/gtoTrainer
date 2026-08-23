# syntax=docker/dockerfile:1

# Build-Image fuer die statischen Frontend-Assets.
#
# Dieses Image laeuft NICHT dauerhaft. Der Deploy baut es, entnimmt das
# fertige `dist/` per `docker cp` und legt es in das Verzeichnis, das der
# Host-Nginx direkt ausliefert (siehe ADR-0016). Es gibt bewusst keinen
# nginx-Container und keinen zweiten Reverse Proxy.

FROM node:20.19.6-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Der Zielhost hat NODE_ENV=production in der Shell - hier bewusst ueberschrieben,
# sonst fehlen die devDependencies und der Vite-Build schlaegt fehl.
ENV NODE_ENV=development
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile --filter @gto/frontend... --filter @gto/shared...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
RUN pnpm --filter @gto/shared build \
 && pnpm --filter @gto/frontend build

# --- Ergebnis ---------------------------------------------------------------
# Minimales Image, das ausschliesslich die fertigen Assets enthaelt. Es wird
# nur zum Herauskopieren erzeugt, nie gestartet.
FROM scratch AS assets
COPY --from=build /repo/apps/frontend/dist /dist

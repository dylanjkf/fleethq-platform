# Multi-stage build: only the final `runtime` stage's layers end up in the
# image that's ever deployed — no devDependencies, no TypeScript source, no
# build tools in what actually runs in production.

FROM node:22-alpine AS deps
WORKDIR /app
# Alpine ships no OpenSSL at all by default — Prisma's engine binaries shell
# out to `openssl version` to pick the right build (openssl-1.1.x vs 3.0.x)
# and, with nothing installed to detect, silently default to 1.1.x and then
# fail to load at all. Installing it here (present in every stage that
# touches `prisma generate`/`migrate deploy`) is the standard fix, not a
# workaround — see https://www.prisma.io/docs/orm/reference/environment-variables-reference#prisma_binary_target-1.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
# postinstall runs `prisma generate`, which needs prisma/schema.prisma
# present — hence copying it before `npm ci`, not after.
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# See the `deps` stage's comment — this is the image that actually ships and
# runs `prisma migrate deploy` at container start (docker-entrypoint.sh), so
# it needs OpenSSL installed just as much as the build-time stage does.
RUN apk add --no-cache openssl

# Production-only dependencies, generated fresh in this stage (not copied
# from `deps`) so devDependencies never enter this image's layers at all.
# `prisma` (the CLI, needed at runtime for `prisma migrate deploy` below) is
# a production dependency for exactly this reason — its own postinstall
# regenerates the Prisma Client against this stage's installed version.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# A non-root user — a compromised process inside the container shouldn't
# have root inside it either, standard defense in depth for a container that
# will one day handle real customer data. Everything up to this point
# (npm ci, the copied dist/, the entrypoint script) was written as root, so
# it must be chown'd to fleetos before switching users — otherwise
# `prisma migrate deploy` in docker-entrypoint.sh fails at container start
# trying to write into a root-owned node_modules/@prisma tree (the query
# engine's own write check), the entrypoint exits under `set -e`, and the
# app never binds to a port at all — which reads as the healthcheck timing
# out, not as the actual permission error underneath it.
RUN addgroup -S fleetos && adduser -S fleetos -G fleetos && chown -R fleetos:fleetos /app
USER fleetos

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

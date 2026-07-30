# Multi-stage build: only the final `runtime` stage's layers end up in the
# image that's ever deployed — no devDependencies, no TypeScript source, no
# build tools in what actually runs in production.

FROM node:22-alpine AS deps
WORKDIR /app
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
# will one day handle real customer data.
RUN addgroup -S fleetos && adduser -S fleetos -G fleetos
USER fleetos

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

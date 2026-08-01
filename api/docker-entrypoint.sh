#!/bin/sh
# Applies pending Prisma migrations, then hands off to the app process.
#
# `prisma migrate deploy` only applies pending migrations and is safe to re-run
# against an already-up-to-date database, so running it here is correct for a
# single running instance (true at this app's current scale; Railway has no
# separate "release phase" the way Heroku does — see README.md "Deployment").
#
# Multi-replica safety: migrate-on-boot races when several replicas start at
# once against the same schema. To decouple, set RUN_MIGRATIONS_ON_BOOT=false on
# the app service and run migrations exactly once as a dedicated pre-deploy step
# instead — e.g. a one-off `npm run prisma:migrate:deploy` (a release command or
# a short-lived job) that completes before the new replicas roll. With the flag
# unset or "true" the previous single-instance behaviour is preserved, so
# nothing changes until you deliberately scale out.
set -e

if [ "${RUN_MIGRATIONS_ON_BOOT:-true}" = "true" ]; then
  npx prisma migrate deploy
else
  echo "RUN_MIGRATIONS_ON_BOOT=false — skipping boot migration (run migrations as a dedicated pre-deploy step)."
fi

exec "$@"

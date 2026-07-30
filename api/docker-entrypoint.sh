#!/bin/sh
# Runs on every container start (Railway has no separate "release phase" the
# way Heroku does — see README.md "Deployment (Railway)"). `prisma migrate
# deploy` only applies pending migrations and is safe to re-run against an
# already-up-to-date database, so this is correct for both the first deploy
# and every one after. Assumes a single running instance during a migration
# window (true for this app's current scale) — concurrent instances racing
# the same schema migration is not handled specially.
set -e

npx prisma migrate deploy

exec "$@"

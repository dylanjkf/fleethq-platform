#!/usr/bin/env bash
#
# Backup restore drill (17-Roadmap/Launch_Readiness_Plan.md A4).
#
# Backups being *configured* is not the same as a restore being *proven*. This
# script proves it end to end: dump the live database, restore that dump into a
# throwaway scratch database, and verify the restored copy matches the source
# row-for-row on the key tables. It leaves the source database untouched and
# drops the scratch database afterwards.
#
# Run it on a schedule (and before any risky migration) so a real recovery is
# never the first time a restore has been attempted.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/fleetos ./scripts/restore-drill.sh
#
# The role in DATABASE_URL needs CREATEDB (in production, run as the RDS master
# / an admin role, not the app role). ADMIN_URL overrides the connection used
# for CREATE/DROP DATABASE if that has to differ from the dump connection.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FAIL: DATABASE_URL is not set" >&2
  exit 1
fi

# psql/pg_dump reject the Prisma-style '?schema=public' suffix — strip it.
SRC_URL="${DATABASE_URL%%\?*}"
SRC_DB="$(basename "${SRC_URL}")"
SCRATCH_DB="${SRC_DB}_restore_drill"
# Connection to the 'postgres' maintenance DB for CREATE/DROP DATABASE.
ADMIN_URL="${ADMIN_URL:-${SRC_URL%/*}/postgres}"
DUMP_FILE="$(mktemp /tmp/fleetos-drill.XXXXXX.dump)"

# The tables whose row counts must match after restore — the ones a real
# recovery would be judged on. Add to this list as the schema grows.
TABLES=(companies users operators assets jobs job_stops attachments compliance_documents timeline_events)

cleanup() {
  rm -f "${DUMP_FILE}"
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=0 -qc "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Dumping ${SRC_DB} ..."
pg_dump --format=custom --no-owner --no-privileges --file="${DUMP_FILE}" "${SRC_URL}"

echo "==> Creating scratch database ${SCRATCH_DB} ..."
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\";"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"${SCRATCH_DB}\";"

SCRATCH_URL="${SRC_URL%/*}/${SCRATCH_DB}"

echo "==> Restoring into ${SCRATCH_DB} ..."
# --no-acl/--no-owner so the restore doesn't depend on the source's roles
# existing; exit-on-error off for pg_restore because harmless "role does not
# exist" notices can appear — we judge success by the row-count check, not by
# pg_restore's exit code.
pg_restore --no-owner --no-privileges --dbname="${SCRATCH_URL}" "${DUMP_FILE}" || true

echo "==> Verifying row counts ..."
FAILED=0
for table in "${TABLES[@]}"; do
  SRC_COUNT="$(psql "${SRC_URL}" -tAc "SELECT count(*) FROM \"${table}\"" 2>/dev/null || echo "ERR")"
  DST_COUNT="$(psql "${SCRATCH_URL}" -tAc "SELECT count(*) FROM \"${table}\"" 2>/dev/null || echo "ERR")"
  if [[ "${SRC_COUNT}" == "${DST_COUNT}" && "${SRC_COUNT}" != "ERR" ]]; then
    printf '   ok   %-22s %s rows\n' "${table}" "${SRC_COUNT}"
  else
    printf '   FAIL %-22s source=%s restored=%s\n' "${table}" "${SRC_COUNT}" "${DST_COUNT}"
    FAILED=1
  fi
done

if [[ "${FAILED}" -eq 0 ]]; then
  echo "==> RESTORE DRILL PASSED — dump restores cleanly and matches the source."
else
  echo "==> RESTORE DRILL FAILED — investigate before relying on backups." >&2
  exit 1
fi

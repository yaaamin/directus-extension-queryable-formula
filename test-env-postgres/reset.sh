#!/usr/bin/env bash
set -euo pipefail

# ─── Reset database and re-bootstrap Directus ───
# Docker (default): recreate volume. External: DROP SCHEMA public.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="$SCRIPT_DIR/instance"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/pg-env.sh"

if [ ! -d "$TEST_DIR" ]; then
  echo "Error: Test instance not found. Run 'bun run test:pg:setup' first."
  exit 1
fi

if [ "$USE_EXTERNAL_POSTGRES" != "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker not found."
    exit 1
  fi
  echo "→ Stopping Postgres and removing Docker volume..."
  docker compose -f "$COMPOSE_FILE" down -v

  echo "→ Starting fresh Postgres..."
  docker compose -f "$COMPOSE_FILE" up -d --wait
else
  if ! command -v psql >/dev/null 2>&1; then
    echo "Error: psql not found."
    exit 1
  fi
  echo "→ Dropping public schema in ${PGDATABASE} (all tables)..."
  export PGPASSWORD
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
SQL
fi

echo "→ Re-bootstrapping Directus..."
cd "$TEST_DIR"
bunx directus bootstrap

echo "→ Done. Start with 'bun run test:pg:start'."

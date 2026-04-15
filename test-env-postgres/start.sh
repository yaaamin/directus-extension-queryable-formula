#!/usr/bin/env bash
set -euo pipefail

# ─── Start Directus (Postgres test env) ───

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/instance"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/pg-env.sh"

if [ ! -d "$TEST_DIR/node_modules/directus" ]; then
  echo "Error: Test instance not set up. Run 'bun run test:pg:setup' first."
  exit 1
fi

if [ "$USE_EXTERNAL_POSTGRES" != "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker not found."
    exit 1
  fi
  echo "→ Ensuring PostgreSQL is up (Docker)..."
  docker compose -f "$COMPOSE_FILE" up -d --wait
fi

if command -v psql >/dev/null 2>&1; then
  export PGPASSWORD
  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c 'SELECT 1' >/dev/null 2>&1; then
    echo "Error: cannot reach PostgreSQL at ${PGHOST}:${PGPORT} (db=${PGDATABASE})."
    if [ "$USE_EXTERNAL_POSTGRES" = "1" ]; then
      echo "Start your server or fix test-env-postgres/.env.pg"
    else
      echo "Start Docker or run: docker compose -f \"$COMPOSE_FILE\" up -d --wait"
    fi
    exit 1
  fi
fi

echo "→ Rebuilding extension..."
cd "$PROJECT_ROOT"
bun run build

LINK_TARGET="$TEST_DIR/extensions/directus-extension-queryable-formula"
rm -rf "$LINK_TARGET"
ln -sf "$PROJECT_ROOT" "$LINK_TARGET"

echo "→ Starting Directus at ${DIRECTUS_PUBLIC_URL} ..."
cd "$TEST_DIR"
bunx directus start

#!/usr/bin/env bash
# Sourced by setup.sh / reset.sh / start.sh — not run directly.
#
# Default: PostgreSQL via Docker Compose (docker-compose.yml, port 54322).
# For a local/server Postgres instead: copy .env.pg.example → .env.pg and set
#   USE_EXTERNAL_POSTGRES=1
# plus PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE.

_PG_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export USE_EXTERNAL_POSTGRES="${USE_EXTERNAL_POSTGRES:-0}"

if [ -f "$_PG_ENV_DIR/.env.pg" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$_PG_ENV_DIR/.env.pg"
  set +a
fi

# Re-read after .env.pg may have set it
export USE_EXTERNAL_POSTGRES="${USE_EXTERNAL_POSTGRES:-0}"

if [ "$USE_EXTERNAL_POSTGRES" = "1" ]; then
  export PGHOST="${PGHOST:-127.0.0.1}"
  export PGPORT="${PGPORT:-5432}"
  export PGUSER="${PGUSER:-directus}"
  export PGPASSWORD="${PGPASSWORD:-directus}"
  export PGDATABASE="${PGDATABASE:-directus_formula_test}"
else
  export PGHOST="127.0.0.1"
  export PGPORT="54322"
  export PGUSER="directus"
  export PGPASSWORD="directus"
  export PGDATABASE="directus"
fi

export DIRECTUS_PORT="${DIRECTUS_PORT:-8056}"
export DIRECTUS_PUBLIC_URL="${DIRECTUS_PUBLIC_URL:-http://localhost:${DIRECTUS_PORT}}"

export COMPOSE_FILE="${COMPOSE_FILE:-$_PG_ENV_DIR/docker-compose.yml}"

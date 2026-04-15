#!/usr/bin/env bash
set -euo pipefail

# ─── Directus test environment (PostgreSQL) ───
# Default: Postgres in Docker (docker-compose.yml). Override with USE_EXTERNAL_POSTGRES=1 in .env.pg.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/instance"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/pg-env.sh"

echo "══════════════════════════════════════════════"
echo "  Directus PostgreSQL Test Environment Setup"
echo "══════════════════════════════════════════════"

if [ "$USE_EXTERNAL_POSTGRES" != "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker not found. Install Docker, or set USE_EXTERNAL_POSTGRES=1 in .env.pg for a local Postgres."
    exit 1
  fi
  echo ""
  echo "→ Starting PostgreSQL (Docker)..."
  docker compose -f "$COMPOSE_FILE" up -d --wait
else
  if ! command -v psql >/dev/null 2>&1; then
    echo "Error: psql not found. Install PostgreSQL client tools for external Postgres mode."
    exit 1
  fi
fi

if command -v psql >/dev/null 2>&1; then
  echo ""
  echo "→ Checking PostgreSQL connection (${PGHOST}:${PGPORT}, db=${PGDATABASE})..."
  export PGPASSWORD
  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c 'SELECT 1' >/dev/null 2>&1; then
    echo "Error: cannot connect to PostgreSQL."
    if [ "$USE_EXTERNAL_POSTGRES" = "1" ]; then
      echo "  Adjust .env.pg (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) and ensure the database exists."
    else
      echo "  Ensure Docker is running and wait for: docker compose -f \"$COMPOSE_FILE\" ps"
    fi
    exit 1
  fi
else
  echo ""
  echo "→ Skipping psql check (client not installed); relying on Docker health / bootstrap."
fi

echo ""
echo "→ Building extension..."
cd "$PROJECT_ROOT"
bun install
bun run build

echo ""
echo "→ Setting up Directus test instance at $TEST_DIR..."
mkdir -p "$TEST_DIR/extensions"

cd "$TEST_DIR"
if [ ! -f package.json ]; then
  bun init -y > /dev/null 2>&1
fi

echo "→ Installing Directus + pg driver..."
bun add directus@latest pg

LINK_TARGET="$TEST_DIR/extensions/directus-extension-queryable-formula"
rm -rf "$LINK_TARGET"
ln -sf "$PROJECT_ROOT" "$LINK_TARGET"
echo "→ Extension linked: $LINK_TARGET → $PROJECT_ROOT"

SECRET_VAL="${DIRECTUS_SECRET:-test-secret-key-for-local-dev-pg}"
ADMIN_EMAIL_VAL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD_VAL="${ADMIN_PASSWORD:-admin}"

cat > "$TEST_DIR/.env" <<EOF
DB_CLIENT=pg
DB_HOST=${PGHOST}
DB_PORT=${PGPORT}
DB_DATABASE=${PGDATABASE}
DB_USER=${PGUSER}
DB_PASSWORD=${PGPASSWORD}

SECRET=${SECRET_VAL}
ADMIN_EMAIL=${ADMIN_EMAIL_VAL}
ADMIN_PASSWORD=${ADMIN_PASSWORD_VAL}

HOST=0.0.0.0
PORT=${DIRECTUS_PORT}
PUBLIC_URL=${DIRECTUS_PUBLIC_URL}

LOG_LEVEL=info
EXTENSIONS_AUTO_RELOAD=true
EOF

echo ""
echo "→ Bootstrapping Directus..."
bunx directus bootstrap

echo ""
echo "══════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Start Directus:  bun run test:pg:start"
echo "  Admin login:     ${ADMIN_EMAIL_VAL} / ${ADMIN_PASSWORD_VAL}"
echo "  URL:             ${DIRECTUS_PUBLIC_URL}"
echo "  Sample schema:   bun run test:pg:seed (with Directus running)"
echo "  Reset DB:        bun run test:pg:reset"
echo "══════════════════════════════════════════════"

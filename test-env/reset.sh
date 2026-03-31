#!/usr/bin/env bash
set -euo pipefail

# ─── Reset test instance (wipe DB, re-bootstrap) ───

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="$SCRIPT_DIR/instance"

if [ ! -d "$TEST_DIR" ]; then
  echo "Error: Test instance not found. Run 'bun run test:setup' first."
  exit 1
fi

echo "→ Removing SQLite database..."
rm -f "$TEST_DIR/data.db"

echo "→ Re-bootstrapping Directus..."
cd "$TEST_DIR"
bunx directus bootstrap

echo "→ Done. Start with 'bun run test:start'."

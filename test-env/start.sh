#!/usr/bin/env bash
set -euo pipefail

# ─── Start Directus with the extension in dev mode ───
# Rebuilds extension first, then starts Directus.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/instance"

if [ ! -d "$TEST_DIR/node_modules/directus" ]; then
  echo "Error: Test instance not set up. Run 'bun run test:setup' first."
  exit 1
fi

# Rebuild extension
echo "→ Rebuilding extension..."
cd "$PROJECT_ROOT"
bun run build

# Re-link in case dist changed
LINK_TARGET="$TEST_DIR/extensions/directus-extension-queryable-formula"
rm -rf "$LINK_TARGET"
ln -sf "$PROJECT_ROOT" "$LINK_TARGET"

# Start Directus
echo "→ Starting Directus at http://localhost:8055 ..."
cd "$TEST_DIR"
bunx directus start

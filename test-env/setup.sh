#!/usr/bin/env bash
set -euo pipefail

# ─── Local Directus Test Environment Setup ───
# Uses SQLite — no Docker or external DB required.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR="$SCRIPT_DIR/instance"

echo "══════════════════════════════════════════════"
echo "  Directus Local Test Environment Setup"
echo "══════════════════════════════════════════════"

# 1. Build the extension
echo ""
echo "→ Building extension..."
cd "$PROJECT_ROOT"
bun install
bun run build

# 2. Create test instance directory
echo ""
echo "→ Setting up Directus test instance at $TEST_DIR..."
mkdir -p "$TEST_DIR/extensions"

# 3. Install Directus in the test instance
cd "$TEST_DIR"
if [ ! -f package.json ]; then
  bun init -y > /dev/null 2>&1
fi

echo "→ Installing Directus..."
bun add directus@latest

# 4. Symlink the built extension into the extensions folder
LINK_TARGET="$TEST_DIR/extensions/directus-extension-queryable-formula"
rm -rf "$LINK_TARGET"
ln -sf "$PROJECT_ROOT" "$LINK_TARGET"
echo "→ Extension linked: $LINK_TARGET → $PROJECT_ROOT"

# 5. Create .env for Directus
cat > "$TEST_DIR/.env" <<EOF
DB_CLIENT=sqlite3
DB_FILENAME=./data.db

SECRET=test-secret-key-for-local-dev
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=admin

HOST=0.0.0.0
PORT=8055
PUBLIC_URL=http://localhost:8055

LOG_LEVEL=info
EXTENSIONS_AUTO_RELOAD=true
EOF

# 6. Bootstrap Directus (creates DB + admin user)
echo ""
echo "→ Bootstrapping Directus..."
bunx directus bootstrap

echo ""
echo "══════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Start Directus:  npm run test:start"
echo "  Admin login:     admin@example.com / admin"
echo "  URL:             http://localhost:8055"
echo "  Sample schema:   bun run test:seed (with Directus running)"
echo "══════════════════════════════════════════════"

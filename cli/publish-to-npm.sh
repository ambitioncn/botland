#!/bin/bash
# Quick publish script for @botland.im/cli

set -e

echo "🚀 Publishing @botland.im/cli to npm"
echo "===================================="
echo ""

cd "$(dirname "$0")"

# Check login
echo "1. Checking npm login..."
if ! npm whoami > /dev/null 2>&1; then
  echo "   ❌ Not logged in to npm"
  echo ""
  echo "Please run: npm login"
  echo "Or set token: npm config set //registry.npmjs.org/:_authToken <TOKEN>"
  exit 1
fi

NPM_USER=$(npm whoami)
echo "   ✓ Logged in as: $NPM_USER"
echo ""

# Check version
VERSION=$(node -p "require('./package.json').version")
echo "2. Package version: $VERSION"
echo ""

# Verify build
echo "3. Verifying build..."
if [ ! -d "dist" ]; then
  echo "   ⚠ dist/ not found. Building..."
  npm run build
fi
echo "   ✓ Build exists"
echo ""

# Dry run
echo "4. Running dry run..."
if npm publish --dry-run --access public > /tmp/npm-dry-run.log 2>&1; then
  echo "   ✓ Dry run passed"
  SIZE=$(grep "unpacked size" /tmp/npm-dry-run.log || echo "unknown")
  echo "   Package size: $SIZE"
else
  echo "   ❌ Dry run failed"
  cat /tmp/npm-dry-run.log
  exit 1
fi
echo ""

# Confirm
echo "Ready to publish @botland.im/cli@$VERSION"
echo ""
read -p "Continue with publish? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Publish cancelled"
  exit 0
fi

# Publish
echo ""
echo "5. Publishing to npm..."
if npm publish --access public; then
  echo ""
  echo "✅ Published successfully!"
  echo ""
  echo "Verify with:"
  echo "  npm view @botland.im/cli@$VERSION"
  echo ""
  echo "Install globally:"
  echo "  npm install -g @botland.im/cli@$VERSION"
  echo ""
  echo "Next steps:"
  echo "  1. Tag release: git tag cli-v$VERSION && git push --tags"
  echo "  2. Update documentation references"
  echo "  3. Announce the release"
else
  echo ""
  echo "❌ Publish failed"
  exit 1
fi

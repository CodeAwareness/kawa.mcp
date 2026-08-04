#!/bin/bash
set -e

# Deploy @kawacode/mcp to npm + MCP Registry
# Usage:
#   ./deploy.sh [patch|minor|major]   — bump version then publish (default: patch)
#   ./deploy.sh --no-bump             — publish the existing package.json version
#                                        (use when the version was already bumped
#                                        in a prior commit, e.g. a semver-breaking
#                                        change committed alongside the work)

ARG="${1:-patch}"
DOMAIN="kawacode.ai"
KEY_FILE="mcp-registry-key.pem"

case "$ARG" in
  patch|minor|major|--no-bump) ;;
  *)
    echo "ERROR: unknown argument '$ARG'. Expected patch | minor | major | --no-bump." >&2
    exit 1
    ;;
esac

# Prerequisites
if [ ! -f "$KEY_FILE" ]; then
  echo "ERROR: $KEY_FILE not found. Recover from a backup — do not regenerate." >&2
  exit 1
fi
if ! command -v mcp-publisher >/dev/null 2>&1; then
  echo "ERROR: mcp-publisher not installed. Install with: brew install mcp-publisher" >&2
  exit 1
fi

# macOS ships LibreSSL as /usr/bin/openssl, which does NOT support Ed25519.
# Prefer a real OpenSSL (Homebrew) so the registry login step at the end can
# extract the raw private key.
OPENSSL_BIN=""
for candidate in \
  "$(command -v openssl3 2>/dev/null)" \
  "/opt/homebrew/opt/openssl@3/bin/openssl" \
  "/usr/local/opt/openssl@3/bin/openssl" \
  "$(command -v openssl 2>/dev/null)"; do
  [ -x "$candidate" ] || continue
  if "$candidate" version 2>/dev/null | grep -qi '^OpenSSL'; then
    OPENSSL_BIN="$candidate"
    break
  fi
done
if [ -z "$OPENSSL_BIN" ]; then
  echo "ERROR: no OpenSSL (non-LibreSSL) found. macOS /usr/bin/openssl is LibreSSL and cannot read Ed25519 keys." >&2
  echo "       Install with: brew install openssl@3" >&2
  exit 1
fi

echo "==> Cleaning build directory"
npm run clean

echo "==> Building TypeScript"
npm run build

# Rollback guard. Everything from the version bump up to (and including)
# `npm publish` is reversible, so if the deploy dies in that window — a registry
# outage during validate, an npm hiccup — we put package.json and server.json
# back byte-for-byte instead of leaving an orphaned bump behind. Without this a
# flaky network burns a version number on every attempt.
#
# Restores from a temp copy rather than `git checkout`, which would also destroy
# any unrelated uncommitted edits to these two files.
#
# Invariant: a deploy that fails before npm publish leaves the working tree
# exactly as it found it. Once npm publish lands the version is permanent, so
# the guard is disarmed there — from that point on, recover by hand (see
# "Recovery from half-published state" in CLAUDE.md).
ROLLBACK_DIR=""
OLD_VERSION="v$(node -e "process.stdout.write(require('./package.json').version)")"

restore_version_files() {
  [ -n "$ROLLBACK_DIR" ] && [ -d "$ROLLBACK_DIR" ] || return 0
  cp "$ROLLBACK_DIR/package.json" package.json
  cp "$ROLLBACK_DIR/server.json" server.json
  rm -rf "$ROLLBACK_DIR"
  ROLLBACK_DIR=""
  echo "" >&2
  echo "==> Deploy failed before npm publish — version bump rolled back." >&2
  echo "    package.json + server.json restored to $OLD_VERSION." >&2
  echo "    Nothing was published. Safe to re-run ./deploy.sh." >&2
}

disarm_rollback() {
  [ -n "$ROLLBACK_DIR" ] || return 0
  rm -rf "$ROLLBACK_DIR"
  ROLLBACK_DIR=""
}

trap restore_version_files EXIT

ROLLBACK_DIR="$(mktemp -d)"
cp package.json "$ROLLBACK_DIR/package.json"
cp server.json "$ROLLBACK_DIR/server.json"

if [ "$ARG" = "--no-bump" ]; then
  NEW_VERSION="v$(node -e "process.stdout.write(require('./package.json').version)")"
  echo "==> Using existing version $NEW_VERSION (--no-bump)"
else
  echo "==> Bumping version ($ARG)"
  NEW_VERSION=$(npm version "$ARG" --no-git-tag-version)
  echo "    New version: $NEW_VERSION"
fi

# Keep server.json version in sync. Runs unconditionally so an existing drift
# (e.g. someone bumped package.json by hand and forgot server.json) is healed
# before we publish to the registry, which would reject a mismatch.
node -e "
const fs = require('fs');
const sj = JSON.parse(fs.readFileSync('server.json', 'utf8'));
const pj = JSON.parse(fs.readFileSync('package.json', 'utf8'));
sj.version = pj.version;
sj.packages.forEach(p => p.version = pj.version);
fs.writeFileSync('server.json', JSON.stringify(sj, null, 2) + '\n');
"
echo "    server.json synced to $NEW_VERSION"

echo "==> Validating server.json against MCP Registry schema"
mcp-publisher validate

echo "==> Publishing to npm"
npm publish --access public

# Point of no return: npm now owns this version number and `npm publish` would
# reject a re-publish, so the bump must stand even if the registry steps below
# fail. Disarm the rollback guard.
disarm_rollback

echo "==> Authenticating with MCP Registry (DNS, $DOMAIN)"
PRIVATE_KEY_HEX=$("$OPENSSL_BIN" pkey -in "$KEY_FILE" -outform DER | tail -c 32 | xxd -p -c 64)
mcp-publisher login dns --domain "$DOMAIN" --private-key "$PRIVATE_KEY_HEX" --algorithm ed25519

echo "==> Publishing to MCP Registry"
mcp-publisher publish

# Record the release in git now that both publishes have succeeded. Commit the
# version-bump files and tag the release. Idempotent under `set -e`: skips the
# commit when nothing is staged (e.g. --no-bump where the version was already
# committed) and skips the tag when it already exists. NOT pushed — pushing is a
# deliberate, separate step (push-only-when-asked).
echo "==> Recording release in git ($NEW_VERSION)"
git add package.json server.json
if git diff --cached --quiet; then
  echo "    Version files already committed — nothing to commit"
else
  git commit -m "chore: release $NEW_VERSION"
  echo "    Committed: chore: release $NEW_VERSION"
fi
if git rev-parse -q --verify "refs/tags/$NEW_VERSION" >/dev/null; then
  echo "    Tag $NEW_VERSION already exists — skipping"
else
  git tag -a "$NEW_VERSION" -m "Release $NEW_VERSION"
  echo "    Tagged $NEW_VERSION"
fi
echo "    Not pushed. When ready: git push && git push origin $NEW_VERSION"

echo "==> Done! Published @kawacode/mcp@$NEW_VERSION to npm + MCP Registry"

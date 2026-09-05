#!/bin/bash
# Run on a fresh, native-architecture macOS runner without signing credentials.
set -euo pipefail
binary="${1:?Usage: bash scripts/verify-macos-release.sh <binary>}"

# Artifact transport does not preserve executable permissions or quarantine.
chmod +x "$binary"
xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");linearctl-release-test;" "$binary"
spctl --status | grep -qx 'assessments enabled'
codesign --verify --strict --verbose=4 "$binary"
# Apple's prescribed check for non-app code (spctl --type execute is for apps).
codesign --verify --strict --verbose=4 --check-notarization \
  -R='anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and notarized' \
  "$binary"

# Keep quarantine intact. Use a clean HOME and system-only PATH to ensure the
# compiled binary does not depend on Bun, repository files, or user config.
work_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/linearctl-verify.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 1' HUP INT TERM
binary="$(cd "$(dirname "$binary")" && pwd)/$(basename "$binary")"
cd "$work_dir"
env -i HOME="$work_dir" TMPDIR="$work_dir" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$binary" --version
env -i HOME="$work_dir" TMPDIR="$work_dir" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$binary" --help

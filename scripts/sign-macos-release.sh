#!/bin/bash
# Release-only: no unsigned/ad-hoc fallback. See docs/macos-signing.md.
set -euo pipefail
umask 077

binary="${1:?Usage: bash scripts/sign-macos-release.sh <binary>}"
script_dir="$(cd "$(dirname "$0")" && pwd)"

for name in MACOS_CERTIFICATE_BASE64 MACOS_CERTIFICATE_PASSWORD MACOS_SIGN_IDENTITY APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "Error: required release secret $name is missing" >&2
    exit 1
  fi
done
if [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] ||
   [[ "$MACOS_SIGN_IDENTITY" != "Developer ID Application: "*" ($APPLE_TEAM_ID)" ]]; then
  echo "Error: MACOS_SIGN_IDENTITY must be a Developer ID Application identity for APPLE_TEAM_ID" >&2
  exit 1
fi
[[ -f "$binary" ]]

work_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/linearctl-sign.XXXXXX")"
keychain="$work_dir/signing.keychain-db"
cleanup() {
  local result=$? cleanup_result=0
  if [[ -f "$keychain" ]]; then
    security delete-keychain "$keychain" || cleanup_result=$?
  fi
  rm -rf "$work_dir" || cleanup_result=$?
  if [[ "$result" -ne 0 ]]; then
    exit "$result"
  fi
  exit "$cleanup_result"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

keychain_password="$(openssl rand -base64 32)"
if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
  echo "::add-mask::$keychain_password"
fi
printf '%s' "$MACOS_CERTIFICATE_BASE64" | base64 --decode > "$work_dir/certificate.p12"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work_dir/certificate.p12" -P "$MACOS_CERTIFICATE_PASSWORD" \
  -k "$keychain" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain"
rm "$work_dir/certificate.p12"

# Match the exact identity, then sign by fingerprint. Do not alter the user's
# default keychain or search list; codesign uses this temporary keychain only.
identities="$(security find-identity -v -p codesigning "$keychain")"
fingerprint="$(printf '%s\n' "$identities" | awk -F '"' -v identity="$MACOS_SIGN_IDENTITY" \
  '$2 == identity { split($1, fields, " "); print fields[2] }')"
if [[ ! "$fingerprint" =~ ^[[:xdigit:]]{40}$ ]]; then
  echo "Error: expected exactly one valid matching Developer ID Application identity" >&2
  exit 1
fi

# Bun can leave a malformed signature; remove it before applying a fresh one.
codesign --remove-signature "$binary"
codesign --force --sign "$fingerprint" --keychain "$keychain" \
  --identifier com.github.qwrobins.linearctl --options runtime --timestamp \
  --entitlements "$script_dir/macos-entitlements.plist" "$binary"
codesign --verify --strict --verbose=4 \
  -R="anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$APPLE_TEAM_ID\"" \
  "$binary"

# Apple accepts ZIP submissions, not naked Mach-O files. Notarization records
# the binary's code hash; publish those exact signed bytes, not this ZIP.
ditto -c -k --keepParent "$binary" "$work_dir/notarization.zip"
notary_result=0
xcrun notarytool submit "$work_dir/notarization.zip" \
  --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" \
  --wait --timeout 20m --output-format json > "$work_dir/notarization.json" || notary_result=$?
# Print the submission ID/status for diagnostics and require Accepted explicitly:
# notarytool's process exit code alone is not a notarization verdict.
python3 - "$work_dir/notarization.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as result_file:
    result = json.load(result_file)
print(json.dumps(result, indent=2))
if result.get("status") != "Accepted":
    sys.exit("Error: notarization was not Accepted; inspect the submission with notarytool log")
PY
if [[ "$notary_result" -ne 0 ]]; then
  exit "$notary_result"
fi

# Raw executables cannot be stapled. Require an online ticket lookup instead.
codesign --verify --strict --verbose=4 -R=notarized --check-notarization "$binary"
"$binary" --version
"$binary" --help

# macOS signing and notarization

## Supported release strategy

Both `linearctl-darwin-x64` and `linearctl-darwin-arm64` are standalone Mach-O
executables signed with a **Developer ID Application** certificate, hardened
runtime, and a secure timestamp. Each signed executable is submitted to Apple's
notary service in a temporary ZIP; only an explicit `Accepted` result permits the
build to proceed. The release publishes the exact signed binary submitted in that
ZIP, retaining the existing asset names and installer format.

**This is an online-notarization strategy, not a stapled distribution.** Neither
raw Mach-O executables nor ZIP archives support stapling a notarization ticket.
Gatekeeper must retrieve the ticket from Apple, so **the first launch requires
Internet access to Apple's services**. Offline first launch is not supported. A
future offline distribution would need a stapled container such as a signed DMG
or installer package; running `stapler` against these raw assets is not valid.
See Apple's [Testing a Notarised Product](https://developer.apple.com/forums/thread/130560).

There is no unsigned or ad-hoc fallback for public macOS releases. Missing secrets,
invalid identities, signing errors, rejected/pending/timed-out notarization,
verification failures, and execution failures all block publication of the entire
release. This policy applies to releases built with this workflow, not older assets.

The installer verifies release checksums and does **not** remove quarantine. Do
not re-sign downloaded releases or clear quarantine to work around a failed
Gatekeeper check: that would bypass the supported trust path. Check network
access, use a current release, and report a persistent failure instead.

## GitHub Actions secrets

Configure these repository (or accessible organization) Actions secrets before
triggering a release:

| Secret | Required value |
| --- | --- |
| `MACOS_CERTIFICATE_BASE64` | Base64-encoded password-protected `.p12` export containing the Developer ID Application certificate **and private key** |
| `MACOS_CERTIFICATE_PASSWORD` | Non-empty password for that `.p12` export |
| `MACOS_SIGN_IDENTITY` | Exact `Developer ID Application: Your Name (TEAMID)` identity name; required, not auto-selected |
| `APPLE_ID` | Apple ID email with access to the developer team |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization, not the Apple ID login password |
| `APPLE_TEAM_ID` | Ten-character Apple Developer Team ID matching the certificate |

Export the identity from Keychain Access on a trusted Mac, then copy its encoding:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
security find-identity -v -p codesigning
```

Keep the `.p12`, passwords, and private key out of the repository and logs. Only
the macOS signing step receives secrets. `scripts/sign-macos-release.sh` imports
the certificate into a temporary password-protected keychain, restricts key access
to codesign, and resolves the exact valid identity to its fingerprint. It does not
change the default keychain or search list. An exit trap deletes the keychain and
temporary files on success, failure, and catchable signals; GitHub-hosted ephemeral
runners also bound credential lifetime if the process is forcibly terminated.

The signing script removes Bun's existing signature before signing. Hardened
runtime entitlements in `scripts/macos-entitlements.plist` allow JIT and unsigned
executable memory for Bun's JavaScriptCore engine. No debugger, DYLD environment,
or library-validation exemptions are enabled. See the
[Bun signing guide](https://bun.com/guides/runtime/codesign-macos-executable) for
background; this CLI does not need its broader native-library permissions.

## Release verification

For **each** architecture, CI:

1. Builds on a native macOS runner (Intel on `macos-15-intel`, arm64 on
   `macos-latest`).
2. Repairs/signs, runs `codesign --verify --strict --verbose=4` with an Apple
   Developer ID and expected-team requirement, and submits to notarization with
   a bounded wait. The JSON submission ID/status is printed for diagnostics;
   maintainers can retrieve Apple's failure report with `xcrun notarytool log`
   using that submission ID and their notarization credentials.
3. Requires `Accepted`, verifies the online notarization ticket, and runs
   `--version` and `--help` before uploading the build artifact.
4. Downloads the artifact on a **fresh native macOS runner**, without signing
   credentials or the build machine's ticket cache. Restores executable mode,
   sets `com.apple.quarantine`, and requires Gatekeeper to be enabled.
5. Runs strict signature verification and `codesign --check-notarization` with a
   `notarized` requirement. This is Apple's prescribed assessment for non-app
   code; `spctl --assess --type execute` and `syspolicy_check distribution` target
   app bundles, not standalone command-line tools.
6. Runs the quarantined binary's `--version` and `--help` with an empty environment
   except a fresh HOME/TMPDIR and system-only PATH, outside the checkout. It does
   not remove quarantine, disable Gatekeeper, or re-sign the downloaded artifact.

Only after both clean-runner jobs succeed can the release job calculate checksums
and publish assets. These automated checks exercise online ticket retrieval and
native execution; they are not an offline or interactive Finder-install test.
The shell regression tests mock Apple tools and test failure handling; actual
Apple signing and Gatekeeper integration requires the macOS release jobs.

## Local builds and signature repair

`bun run build:binary` does not import a Developer ID identity or notarize. Bun may
supply an ad-hoc signature, but some Bun/macOS combinations leave it invalid,
causing an immediate kill (often exit 137). After building **your own trusted
source** on macOS, check it before copying it into your PATH:

```bash
bun run build:binary
codesign --verify --strict --verbose=4 dist/linearctl
./dist/linearctl --version
```

If verification fails or the locally compiled binary is killed, repair its
signature on that Mac:

```bash
codesign --remove-signature dist/linearctl
codesign --force --sign - dist/linearctl
codesign --verify --strict --verbose=4 dist/linearctl
./dist/linearctl --version
./dist/linearctl --help
```

Repeat after rebuilding if needed. This ad-hoc repair enables local development;
it does **not** establish a Developer ID or notarization trust chain and is not a
supported fix for quarantined downloads or a distribution signing strategy.

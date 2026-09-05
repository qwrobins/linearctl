# Build and release validation

## Toolchain

`.bun-version` is the single Bun version pin used by CI and release builds. Install
that exact version for local builds. To update Bun, change `.bun-version` in a PR,
run `bun install` with the new version and commit any intentional lockfile changes,
then require the full CI checks and all five release-target build/smoke tests to
pass before publishing with it. Do not replace the pin with `latest`.

## Shared build entry point

Both CI and release use `scripts/build.ts` through package scripts:

```sh
bun install --frozen-lockfile
bun run check:generated # Run on a clean checkout, BEFORE building
bun run typecheck
bun run test
bun run build          # TypeScript output and manifest assets
bun run build:binary   # Native standalone executable
bun run smoke:binary   # Tests dist/linearctl (dist/linearctl.exe on Windows)
```

Release builds use the same binary entry point with explicit arguments:

```sh
bun run build:binary --target=bun-linux-arm64 --outfile=dist/linearctl-linux-arm64
bun run smoke:binary dist/linearctl-linux-arm64 # Run on a matching host
```

Supported targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`,
`bun-darwin-arm64`, and `bun-windows-x64`. Every build runs `bun run generate`
first. This updates embedded skills, the curated command manifest, and the README
command table from their committed sources. CI regenerates these **before** any
build and fails if Git reports modified, staged, deleted, or untracked files.
To fix drift, run `bun run generate` and commit the resulting changes. LF checkout
rules in `.gitattributes` keep generated skill bytes identical across platforms.

The API manifest and schema metadata are snapshots, not reproducible offline
outputs: their introspection input (`schema.json`) is intentionally not committed,
and metadata includes a retrieval timestamp. They remain committed release inputs;
normal builds never fetch the live Linear API. Update them intentionally via the
[schema regeneration workflow](schema-and-generated.md), review, and commit them.
The curated manifest, unlike the API snapshot, is reproducible from the registry
and is checked by `check:generated`.

## Publication gate

Tag pushes and manual dispatches both enter the same release pipeline:

1. Validate the version-tag syntax and resolve an **existing tag** to a commit SHA;
   check its `package.json` version. Branch names are not accepted as release inputs.
2. Call the reusable CI workflow on that exact SHA (Linux and Windows checks,
   including generation drift, types, tests, both build modes, installer checks,
   and binary smoke tests). A green CI run on a different commit is not sufficient.
3. Only after validation succeeds, build all five targets from that immutable SHA
   with the pinned Bun version, checking generation drift on each build host too.
4. Smoke-test every binary on a matching native runner: `--help`, exact `--version`,
   and project-scoped skill installation in an isolated temporary directory.
   Installed skill names and bytes must match `skills/*/SKILL.md` from the release
   commit. The Windows ZIP is also extracted, checked for a single root-level
   `linearctl.exe`, and the extracted executable receives the same smoke tests.
5. Preserve raw Unix binaries, Windows ZIP, Debian packages, and SHA-256 checksums.
   Before creating a release or replacing existing assets, verify the tag still
   points to the validated commit. A failed/cancelled validation or build blocks
   publication. Only the publication job receives `contents: write`.

Auto-tag may dispatch release before the independent push CI run finishes. This
is safe because release always runs its own blocking validation of the tag's SHA;
manual dispatch has no bypass. To retry, dispatch `release.yml` with the existing
version tag; validation runs again before assets can be uploaded or overwritten.

macOS binaries are Developer ID signed and notarized after compilation and before
final smoke tests/upload. Both architectures then pass quarantined execution and
online notarization checks on fresh native runners before publication. Checksums
cover the final signed assets. See [macOS signing](macos-signing.md) for required
secrets, the online-first-launch policy, and local signature repair.

## npm publication

The Node.js distribution is published as `@qwrobinson/linearctl` by
`.github/workflows/publish-npm.yml` for a matching `vX.Y.Z` release tag. The
auto-tag workflow explicitly dispatches this workflow on the new tag because a
tag pushed with `GITHUB_TOKEN` does not recursively trigger another workflow.
The workflow builds the TypeScript distribution with the pinned Bun version, then
publishes the compiled JavaScript and manifest assets through npm Trusted
Publishing. It does not require an npm token secret. To retry a publication,
dispatch `publish-npm.yml` with the existing tag as its `tag` input.

Before the first release, publish the initial version once from a logged-in local
environment so the npm package exists, then configure the package's Trusted
Publisher as GitHub Actions for user `qwrobins`, repository `linearctl`, and
workflow filename `publish-npm.yml`. Allow the `npm publish` action. Future
versions are published automatically from matching release tags.

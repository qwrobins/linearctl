import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const identity = "Developer ID Application: Test Developer (ABCDEFGHIJ)";
const fingerprint = "A".repeat(40);

// Exercise shell control flow without Apple credentials or a macOS host. Real
// codesign/notarization/Gatekeeper integration runs in the release matrix.
describe.skipIf(process.platform === "win32")("macOS release scripts", () => {
  let dir: string;
  let binary: string;
  let logPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "linearctl-sign-test-"));
    const bin = join(dir, "mock-bin");
    mkdirSync(bin);
    logPath = join(dir, "commands.log");
    writeFileSync(logPath, "");
    binary = join(dir, "linearctl with spaces");
    writeFileSync(binary, `#!/bin/bash\nprintf 'binary %s\\n' "$*" >> '${logPath}'\n`, { mode: 0o755 });

    const mock = `#!/bin/bash
set -eu
tool="$(basename "$0")"
printf '%s %s\\n' "$tool" "$*" >> "$MOCK_LOG"
case "$tool" in
  security)
    case "$1" in
      create-keychain) touch "\${!#}" ;;
      import) [[ "\${MOCK_FAIL:-}" != import ]] ;;
      find-identity) printf '  1) %s "%s"\\n' '${fingerprint}' "$MOCK_IDENTITY" ;;
      delete-keychain) rm -f "$2" ;;
    esac ;;
  codesign)
    case "$*" in
      *--remove-signature*) [[ "\${MOCK_FAIL:-}" != remove ]] ;;
      *--force*) [[ "\${MOCK_FAIL:-}" != sign ]] ;;
      *--check-notarization*) [[ "\${MOCK_FAIL:-}" != ticket ]] ;;
      *--verify*) [[ "\${MOCK_FAIL:-}" != verify ]] ;;
    esac ;;
  ditto) touch "\${!#}" ;;
  xcrun)
    printf '%s' "\${MOCK_NOTARY_RESPONSE}"
    [[ "\${MOCK_FAIL:-}" != notary ]] ;;
  spctl) printf '%s\\n' "\${MOCK_GATEKEEPER:-assessments enabled}" ;;
  xattr) [[ "\${MOCK_FAIL:-}" != quarantine ]] ;;
esac
`;
    for (const name of ["security", "codesign", "ditto", "xcrun", "spctl", "xattr"]) {
      writeFileSync(join(bin, name), mock, { mode: 0o755 });
    }
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      GITHUB_ACTIONS: "false",
      MOCK_LOG: logPath,
      MOCK_IDENTITY: identity,
      MOCK_NOTARY_RESPONSE: JSON.stringify({ id: "submission-id", status: "Accepted" }),
      MACOS_CERTIFICATE_BASE64: Buffer.from("test certificate").toString("base64"),
      MACOS_CERTIFICATE_PASSWORD: "test-only",
      MACOS_SIGN_IDENTITY: identity,
      APPLE_ID: "test@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "test-only",
      APPLE_TEAM_ID: "ABCDEFGHIJ",
    };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(script = "sign-macos-release.sh") {
    return spawnSync("bash", [join(root, "scripts", script), binary], { env, encoding: "utf8" });
  }
  function log() {
    return readFileSync(logPath, "utf8");
  }
  function expectCleanedUp() {
    expect(readdirSync(dir).filter((name) => name.startsWith("linearctl-sign."))).toEqual([]);
    expect(log()).toContain("security delete-keychain");
  }

  it("repairs, signs, verifies, notarizes and smoke-tests in order, then removes credentials", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const commands = log();
    const stages = [
      "security import", "codesign --remove-signature", "codesign --force",
      "codesign --verify --strict --verbose=4", "ditto -c -k --keepParent",
      "xcrun notarytool submit", "-R=notarized --check-notarization",
      "binary --version", "binary --help", "security delete-keychain",
    ];
    let previous = -1;
    for (const stage of stages) {
      const index = commands.indexOf(stage);
      expect(index, stage).toBeGreaterThan(previous);
      previous = index;
    }
    expect(commands).toContain(`--sign ${fingerprint} --keychain`);
    expect(commands).toContain("--options runtime --timestamp --entitlements");
    expect(commands).toContain('certificate leaf[subject.OU] = "ABCDEFGHIJ"');
    expect(commands).not.toContain("security list-keychains");
    expectCleanedUp();
  });

  it.each([
    "MACOS_CERTIFICATE_BASE64", "MACOS_CERTIFICATE_PASSWORD", "MACOS_SIGN_IDENTITY",
    "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID",
  ])("fails before importing when %s is absent", (name) => {
    env[name] = "";
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(log()).toBe("");
  });

  it.each(["-", "Apple Development: Test Developer (ABCDEFGHIJ)", "Developer ID Application: Other (0123456789)"])(
    "rejects an invalid release identity: %s", (invalidIdentity) => {
      env.MACOS_SIGN_IDENTITY = invalidIdentity;
      expect(run().status).not.toBe(0);
      expect(log()).toBe("");
    },
  );

  it("rejects a missing identity in the imported keychain", () => {
    env.MOCK_IDENTITY = "Developer ID Application: Someone Else (ABCDEFGHIJ)";
    expect(run().status).not.toBe(0);
    expect(log()).not.toContain("\ncodesign ");
    expectCleanedUp();
  });

  it.each(["import", "remove", "sign", "verify", "notary", "ticket"])(
    "fails closed and cleans up after a %s failure", (stage) => {
      env.MOCK_FAIL = stage;
      expect(run().status).not.toBe(0);
      expect(log()).not.toContain("binary --");
      if (["import", "remove", "sign", "verify"].includes(stage)) {
        expect(log()).not.toContain("xcrun notarytool");
      }
      expectCleanedUp();
    },
  );

  it.each(["Invalid", "In Progress", "Rejected", undefined])("rejects notarization status %s even with exit zero", (status) => {
    env.MOCK_NOTARY_RESPONSE = JSON.stringify({ id: "submission-id", status });
    expect(run().status).not.toBe(0);
    expect(log()).not.toContain("--check-notarization");
    expect(log()).not.toContain("binary --");
    expectCleanedUp();
  });

  it("fails closed for malformed notarization output", () => {
    env.MOCK_NOTARY_RESPONSE = "not json";
    expect(run().status).not.toBe(0);
    expect(log()).not.toContain("binary --");
    expectCleanedUp();
  });

  it("checks quarantine, strict signature and online notarization before clean execution", () => {
    const result = run("verify-macos-release.sh");
    expect(result.status, result.stderr).toBe(0);
    const commands = log();
    expect(commands).toContain("xattr -w com.apple.quarantine 0083;");
    expect(commands).toContain("codesign --verify --strict --verbose=4");
    expect(commands).toContain("--check-notarization");
    expect(commands).toContain("exists and notarized");
    expect(commands.indexOf("--check-notarization")).toBeLessThan(commands.indexOf("binary --version"));
    expect(commands).toContain("binary --help");
    expect(commands).not.toContain("security ");
    expect(commands).not.toContain("xattr -d");
    expect(readdirSync(dir).filter((name) => name.startsWith("linearctl-verify."))).toEqual([]);
  });

  it("executes without build-machine environment or configuration", () => {
    writeFileSync(binary, `#!/bin/bash
set -eu
[[ "$PATH" == /usr/bin:/bin:/usr/sbin:/sbin ]]
[[ "$HOME" == "$TMPDIR" && "$PWD" == "$HOME" ]]
[[ -z "\${APPLE_ID:-}" && -z "\${MACOS_CERTIFICATE_BASE64:-}" ]]
`);
    const result = run("verify-macos-release.sh");
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["sign-macos-release.sh", "verify-macos-release.sh"])("propagates execution failure in %s", (script) => {
    writeFileSync(binary, "#!/bin/bash\nexit 137\n");
    expect(run(script).status).toBe(137);
    if (script === "sign-macos-release.sh") expectCleanedUp();
  });

  it.each(["quarantine", "verify", "ticket"])("does not execute after clean-runner %s failure", (stage) => {
    env.MOCK_FAIL = stage;
    expect(run("verify-macos-release.sh").status).not.toBe(0);
    expect(log()).not.toContain("binary --");
  });

  it("rejects a runner with Gatekeeper disabled", () => {
    env.MOCK_GATEKEEPER = "assessments disabled";
    expect(run("verify-macos-release.sh").status).not.toBe(0);
    expect(log()).not.toContain("binary --");
  });
});

it("gates publication on clean macOS verification and preserves quarantine in the installer", () => {
  const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  expect(workflow).toContain("needs: [build, verify-macos]");
  expect(workflow.indexOf("bash scripts/sign-macos-release.sh")).toBeLessThan(workflow.indexOf("actions/upload-artifact"));
  const verification = workflow.split("  verify-macos:")[1]?.split("  release:")[0] ?? "";
  expect(verification).toContain("needs: build");
  expect(verification).toContain("macos-15-intel");
  expect(verification).toContain("linearctl-darwin-x64");
  expect(verification).toContain("linearctl-darwin-arm64");
  expect(verification).toContain("actions/download-artifact");
  expect(verification).toContain("bash scripts/verify-macos-release.sh");
  expect(verification).not.toContain("secrets.");
  expect(readFileSync(join(root, "install.sh"), "utf8")).not.toContain("xattr -d");
});
